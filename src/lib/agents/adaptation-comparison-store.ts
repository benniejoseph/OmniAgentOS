import "server-only";
import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  AgentAdaptationConflictError, AgentAdaptationUnavailableError, listAgentAdaptations,
  lockAdaptationIdentity, readAdaptationForUpdate, readActiveAdaptationGuidanceWithSql,
  type AgentAdaptationOwner,
} from "@/lib/agents/adaptation-store";
import {
  adaptationComparisonSuiteSchema, buildAdaptationComparison, parseAdaptationComparison,
  type AdaptationComparison, type AdaptationComparisonSuite,
} from "@/lib/agents/adaptation-comparison-contracts";
import {
  adaptationBaselineSha256, compileAdaptationComparison, notRunAdaptationObservation,
  resolveAdaptationComparisonRuntime, runAdaptationComparison,
} from "@/lib/agents/adaptation-comparison";

type Sql = ReturnType<typeof getSql>;
/** An idempotency reservation precedes every provider call. A crashed reservation expires
 * to incomplete, never to permission to repeat a potentially billed request. */
export async function compareAgentAdaptation(input: {
  owner: AgentAdaptationOwner; agentId: string; adaptationId: string;
  suite: AdaptationComparisonSuite; idempotencyKey: string; abortSignal?: AbortSignal;
}) {
  if (!hasDatabaseUrl()) throw new AgentAdaptationUnavailableError();
  await ensureDatabaseSchema();
  const suite = adaptationComparisonSuiteSchema.parse(input.suite);
  const requestSha256 = sourceContractSha256({ agentId: input.agentId, adaptationId: input.adaptationId, suite });
  const key = sourceContractSha256(input.idempotencyKey);
  const previous = await getSql()`SELECT * FROM omni_agent_adaptation_comparisons WHERE tenant_id = ${input.owner.tenantId} AND owner_actor_id = ${input.owner.canonicalActorId} AND idempotency_key_sha256 = ${key}`;
  if (previous[0]) {
    if (previous[0].request_sha256 !== requestSha256) throw new AgentAdaptationConflictError("This request key already belongs to a different comparison.");
    if (!previous[0].result) {
      if (Date.now() - Date.parse(String(previous[0].started_at)) < 150_000) throw new AgentAdaptationConflictError("Comparison is still running or its result is uncertain. Refresh status before starting another comparison.");
      const prepared = previous[0].prepared as ReturnType<typeof compileAdaptationComparison>;
      const incomplete = buildAdaptationComparison({ comparisonId: String(previous[0].comparison_id), adaptationId: input.adaptationId, suite: prepared.suite, pins: prepared.pins,
        observations: prepared.suite.cases.map((row) => ({ caseId: row.id, baseline: notRunAdaptationObservation(), candidate: notRunAdaptationObservation() })), completedAt: new Date().toISOString() });
      await finishComparison(input, key, incomplete);
    }
    return listAgentAdaptations(input.agentId, input.owner);
  }
  const identity = await resolveAgentIdentityForExecution({ tenantId: input.owner.tenantId, actorId: input.owner.actorId, agentId: input.agentId });
  const model = await resolveAdaptationComparisonRuntime({ owner: input.owner, identity, suite });
  const comparisonId = randomUUID();
  const compiled = await getSql().transaction(async (sql: Sql) => {
    const currentIdentity = await lockAdaptationIdentity(sql, input.agentId, input.owner);
    if (currentIdentity.definition.definitionSha256 !== identity.definition.definitionSha256 || currentIdentity.principal.principalSha256 !== identity.principal.principalSha256) throw new AgentAdaptationConflictError();
    const adaptation = await readAdaptationForUpdate(sql, input.agentId, input.adaptationId, input.owner);
    const active = await readActiveAdaptationGuidanceWithSql(sql, input.agentId, identity.definition.definitionVersion, input.owner);
    let prepared: ReturnType<typeof compileAdaptationComparison>;
    try { prepared = compileAdaptationComparison({ identity, adaptation, active, suite, runtimePin: model.pin, clock: new Date().toISOString() }); }
    catch (error) { throw new AgentAdaptationConflictError(error instanceof Error ? error.message : undefined); }
    const pending = await sql`SELECT comparison_id FROM omni_agent_adaptation_comparisons WHERE tenant_id = ${input.owner.tenantId} AND owner_actor_id = ${input.owner.canonicalActorId} AND adaptation_id = ${input.adaptationId} AND result IS NULL AND started_at > clock_timestamp() - INTERVAL '150 seconds' LIMIT 1`;
    if (pending.length) throw new AgentAdaptationConflictError("A comparison is already running. Refresh its status before starting another.");
    const rows = await sql`INSERT INTO omni_agent_adaptation_comparisons (tenant_id, owner_actor_id, comparison_id, adaptation_id, idempotency_key_sha256, request_sha256, prepared, started_at) VALUES (${input.owner.tenantId}, ${input.owner.canonicalActorId}, ${comparisonId}, ${input.adaptationId}, ${key}, ${requestSha256}, ${prepared}::jsonb, ${prepared.pins.clock}) ON CONFLICT (tenant_id, owner_actor_id, idempotency_key_sha256) DO NOTHING RETURNING comparison_id`;
    if (!rows.length) throw new AgentAdaptationConflictError("This comparison request was already accepted. Refresh its status; no model calls were repeated.");
    return prepared;
  }) as ReturnType<typeof compileAdaptationComparison>;
  // Never hold a database lock or transaction during generation.
  const result = await runAdaptationComparison({ comparisonId, owner: input.owner,
    adaptationId: input.adaptationId, compiled, runtime: model.runtime, abortSignal: input.abortSignal });
  let runtimeCurrent = false;
  try {
    const currentModel = await resolveAdaptationComparisonRuntime({ owner: input.owner, identity, suite });
    runtimeCurrent = sourceContractSha256(currentModel.pin) === sourceContractSha256(model.pin);
  } catch { /* Unavailable current configuration is never positive evidence. */ }
  await finishComparison(input, key, result, runtimeCurrent);
  return listAgentAdaptations(input.agentId, input.owner);
}

async function finishComparison(input: Pick<Parameters<typeof compareAgentAdaptation>[0], "owner" | "agentId" | "adaptationId">, key: string, result: AdaptationComparison, runtimeCurrent = false) {
  await getSql().transaction(async (sql: Sql) => {
    let identity: Awaited<ReturnType<typeof lockAdaptationIdentity>> | undefined;
    try { identity = await lockAdaptationIdentity(sql, input.agentId, input.owner); } catch { /* A retired definition makes attempted results incomplete. */ }
    const adaptation = await readAdaptationForUpdate(sql, input.agentId, input.adaptationId, input.owner);
    const active = await readActiveAdaptationGuidanceWithSql(sql, input.agentId, identity?.definition.definitionVersion || result.pins.definitionVersion, input.owner);
    const configurationCurrent = runtimeCurrent && identity && adaptation.state === "evaluated" &&
      identity.definition.definitionSha256 === result.pins.definitionSha256 &&
      identity.principal.principalSha256 === result.pins.principalSha256 &&
      adaptation.effect.effectSha256 === result.pins.candidateEffectSha256 &&
      adaptationBaselineSha256(active) === result.pins.baselineGuidanceSha256;
    const final = configurationCurrent || result.verdict === "incomplete" ? result : buildAdaptationComparison({ ...result,
      observations: result.results.map((row, i) => i ? row : { ...row, candidate: { status: "failed", output: null, costUsd: null, failure: "stale_configuration" } }),
    });
    const verified = parseAdaptationComparison(final);
    const rows = await sql`UPDATE omni_agent_adaptation_comparisons SET result = ${verified}::jsonb WHERE tenant_id = ${input.owner.tenantId} AND owner_actor_id = ${input.owner.canonicalActorId} AND idempotency_key_sha256 = ${key} AND comparison_id = ${verified.comparisonId} AND result IS NULL RETURNING comparison_id`;
    if (!rows.length) return;
    // Do not let a late completion overwrite a newer result or change active history.
    if (adaptation.state === "evaluated" && (!adaptation.comparison || Date.parse(adaptation.comparison.pins.clock) <= Date.parse(verified.pins.clock))) {
      await sql`UPDATE omni_agent_adaptations SET comparison = ${verified}::jsonb WHERE tenant_id = ${input.owner.tenantId} AND owner_actor_id = ${input.owner.canonicalActorId} AND adaptation_id = ${input.adaptationId} AND state = 'evaluated'`;
    }
    await appendScopedDomainEvent({ id: `agent.adaptation.compared:${verified.comparisonId}`, streamId: `agent:${input.agentId}`, type: "agent.adaptation.compared",
      payload: { schemaVersion: 1, adaptationId: input.adaptationId, comparisonId: verified.comparisonId, comparisonSha256: verified.comparisonSha256, suiteSha256: verified.suiteSha256, verdict: verified.verdict, baselinePassed: verified.baselinePassed, candidatePassed: verified.candidatePassed, costKnown: verified.costUsd !== null },
      executionScope: createExecutionScope({ tenantId: input.owner.tenantId, initiatingActorId: input.owner.canonicalActorId, executingPrincipalType: "user", executingPrincipalId: input.owner.canonicalActorId, correlationId: verified.comparisonId, purpose: "agent.adaptation.text_comparison" }),
    }, { sql });
  });
}

export async function expireAgentAdaptationComparisons(agentId: string, owner: AgentAdaptationOwner) {
  const rows = await getSql()`SELECT comparisons.* FROM omni_agent_adaptation_comparisons comparisons JOIN omni_agent_adaptations adaptation ON adaptation.tenant_id = comparisons.tenant_id AND adaptation.adaptation_id = comparisons.adaptation_id WHERE comparisons.tenant_id = ${owner.tenantId} AND comparisons.owner_actor_id = ${owner.canonicalActorId} AND adaptation.agent_definition_id = ${agentId} AND comparisons.result IS NULL AND comparisons.started_at <= clock_timestamp() - INTERVAL '150 seconds' ORDER BY comparisons.started_at LIMIT 10`;
  for (const row of rows) {
    const prepared = row.prepared as ReturnType<typeof compileAdaptationComparison>;
    const result = buildAdaptationComparison({ comparisonId: String(row.comparison_id), adaptationId: String(row.adaptation_id), suite: prepared.suite, pins: prepared.pins, observations: prepared.suite.cases.map((item) => ({ caseId: item.id, baseline: notRunAdaptationObservation(), candidate: notRunAdaptationObservation() })), completedAt: new Date().toISOString() });
    await finishComparison({ owner, agentId, adaptationId: String(row.adaptation_id) }, String(row.idempotency_key_sha256), result);
  }
}
