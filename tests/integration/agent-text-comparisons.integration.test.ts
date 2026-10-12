import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { buildObservedAgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { activateAgentAdaptation, evaluateAgentAdaptation, listAgentAdaptations, rollbackAgentAdaptation, type AgentAdaptationOwner } from "@/lib/agents/adaptation-store";
import { compareAgentAdaptation } from "@/lib/agents/adaptation-comparison-store";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { ModelTextRequest } from "@/lib/models/types";

const model = vi.hoisted(() => ({ generate: vi.fn(), route: "fixture-model", serving: false }));
vi.mock("@/lib/db/client", async (original) => { const actual = await original<typeof import("@/lib/db/client")>(); return { ...actual, ensureDatabaseSchema: () => model.serving ? Promise.resolve() : actual.ensureDatabaseSchema() }; });
vi.mock("@/lib/models/gateway", () => ({ generateModelText: model.generate }));
vi.mock("@/lib/settings/runtime-models", () => ({ resolveRuntimeModelAssignment: async () => ({
  scope: "council", source: "deployment_environment", configured: true, provider: "openai", model: model.route,
  allowCrossProviderFallback: false, warnings: [], reason: "fixture", usageReceipt: {}, bind: (request: unknown) => request,
}) }));
const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const email = "comparison-owner@example.test", otherEmail = "comparison-other@example.test", canonical = `actor:${user}`, roleName = "comparison_test_runtime";
const suite = { cases: [1, 2, 3].map((i) => ({ id: `case-${i}`, task: `Explain independent example ${i}.`, assertions: { allOf: ["Next step:"], noneOf: [], minLength: 1, maxLength: 100 } })) };
const generation = (text: string) => ({ text, provider: "openai", model: model.route, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, totalTokens: 10 }, latencyMs: 1, attempts: [], costKnown: false });

integration("measured Agent comparisons with real persistence and serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: false, onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions,omni_tenant_workspaces,omni_tenant_workspace_memberships TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},${email},'fixture-only'),(${otherUser},${otherEmail},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); model.serving = true; vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); vi.stubEnv("VERCEL", ""); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("comparison-proof", [email, canonical], () => getSql()`SELECT current_user AS role, rolsuper, rolbypassrls, row_security_active('omni_agent_adaptation_comparisons') AS active FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true });
  }, 180_000);
  beforeEach(() => { model.route = "fixture-model"; model.generate.mockReset(); model.generate.mockImplementation(async (request: ModelTextRequest) => generation(request.instructions?.includes("Candidate:") ? "Next step: proceed" : "Old answer")); });
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); } });
  const scoped = <T>(owner: AgentAdaptationOwner, operation: () => Promise<T>) => runWithDatabaseActorScope(owner.tenantId, [owner.actorId, owner.canonicalActorId], operation);
  async function fixture(tag: string) {
    const owner = { tenantId: `comparison-${tag}`, actorId: email, canonicalActorId: canonical };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${owner.tenantId},${tag},${owner.tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${owner.tenantId},${id},'operator')`;
    await scoped(owner, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${owner.tenantId},${email})`);
    return owner;
  }
  async function observed(owner: AgentAdaptationOwner, tag = "one") {
    const identity = buildBuiltInAgentIdentityV1({ tenantId: owner.tenantId, agentId: "scout", controllerActorId: canonical });
    const record = buildObservedAgentAdaptationV1({ tenantId: owner.tenantId, ownerActorId: canonical, agentId: "scout", definitionVersion: identity.definition.definitionVersion, guidance: `Finish with a next step for ${tag}.`, confidence: .95,
      evidence: [{ evidenceId: `feedback:${tag}`, kind: "run_feedback", sourceId: `run:${tag}`, sourceSha256: "a".repeat(64), verdict: "needs_work", groundingStatus: "verified", observedAt: new Date().toISOString() }] });
    await admin`INSERT INTO omni_agent_adaptations(tenant_id,adaptation_id,agent_definition_id,owner_actor_id,owner_binding_sha256,observed_definition_version,state,lifecycle_revision,evidence,evidence_sha256,confidence,effect_kind,effect_payload,created_at,updated_at) VALUES (${owner.tenantId},${record.adaptationId},'scout',${canonical},${record.ownerBindingSha256},${record.observedDefinitionVersion},'observed',0,${admin.json(record.evidence)},${record.evidenceSha256},${record.confidence},${record.effect.kind},${admin.json(record.effect)},${record.createdAt},${record.updatedAt})`;
    await scoped(owner, () => evaluateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner));
    return record;
  }
  function compare(owner: AgentAdaptationOwner, adaptationId: string, key = "compare-one") { return scoped(owner, () => compareAgentAdaptation({ owner, agentId: "scout", adaptationId, suite, idempotencyKey: key })); }

  test("persists real matched outputs exactly once, activates only improvement and permits rollback", async () => {
    const owner = await fixture("lifecycle"), record = await observed(owner);
    await expect(scoped(owner, () => activateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner))).rejects.toThrow(/comparison/);
    const [measured] = await compare(owner, record.adaptationId);
    expect(measured.comparison).toMatchObject({ verdict: "improved", baselinePassed: 0, candidatePassed: 3, costUsd: null }); expect(model.generate).toHaveBeenCalledTimes(6);
    expect((await compare(owner, record.adaptationId))[0].comparison).toEqual(measured.comparison); expect(model.generate).toHaveBeenCalledTimes(6);
    await expect(scoped(owner, () => getSql()`UPDATE omni_agent_adaptation_comparisons SET result = result WHERE tenant_id = ${owner.tenantId}`)).rejects.toMatchObject({ code: "23514" });
    const active = await scoped(owner, () => activateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner)); expect(active[0].state).toBe("active");
    const rolled = await scoped(owner, () => rollbackAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner)); expect(rolled[0].state).toBe("rolled_back");
  });
  test("singleflight reservations prevent overlapping paid calls and wrong-owner reads", async () => {
    const owner = await fixture("singleflight"), record = await observed(owner);
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; }); const hold = new Promise<void>((resolve) => { release = resolve; });
    model.generate.mockImplementationOnce(async () => { started(); await hold; return generation("Old answer"); });
    const first = compare(owner, record.adaptationId); await ready;
    try { await expect(compare(owner, record.adaptationId)).rejects.toThrow(/running|uncertain/); expect(model.generate).toHaveBeenCalledTimes(1); } finally { release(); }
    await first; expect(model.generate).toHaveBeenCalledTimes(6);
    expect(await runWithDatabaseActorScope(owner.tenantId, [otherEmail, `actor:${otherUser}`], () => getSql()`SELECT * FROM omni_agent_adaptation_comparisons WHERE tenant_id=${owner.tenantId}`)).toEqual([]);
    expect(await runWithDatabaseTenantScope(owner.tenantId, () => getSql()`SELECT * FROM omni_agent_adaptation_comparisons WHERE tenant_id=${owner.tenantId}`)).toEqual([]);
  });
  test("ties, failures, changed model and changed active guidance cannot activate", async () => {
    const owner = await fixture("gates"), record = await observed(owner);
    model.generate.mockImplementation(async () => generation("Next step: proceed"));
    expect((await compare(owner, record.adaptationId, "tie"))[0].comparison?.verdict).toBe("no_change");
    await expect(scoped(owner, () => activateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner))).rejects.toThrow(/added passing/);
    model.generate.mockRejectedValue(new Error("fixture provider error"));
    expect((await compare(owner, record.adaptationId, "failure"))[0].comparison?.verdict).toBe("incomplete");
    model.generate.mockImplementation(async (request: ModelTextRequest) => generation(request.instructions?.includes("Candidate:") ? "Next step: proceed" : "Old answer"));
    await compare(owner, record.adaptationId, "improve"); model.route = "changed-model";
    await expect(scoped(owner, () => activateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner))).rejects.toThrow(/changed/); model.route = "fixture-model";
    const second = await observed(owner, "second"); await compare(owner, second.adaptationId, "second");
    await scoped(owner, () => activateAgentAdaptation("scout", record.adaptationId, record.observedDefinitionVersion, owner));
    await expect(scoped(owner, () => activateAgentAdaptation("scout", second.adaptationId, second.observedDefinitionVersion, owner))).rejects.toThrow(/changed/);
  });
  test("interrupted reservations expire to incomplete and retries never rerun models", async () => {
    const owner = await fixture("restart"), record = await observed(owner);
    await compare(owner, record.adaptationId, "prepare");
    const [row] = await admin`SELECT prepared FROM omni_agent_adaptation_comparisons WHERE tenant_id=${owner.tenantId}`;
    const expiredKey = sourceContractSha256("interrupted"), comparisonId = randomUUID();
    const prepared = { ...row.prepared, pins: { ...row.prepared.pins, clock: new Date(Date.now() - 180_000).toISOString() } };
    await admin`INSERT INTO omni_agent_adaptation_comparisons(tenant_id,owner_actor_id,comparison_id,adaptation_id,idempotency_key_sha256,request_sha256,prepared,started_at) VALUES (${owner.tenantId},${canonical},${comparisonId},${record.adaptationId},${expiredKey},${sourceContractSha256({ agentId: "scout", adaptationId: record.adaptationId, suite })},${admin.json(prepared)},${prepared.pins.clock})`;
    const count = model.generate.mock.calls.length;
    await scoped(owner, () => listAgentAdaptations("scout", owner));
    const [expired] = await admin`SELECT result FROM omni_agent_adaptation_comparisons WHERE tenant_id=${owner.tenantId} AND comparison_id=${comparisonId}`;
    expect(expired.result).toMatchObject({ verdict: "incomplete", costUsd: null });
    await compare(owner, record.adaptationId, "interrupted"); expect(model.generate).toHaveBeenCalledTimes(count);
  });
});
