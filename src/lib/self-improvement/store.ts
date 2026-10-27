import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope, parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { governedToolExecutionId } from "@/lib/tools/execution-id";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { selfImprovementRuntimeSchema, selfImprovementExecutionElapsedMs } from "./runtime";
import { assertNativeValidationReceipt, nativeValidationReceiptSchema, nativePairedBaselineSchema, type NativeValidationReceipt } from "./native-contracts";
import { withAvailabilityOwner } from "@/lib/availability-watches/store";
import { selfImprovementApprovalSchema, selfImprovementCycleSchema, selfImprovementDigestSchema, selfImprovementPolicySchema, selfImprovementRepositorySchema, selfImprovementRevisionSchema, selfImprovementSha256, type SelfImprovementApproval, type SelfImprovementCycle, type SelfImprovementPolicy, type SelfImprovementScope, type SelfImprovementStage } from "./contracts";
import { assertCurrentSelfImprovementConfiguration, assertSelfImprovementCycleIntegrity, assertSelfImprovementCycleTransition, canDiscardHeldSelfImprovementCandidate, isSelfImprovementTerminalStage, selfImprovementCycleBudgetUsd } from "./policy";

export type SelfImprovementOwner = Readonly<{ tenantId: string; ownerActorId: string }>;
export type SelfImprovementConfiguration = SelfImprovementOwner & Readonly<{
  id: string; projectId: string; repositoryId: string; repository: SelfImprovementScope["repository"];
  policy: SelfImprovementPolicy; generation: number; nextDueAt: string; paused: boolean;
  timeZone: string; dailyHour: number; createdAt: string; updatedAt: string;
}>;
export type StoredSelfImprovementCycle = Readonly<{
  cycle: SelfImprovementCycle; configurationId: string; configurationGeneration: number;
  projectId: string; repositoryId: string; day: string; leaseExpiresAt: string;
  /** Returned only to the successful lease holder. Never include in a model/UI projection. */
  leaseToken?: string; runtime: Record<string, unknown>; spendUsd: number; usageState: "known" | "unknown";
  unsettledPaidUsage?: boolean;
  controllerId: string | null; controllerHold: { category: string; occurredAt: string } | null;
}>;
export type SelfImprovementCycleClaim = Readonly<{
  outcome: "claimed" | "duplicate" | "busy" | "budget_exhausted" | "paused" | "not_due";
  cycle?: StoredSelfImprovementCycle;
  retryOf?: SelfImprovementSetupRetry;
}>;
export type SelfImprovementSetupRetry = Readonly<{ cycleId: string; revision: number; cycleSha256: string; toolExecutionId: string; toolReceiptSha256: string }>;
const ownerSchema = z.object({ tenantId: z.string().trim().min(1).max(240), ownerActorId: z.string().regex(/^actor:[a-f0-9-]{36}$/) }).strict();
const opaque = z.string().trim().min(1).max(240);
const nowAt = (value?: string) => new Date(z.string().datetime({ offset: true }).parse(value || new Date().toISOString())).toISOString();
const stamp = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
// GitHub numeric repository identity survives renames and owner transfers.
const repoKey = (repositoryId: string) => selfImprovementSha256("repository_lock", { provider: "github", repositoryId });
const tokenHash = (value: string) => selfImprovementSha256("lease_token", opaque.parse(value));
const LEASE_MS = 5 * 60_000;
const configurationSchema = ownerSchema.extend({ id: opaque, projectId: opaque, repositoryId: z.string().regex(/^[0-9]{1,24}$/), repository: selfImprovementRepositorySchema, policy: selfImprovementPolicySchema, generation: z.number().int().positive(), nextDueAt: z.string().datetime({ offset: true }), paused: z.boolean(), timeZone: z.string().min(1).max(100), dailyHour: z.number().int().min(0).max(23), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) }).strict();

export function assertConfiguredSelfImprovementOwner(owner: SelfImprovementOwner): void {
  const tenant = process.env.OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID?.trim();
  const actor = process.env.OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID?.trim();
  if (!tenant || !actor || owner.tenantId !== tenant || owner.ownerActorId !== actor) throw new Error("This deployment has not authorized self-improvement for this exact owner.");
}

async function database() {
  if (!hasDatabaseUrl()) throw new Error("Self-improvement requires canonical PostgreSQL storage.");
  await ensureDatabaseSchema();
}
async function owned<T>(ownerInput: SelfImprovementOwner, work: (sql: SqlClient, owner: SelfImprovementOwner) => Promise<T>): Promise<T> {
  const owner = ownerSchema.parse(ownerInput);
  // Reuse the existing canonical-account/legacy-email bridge. Its first narrow
  // transaction resolves the alias; the effect transaction locks and rechecks
  // that binding before admitting Inbox and transport outboxes atomically.
  return withAvailabilityOwner({ tenantId: owner.tenantId, actorId: owner.ownerActorId }, (sql) => work(sql, owner));
}
async function requireAuthority(sql: SqlClient, owner: SelfImprovementOwner, projectId: string): Promise<void> {
  const membership = await sql`SELECT membership.role FROM omni_auth_users account JOIN omni_auth_memberships membership ON membership.user_id=account.id
    WHERE account.actor_id=${owner.ownerActorId} AND membership.tenant_id=${owner.tenantId} AND account.status='active' AND membership.status='active' AND membership.role='admin' FOR SHARE OF account,membership`;
  if (membership.length !== 1) throw new Error("Self-improvement requires the configured owner's current administrator authority.");
  // Existing narrow SECURITY DEFINER reader checks active account, tenant membership,
  // canonical project ownership and current workspace/project contributor authority.
  const rows = await sql`SELECT project_id FROM public.omni_studio_projects_v1(${owner.tenantId},${owner.ownerActorId},${projectId}) WHERE project_id=${projectId}`;
  if (!rows.length) throw new Error("Self-improvement requires current owner authority for this project.");
}
/** Fresh owner authority for each governed effect; the executing agent may retain its narrower operator role. */
export async function assertSelfImprovementOwnerAuthority(owner: SelfImprovementOwner, projectId: string): Promise<void> {
  assertConfiguredSelfImprovementOwner(owner);
  await owned(owner, (sql, scope) => requireAuthority(sql, scope, opaque.parse(projectId)));
}
/** Read the required brief through the same locked canonical/account alias as the cycle owner. */
export async function getSelfImprovementProjectBrief(owner: SelfImprovementOwner, projectId: string): Promise<Readonly<{ title: string; objective: string }>> {
  assertConfiguredSelfImprovementOwner(owner);
  const id = opaque.parse(projectId);
  return owned(owner, async (sql, scope) => {
    await requireAuthority(sql, scope, id);
    const rows = await sql`SELECT project.title,project.objective FROM omni_projects project
      JOIN omni_auth_users account ON account.actor_id=${scope.ownerActorId} AND account.status='active'
      WHERE project.tenant_id=${scope.tenantId} AND project.id=${id} AND project.status<>'archived'
        AND (project.actor_id=account.actor_id OR project.actor_id=account.email)`;
    if (rows.length !== 1) throw new Error("The self-improvement project brief is unavailable for its current owner.");
    return z.object({ title: z.string(), objective: z.string() }).strict().parse(rows[0]);
  });
}
/** Keep the account alias locked for the entire evidence read; never rewrite source attribution. */
export async function withSelfImprovementEvidenceOwner<T>(owner: SelfImprovementOwner, projectId: string, read: (actorIds: readonly string[]) => Promise<T>): Promise<T> {
  assertConfiguredSelfImprovementOwner(owner);
  return owned(owner, async (sql, scope) => {
    await requireAuthority(sql, scope, opaque.parse(projectId));
    const rows = await sql`SELECT email FROM omni_auth_users WHERE actor_id=${scope.ownerActorId} AND status='active' FOR SHARE`;
    if (rows.length !== 1) throw new Error("The self-improvement evidence owner is unavailable.");
    const email = z.string().email().max(320).parse(rows[0].email);
    // The bounded run/tool/event readers must share this account-locking
    // transaction. A second reservation deadlocks Vercel's one-connection pool.
    return runWithManagedDatabaseTransaction(sql, () => read(Object.freeze([scope.ownerActorId, email])));
  });
}
function configurationFromRow(row: SqlRow): SelfImprovementConfiguration {
  return configurationSchema.parse({ id: row.id, tenantId: row.tenant_id, ownerActorId: row.owner_actor_id, projectId: row.project_id, repositoryId: row.repository_id, repository: row.repository, policy: row.policy, generation: Number(row.generation), nextDueAt: stamp(row.next_due_at), paused: row.paused, timeZone: row.time_zone, dailyHour: Number(row.daily_hour), createdAt: stamp(row.created_at), updatedAt: stamp(row.updated_at) });
}
function cycleFromRow(row: SqlRow): StoredSelfImprovementCycle {
  const cycle = selfImprovementCycleSchema.parse(row.snapshot); assertSelfImprovementCycleIntegrity(cycle);
  if (cycle.id !== row.id || cycle.scope.tenantId !== row.tenant_id || cycle.scope.ownerActorId !== row.owner_actor_id || cycle.revision !== Number(row.revision) || cycle.stage !== row.stage || cycle.policy.policySha256 !== row.policy_sha256 || cycle.scope.baseRevision !== row.base_revision || cycle.dailyReservationUsd !== Number(row.reservation_usd)) throw new Error("Stored self-improvement cycle projection is inconsistent.");
  return { ...(typeof row.unsettled_paid_usage === "boolean" ? { unsettledPaidUsage: row.unsettled_paid_usage } : {}), cycle, configurationId: String(row.configuration_id), configurationGeneration: Number(row.configuration_generation), projectId: String(row.project_id), repositoryId: String(row.repository_id), day: stamp(row.budget_day).slice(0, 10), leaseExpiresAt: stamp(row.lease_expires_at), runtime: z.record(z.string(), z.unknown()).parse(row.runtime), spendUsd: Number(row.spend_usd), usageState: z.enum(["known", "unknown"]).parse(row.usage_state), controllerId: row.release_controller_id ? String(row.release_controller_id) : null, controllerHold: row.controller_hold ? z.object({ category: z.string().regex(/^[a-z0-9_]{1,120}$/), occurredAt: z.string().datetime({ offset: true }) }).strict().parse(row.controller_hold) : null };
}
async function event(sql: SqlClient, configuration: Pick<SelfImprovementConfiguration, "id" | "tenantId" | "ownerActorId" | "projectId">, type: string, eventId: string, payload: Record<string, unknown>) {
  return appendScopedDomainEvent({ id: eventId, streamId: `self-improvement:${configuration.id}`, type,
    executionScope: createExecutionScope({ tenantId: configuration.tenantId, initiatingActorId: configuration.ownerActorId, executingPrincipalType: "system", executingPrincipalId: "asael-self-improvement", projectId: configuration.projectId, correlationId: configuration.id, causationId: eventId, purpose: "owner_authorized_self_improvement.v1" }), payload }, { sql });
}

/** Finds the next local scheduled hour, including zones with half-hour offsets and DST. */
export function nextDailySelfImprovementAt(nowInput: string, timeZone: string, dailyHour = 3): string {
  const now = Date.parse(nowAt(nowInput));
  if (!Number.isInteger(dailyHour) || dailyHour < 0 || dailyHour > 23) throw new Error("Invalid daily improvement hour.");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Minute granularity is deliberate: DST and historical quarter-hour offsets
  // must not be approximated as one fixed UTC offset or 24-hour interval.
  for (let at = Math.floor(now / 60_000) * 60_000 + 60_000, end = now + 49 * 3_600_000; at <= end; at += 60_000) {
    const parts = formatter.formatToParts(new Date(at));
    if (Number(parts.find((part) => part.type === "hour")?.value) === dailyHour && Number(parts.find((part) => part.type === "minute")?.value) === 0) return new Date(at).toISOString();
  }
  throw new Error("Could not resolve the next daily improvement time.");
}

export async function configureSelfImprovement(input: SelfImprovementOwner & {
  projectId: string; repositoryId: string; repository: SelfImprovementScope["repository"]; policy: SelfImprovementPolicy;
  expectedGeneration?: number; nextDueAt?: string; timeZone?: string; dailyHour?: number; now?: string;
}): Promise<SelfImprovementConfiguration> {
  assertConfiguredSelfImprovementOwner(input);
  const repository = selfImprovementRepositorySchema.parse(input.repository);
  const policy = selfImprovementPolicySchema.parse(input.policy);
  const projectId = opaque.parse(input.projectId), repositoryId = z.string().regex(/^[0-9]{1,24}$/).parse(input.repositoryId);
  const now = nowAt(input.now), timeZone = input.timeZone || "Asia/Kolkata", dailyHour = input.dailyHour ?? 3;
  const dueAt = input.nextDueAt ? nowAt(input.nextDueAt) : nextDailySelfImprovementAt(now, timeZone, dailyHour);
  return owned({ tenantId: input.tenantId, ownerActorId: input.ownerActorId }, async (sql, owner) => {
    await requireAuthority(sql, owner, projectId);
    const id = `self_config_${selfImprovementSha256("configuration_id", { ...owner, repositoryId })}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
    const rows = await sql`SELECT * FROM omni_self_improvement_configurations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND id=${id} FOR UPDATE`;
    const previous = rows[0] ? configurationFromRow(rows[0]) : null;
    if (previous && input.expectedGeneration !== previous.generation) throw new Error("Self-improvement configuration changed; read the current generation.");
    if (!previous && input.expectedGeneration !== undefined) throw new Error("Self-improvement configuration does not exist at that generation.");
    if (previous && (previous.projectId !== projectId || previous.repositoryId !== repositoryId)) throw new Error("An existing self-improvement configuration cannot change its project or repository identity.");
    const unchangedSchedule = previous?.timeZone === timeZone && previous?.dailyHour === dailyHour;
    const configuration = configurationSchema.parse({ ...owner, id, projectId, repositoryId, repository, policy, generation: (previous?.generation || 0) + 1, nextDueAt: previous && unchangedSchedule && !input.nextDueAt ? previous.nextDueAt : dueAt, paused: previous?.paused || false, timeZone, dailyHour, createdAt: previous?.createdAt || now, updatedAt: now });
    await sql`INSERT INTO omni_self_improvement_configurations (id,tenant_id,owner_actor_id,project_id,repository_id,repository_key,repository,policy,policy_sha256,generation,next_due_at,paused,time_zone,daily_hour,created_at,updated_at)
      VALUES (${id},${owner.tenantId},${owner.ownerActorId},${projectId},${repositoryId},${repoKey(repositoryId)},${repository}::jsonb,${policy}::jsonb,${policy.policySha256},${configuration.generation},${configuration.nextDueAt},${configuration.paused},${timeZone},${dailyHour},${configuration.createdAt},${now})
      ON CONFLICT (id) DO UPDATE SET repository=EXCLUDED.repository,policy=EXCLUDED.policy,policy_sha256=EXCLUDED.policy_sha256,generation=EXCLUDED.generation,next_due_at=EXCLUDED.next_due_at,time_zone=EXCLUDED.time_zone,daily_hour=EXCLUDED.daily_hour,updated_at=EXCLUDED.updated_at`;
    await event(sql, configuration, "self_improvement.configured", `${id}:generation:${configuration.generation}`, { generation: configuration.generation, policySha256: policy.policySha256, repositoryKey: repoKey(repositoryId), nextDueAt: configuration.nextDueAt });
    return configuration;
  });
}
export async function getSelfImprovementConfiguration(owner: SelfImprovementOwner, configurationId: string): Promise<SelfImprovementConfiguration | null> {
  return owned(owner, async (sql, scope) => { const rows = await sql`SELECT * FROM omni_self_improvement_configurations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND id=${opaque.parse(configurationId)}`; return rows[0] ? configurationFromRow(rows[0]) : null; });
}
export async function listSelfImprovementConfigurations(owner: SelfImprovementOwner): Promise<SelfImprovementConfiguration[]> {
  return owned(owner, async (sql, scope) => (await sql`SELECT * FROM omni_self_improvement_configurations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} ORDER BY created_at DESC,id LIMIT 100`).map(configurationFromRow));
}
export async function pauseSelfImprovement(input: { owner: SelfImprovementOwner; configurationId: string; expectedGeneration: number; paused: boolean; now?: string }): Promise<SelfImprovementConfiguration> {
  assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async (sql, owner) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_configurations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND id=${input.configurationId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Self-improvement configuration was not found.");
    const before = configurationFromRow(rows[0]); await requireAuthority(sql, owner, before.projectId);
    if (before.generation !== input.expectedGeneration) throw new Error("Self-improvement configuration generation changed.");
    const now = nowAt(input.now);
    const changed = await sql`UPDATE omni_self_improvement_configurations SET paused=${input.paused},generation=generation+1,updated_at=${now} WHERE id=${before.id} AND tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND generation=${input.expectedGeneration} RETURNING *`;
    const configuration = configurationFromRow(changed[0]);
    await event(sql, configuration, input.paused ? "self_improvement.paused" : "self_improvement.resumed", `${before.id}:generation:${configuration.generation}`, { generation: configuration.generation, policySha256: configuration.policy.policySha256 });
    return configuration;
  });
}

export type DueSelfImprovementConfiguration = Pick<SelfImprovementConfiguration, "id" | "tenantId" | "ownerActorId" | "projectId" | "repositoryId" | "repository" | "generation" | "nextDueAt">;
export async function listDueSelfImprovementConfigurations(input: { tenantId: string; now?: string; limit?: number }): Promise<DueSelfImprovementConfiguration[]> {
  await database(); const now = nowAt(input.now), limit = Math.max(1, Math.min(20, input.limit || 5));
  return runWithDatabaseSystemScope("Discover due self-improvement owner/project/repository metadata only.", async () => {
    const rows = await getSql()`SELECT id,tenant_id,owner_actor_id,project_id,repository_id,repository,generation,next_due_at FROM omni_self_improvement_configurations WHERE tenant_id=${opaque.parse(input.tenantId)} AND paused=FALSE AND next_due_at<=${now} ORDER BY next_due_at,id LIMIT ${limit}`;
    return rows.map((row) => ({ id: String(row.id), tenantId: String(row.tenant_id), ownerActorId: String(row.owner_actor_id), projectId: String(row.project_id), repositoryId: String(row.repository_id), repository: selfImprovementRepositorySchema.parse(row.repository), generation: Number(row.generation), nextDueAt: stamp(row.next_due_at) }));
  });
}
type ClaimInput = { owner: SelfImprovementOwner; configurationId: string; expectedGeneration: number; baseRevision: string; idempotencyKey: string; now?: string; scheduled?: boolean };
type SetupRetryInput = Omit<ClaimInput, "scheduled" | "idempotencyKey"> & { failedCycleId: string; expectedRevision: number };
const retryRequestKey = (cycleId: string, revision: number) => `pre-ai-setup-retry:${cycleId}:${revision}`;
const setupRetrySchema = z.object({ cycleId: opaque, revision: z.number().int().positive(), cycleSha256: selfImprovementDigestSchema, toolExecutionId: opaque, toolReceiptSha256: selfImprovementDigestSchema }).strict();
const setupRetryRecordSchema = z.record(z.string(), z.unknown());

/** A precise pre-effect rejection, never a generic retry of a failed/uncertain tool. */
async function provenSetupRetry(sql: SqlClient, owner: SelfImprovementOwner, stored: StoredSelfImprovementCycle, now: string): Promise<SelfImprovementSetupRetry | null> {
  const cycle = stored.cycle, runtime = selfImprovementRuntimeSchema.safeParse(stored.runtime);
  if (cycle.stage !== "failed" || stored.day !== now.slice(0, 10) || stored.usageState !== "known" || stored.spendUsd !== 0 ||
      stored.controllerId || stored.controllerHold || cycle.signal || cycle.runId || cycle.builderSessionId || cycle.checkpointId || cycle.verificationId || cycle.deliveryId || cycle.pullRequestUrl ||
      cycle.candidate || cycle.validation || cycle.approval || cycle.release || cycle.releaseReceipt || cycle.correctionsUsed || !runtime.success ||
      runtime.data.phase !== "setup" || runtime.data.setupStep !== "create" || runtime.data.agentRuns.length || runtime.data.phaseAttempt || runtime.data.reservedModelUsd ||
      runtime.data.plan || runtime.data.baseline || runtime.data.checks.length || runtime.data.reviewRunId || Object.keys(runtime.data.sourceHashes).length) return null;
  const started = await sql`SELECT payload FROM omni_events WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.ownerActorId} AND id=${`${cycle.id}:1`} AND stream_id=${`self-improvement:${stored.configurationId}`} AND type='self_improvement.cycle.started'`;
  const startedPayload = setupRetryRecordSchema.safeParse(started[0]?.payload);
  if (started.length !== 1 || !startedPayload.success || !["owner", "daily"].includes(String(startedPayload.data.trigger)) || startedPayload.data.retryOf) return null;
  const effects = await sql`SELECT EXISTS(SELECT 1 FROM omni_self_improvement_phase_reservations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND cycle_id=${cycle.id}) AS paid,
    EXISTS(SELECT 1 FROM omni_app_builder_sessions WHERE tenant_id=${owner.tenantId} AND project_id=${stored.projectId}) AS builder`;
  if (effects[0]?.paid || effects[0]?.builder) return null;
  const executionId = governedToolExecutionId(owner.tenantId, `self-improvement:${cycle.id}:workspace`);
  const rows = await sql`SELECT id,tenant_id,actor_id,tool_id,status,dry_run,input,output,reason,effect_receipt,created_at,completed_at FROM omni_tool_executions WHERE id=${executionId} AND tenant_id=${owner.tenantId} AND actor_id=${owner.ownerActorId} FOR SHARE`;
  const receipt = rows[0], input = { projectId: stored.projectId, workspaceMode: "source_only" };
  const receiptInput = setupRetryRecordSchema.safeParse(receipt?.input), receiptOutput = setupRetryRecordSchema.safeParse(receipt?.output);
  if (!receipt || !receiptInput.success || !receiptOutput.success || receipt.tool_id !== "app.projects.builder.create" || receipt.status !== "failed" || receipt.dry_run || receipt.effect_receipt ||
      receipt.reason !== "Project was not found." || receiptOutput.data.error !== "Project was not found." || toolInputSha256(receiptInput.data) !== toolInputSha256(input) ||
      !receipt.completed_at || Date.parse(stamp(receipt.created_at)) < Date.parse(cycle.createdAt) || Date.parse(stamp(receipt.completed_at)) > Date.parse(cycle.updatedAt)) return null;
  const bindings = await sql`SELECT payload FROM omni_events WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.ownerActorId} AND stream_id=${`tool_execution:${executionId}`} AND type='tool.scope_bound'`;
  if (bindings.length !== 1) return null;
  const parsedBinding = setupRetryRecordSchema.safeParse(bindings[0].payload);
  if (!parsedBinding.success) return null;
  const binding = parsedBinding.data;
  const scope = parsePersistedExecutionScope(binding._executionScope);
  if (!scope || scope.tenantId !== owner.tenantId || scope.initiatingActorId !== owner.ownerActorId || scope.projectId !== stored.projectId ||
      scope.correlationId !== cycle.id || scope.causationId !== cycle.id || scope.purpose !== "self_improvement.cycle.v1" || scope.executingPrincipalType !== "agent" ||
      binding.toolId !== "app.projects.builder.create" || binding.inputSha256 !== toolInputSha256(input) || binding.scopeSha256 !== toolInputSha256(scope)) return null;
  return { cycleId: cycle.id, revision: cycle.revision, cycleSha256: selfImprovementSha256("failed_setup_cycle", cycle), toolExecutionId: executionId,
    toolReceiptSha256: selfImprovementSha256("failed_setup_tool", { id: executionId, toolId: receipt.tool_id, input, error: receipt.reason, createdAt: stamp(receipt.created_at), completedAt: stamp(receipt.completed_at), scope }) };
}

export async function getSelfImprovementSetupRetry(owner: SelfImprovementOwner, cycleId: string): Promise<SelfImprovementSetupRetry | null> {
  if (owner.tenantId !== process.env.OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID || owner.ownerActorId !== process.env.OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID) return null;
  return owned(owner, async (sql) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND id=${opaque.parse(cycleId)}`;
    if (!rows[0]) return null;
    const stored = cycleFromRow(rows[0]), now = nowAt();
    const configurations = await sql`SELECT * FROM omni_self_improvement_configurations WHERE id=${stored.configurationId} AND tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId}`;
    if (!configurations[0]) return null;
    const configuration = configurationFromRow(configurations[0]);
    if (configuration.policy.policySha256 !== stored.cycle.policy.policySha256 || configuration.projectId !== stored.projectId || configuration.repositoryId !== stored.repositoryId) return null;
    const used = await sql`SELECT EXISTS(SELECT 1 FROM omni_self_improvement_cycles WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND idempotency_sha256=${selfImprovementSha256("cycle_request", retryRequestKey(cycleId, stored.cycle.revision))}) AS child,
      COALESCE((SELECT SUM(reserved_usd) FROM omni_self_improvement_budget_reservations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND budget_day=${now.slice(0, 10)}::date),0) AS gross`;
    const cycleBudgetUsd = selfImprovementCycleBudgetUsd(configuration.policy);
    const legacyRetryCredit = configuration.policy.maxCycleBudgetUsd === undefined ? cycleBudgetUsd : 0;
    if (used[0]?.child || Number(used[0]?.gross) + cycleBudgetUsd > 100 || Number(used[0]?.gross) + cycleBudgetUsd - legacyRetryCredit > configuration.policy.dailyBudgetUsd) return null;
    return provenSetupRetry(sql, owner, stored, now);
  });
}

export async function retryPreAiSelfImprovementCycle(input: SetupRetryInput): Promise<SelfImprovementCycleClaim> {
  const failedCycleId = opaque.parse(input.failedCycleId), expectedRevision = z.number().int().positive().parse(input.expectedRevision);
  return claimSelfImprovementCycle({ ...input, idempotencyKey: retryRequestKey(failedCycleId, expectedRevision) }, { failedCycleId, expectedRevision });
}
export async function claimManualSelfImprovementCycle(input: ClaimInput): Promise<SelfImprovementCycleClaim> {
  return claimSelfImprovementCycle(input);
}
async function claimSelfImprovementCycle(input: ClaimInput, retry?: { failedCycleId: string; expectedRevision: number }): Promise<SelfImprovementCycleClaim> {
  assertConfiguredSelfImprovementOwner(input.owner);
  const baseRevision = selfImprovementRevisionSchema.parse(input.baseRevision), now = nowAt(input.now);
  const day = now.slice(0, 10), idempotencySha256 = selfImprovementSha256("cycle_request", opaque.parse(input.idempotencyKey));
  const requestSha256 = selfImprovementSha256("cycle_admission", { configurationId: input.configurationId, expectedGeneration: input.expectedGeneration, baseRevision, scheduled: Boolean(input.scheduled), ...(retry ? { retry } : {}) });
  return owned(input.owner, async (sql, owner) => {
    // One daily dollar ledger per owner across all policies/repositories. Pause,
    // policy edits and retries never remove earlier reservations or actual cost.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["self-improvement-budget", owner.tenantId, owner.ownerActorId, day])},0))`;
    if (!input.scheduled && !retry) {
      const prior = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND idempotency_sha256=${idempotencySha256}`;
      if (prior[0]) {
        if (prior[0].request_sha256 !== requestSha256) throw new Error("Cycle idempotency key belongs to a different exact request.");
        return { outcome: "duplicate", cycle: cycleFromRow(prior[0]) };
      }
    }
    const rows = await sql`SELECT * FROM omni_self_improvement_configurations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND id=${opaque.parse(input.configurationId)} FOR UPDATE`;
    if (!rows[0]) throw new Error("Self-improvement configuration was not found.");
    const configuration = configurationFromRow(rows[0]);
    await requireAuthority(sql, owner, configuration.projectId);
    if (configuration.generation !== input.expectedGeneration) throw new Error("Self-improvement configuration generation changed.");
    if (configuration.paused) return { outcome: "paused" };
    if (input.scheduled && Date.parse(configuration.nextDueAt) > Date.parse(now)) return { outcome: "not_due" };
    let retryOf: SelfImprovementSetupRetry | undefined;
    if (retry) {
      const prior = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND idempotency_sha256=${idempotencySha256}`;
      if (prior[0]) {
        if (prior[0].request_sha256 !== requestSha256) throw new Error("Setup retry belongs to a different exact request; read its existing cycle.");
        const lineage = await sql`SELECT payload FROM omni_events WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.ownerActorId} AND id=${`${prior[0].id}:1`} AND type='self_improvement.cycle.started'`;
        const lineagePayload = setupRetryRecordSchema.parse(lineage[0]?.payload);
        return { outcome: "duplicate", cycle: cycleFromRow(prior[0]), retryOf: setupRetrySchema.parse(lineagePayload.retryOf) };
      }
      const parents = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND id=${retry.failedCycleId} FOR SHARE`;
      const parent = parents[0] ? cycleFromRow(parents[0]) : null;
      if (!parent || parent.cycle.revision !== retry.expectedRevision || parent.configurationId !== configuration.id) throw new Error("Read the exact failed setup before retrying.");
      assertCurrentSelfImprovementConfiguration(configuration, parent);
      retryOf = await provenSetupRetry(sql, owner, parent, now) || undefined;
      if (!retryOf) throw new Error("This failure has no proven pre-AI, pre-resource setup retry. Its records remain unchanged.");
    }
    const reserved = await sql`SELECT COALESCE(SUM(reserved_usd),0) AS total FROM omni_self_improvement_budget_reservations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND budget_day=${day}::date`;
    const reservedUsd = Number(reserved[0].total);
    const cycleBudgetUsd = selfImprovementCycleBudgetUsd(configuration.policy);
    // Preserve the old, proved pre-effect retry contract only for sealed legacy policies.
    // New policies count every admitted cycle against their explicit daily allowance.
    const legacyRetryCredit = retryOf && configuration.policy.maxCycleBudgetUsd === undefined ? cycleBudgetUsd : 0;
    if (reservedUsd + cycleBudgetUsd > 100 || reservedUsd + cycleBudgetUsd - legacyRetryCredit > configuration.policy.dailyBudgetUsd) {
      if (input.scheduled) {
        // A used UTC admission day skips this local occurrence. Leaving it due
        // would retry until UTC midnight and permanently shift the local hour.
        // Check due work before the daily key: an earlier scheduled admission
        // may share that key even after the baseline or policy has changed.
        const nextDueAt = nextDailySelfImprovementAt(now, configuration.timeZone, configuration.dailyHour);
        await sql`UPDATE omni_self_improvement_configurations SET next_due_at=${nextDueAt},updated_at=${now} WHERE id=${configuration.id} AND tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId}`;
        await event(sql, configuration, "self_improvement.schedule.skipped", `self_schedule_${selfImprovementSha256("schedule_skip", { configurationId: configuration.id, generation: configuration.generation, dueAt: configuration.nextDueAt, budgetDay: day })}`,
          { reason: "utc_day_already_reserved", dueAt: configuration.nextDueAt, nextDueAt, budgetDay: day, reservedUsd, dailyBudgetUsd: configuration.policy.dailyBudgetUsd, policySha256: configuration.policy.policySha256 });
      }
      return { outcome: "budget_exhausted" };
    }
    const id = `self_cycle_${selfImprovementSha256("cycle_id", { ...owner, configurationId: configuration.id, idempotencySha256 })}`;
    const leaseToken = randomUUID(), leaseExpiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    const cycle = selfImprovementCycleSchema.parse({ id, scope: { ...owner, repository: configuration.repository, baseRevision }, policy: configuration.policy, stage: "observing", revision: 1, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: cycleBudgetUsd, leaseToken: null, createdAt: now, updatedAt: now });
    const inserted = await sql`INSERT INTO omni_self_improvement_cycles (id,tenant_id,owner_actor_id,configuration_id,configuration_generation,project_id,repository_id,repository_key,base_revision,policy_sha256,idempotency_sha256,request_sha256,budget_day,reservation_usd,spend_usd,usage_state,stage,revision,snapshot,runtime,lease_token_sha256,lease_expires_at,created_at,updated_at)
      VALUES (${id},${owner.tenantId},${owner.ownerActorId},${configuration.id},${configuration.generation},${configuration.projectId},${configuration.repositoryId},${repoKey(configuration.repositoryId)},${baseRevision},${configuration.policy.policySha256},${idempotencySha256},${requestSha256},${day}::date,${cycle.dailyReservationUsd},0,'known','observing',1,${cycle}::jsonb,${{}}::jsonb,${tokenHash(leaseToken)},${leaseExpiresAt},${now},${now}) ON CONFLICT DO NOTHING RETURNING *`;
    // Global repository uniqueness applies even to rows hidden by another owner's RLS.
    if (!inserted[0]) return { outcome: "busy" };
    await sql`INSERT INTO omni_self_improvement_budget_reservations (tenant_id,owner_actor_id,cycle_id,budget_day,reserved_usd,created_at) VALUES (${owner.tenantId},${owner.ownerActorId},${id},${day}::date,${cycle.dailyReservationUsd},${now})`;
    const nextDueAt = nextDailySelfImprovementAt(now, configuration.timeZone, configuration.dailyHour);
    await sql`UPDATE omni_self_improvement_configurations SET next_due_at=${nextDueAt},updated_at=${now} WHERE id=${configuration.id} AND tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId}`;
    await event(sql, configuration, "self_improvement.cycle.started", `${id}:1`, { cycleId: id, baseRevision, policySha256: cycle.policy.policySha256, reservationUsd: cycle.dailyReservationUsd, budgetDay: day, trigger: retryOf ? "owner_retry" : input.scheduled ? "daily" : "owner", ...(retryOf ? { retryOf } : {}) });
    return { outcome: "claimed", cycle: { ...cycleFromRow(inserted[0]), leaseToken }, ...(retryOf ? { retryOf } : {}) };
  });
}
export async function claimDueSelfImprovementCycles(input: { tenantId: string; targets: ReadonlyArray<{ configurationId: string; ownerActorId: string; expectedGeneration: number; baseRevision: string }>; now?: string }): Promise<SelfImprovementCycleClaim[]> {
  const now = nowAt(input.now); const results: SelfImprovementCycleClaim[] = [];
  for (const target of input.targets.slice(0, 20)) results.push(await claimManualSelfImprovementCycle({ owner: { tenantId: input.tenantId, ownerActorId: target.ownerActorId }, ...target, idempotencyKey: `daily:${target.configurationId}:${now.slice(0, 10)}`, scheduled: true, now }));
  return results;
}
export async function getSelfImprovementCycle(owner: SelfImprovementOwner, cycleId: string): Promise<StoredSelfImprovementCycle | null> {
  return owned(owner, async (sql, scope) => { const rows = await sql`SELECT cycle.*, EXISTS(SELECT 1 FROM omni_self_improvement_phase_reservations phase WHERE phase.tenant_id=cycle.tenant_id AND phase.owner_actor_id=cycle.owner_actor_id AND phase.cycle_id=cycle.id AND phase.state<>'settled') AS unsettled_paid_usage FROM omni_self_improvement_cycles cycle WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND id=${opaque.parse(cycleId)}`; return rows[0] ? cycleFromRow(rows[0]) : null; });
}
export async function listSelfImprovementCycles(owner: SelfImprovementOwner, options: { configurationId?: string; limit?: number; activeOnly?: boolean } = {}): Promise<StoredSelfImprovementCycle[]> {
  return owned(owner, async (sql, scope) => (await sql`SELECT cycle.*, EXISTS(SELECT 1 FROM omni_self_improvement_phase_reservations phase WHERE phase.tenant_id=cycle.tenant_id AND phase.owner_actor_id=cycle.owner_actor_id AND phase.cycle_id=cycle.id AND phase.state<>'settled') AS unsettled_paid_usage FROM omni_self_improvement_cycles cycle WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND (${options.configurationId || null}::text IS NULL OR configuration_id=${options.configurationId || null}) AND (${!options.activeOnly} OR stage NOT IN ('no_change','succeeded','failed','rolled_back','cancelled')) ORDER BY created_at DESC,id LIMIT ${Math.max(1, Math.min(100, options.limit || 20))}`).map(cycleFromRow));
}
export type SelfImprovementCycleFence = { owner: SelfImprovementOwner; cycleId: string; expectedRevision: number; leaseToken: string; now?: string };
type CyclePatch = Partial<Pick<SelfImprovementCycle, "signal" | "candidate" | "validation" | "approval" | "release" | "releaseReceipt" | "correctionsUsed" | "runId" | "builderSessionId" | "checkpointId" | "verificationId" | "deliveryId" | "pullRequestUrl">>;
const cyclePatchSchema = selfImprovementCycleSchema.pick({ signal: true, candidate: true, validation: true, approval: true, release: true, releaseReceipt: true, correctionsUsed: true, runId: true, builderSessionId: true, checkpointId: true, verificationId: true, deliveryId: true, pullRequestUrl: true }).partial().strict();
const runtimePatchSchema = selfImprovementCycleSchema.pick({ runId: true, builderSessionId: true, checkpointId: true, verificationId: true, deliveryId: true, pullRequestUrl: true }).partial().strict();
async function requireCycleEffectAuthority(sql: SqlClient, owner: SelfImprovementOwner, stored: StoredSelfImprovementCycle) {
  assertConfiguredSelfImprovementOwner(owner);
  await requireAuthority(sql, owner, stored.projectId);
  const rows = await sql`SELECT * FROM omni_self_improvement_configurations WHERE id=${stored.configurationId} AND tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} FOR SHARE`;
  assertCurrentSelfImprovementConfiguration(rows[0] ? configurationFromRow(rows[0]) : null, stored);
}
async function fenced(sql: SqlClient, input: SelfImprovementCycleFence, now: string): Promise<{ row: SqlRow; stored: StoredSelfImprovementCycle }> {
  const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
  if (!rows[0]) throw new Error("Self-improvement cycle was not found.");
  const row = rows[0], stored = cycleFromRow(row);
  if (stored.cycle.revision !== input.expectedRevision || row.lease_token_sha256 !== tokenHash(input.leaseToken) || Date.parse(stored.leaseExpiresAt) <= Date.parse(now)) throw new Error("Self-improvement cycle lease or revision is stale.");
  if (isSelfImprovementTerminalStage(stored.cycle.stage)) throw new Error("A completed self-improvement cycle is immutable.");
  return { row, stored };
}
async function writeCycle(sql: SqlClient, before: StoredSelfImprovementCycle, cycle: SelfImprovementCycle, runtime: Record<string, unknown>, spendUsd: number, usageState: "known" | "unknown", lease?: { tokenSha256: string; expiresAt: string }): Promise<StoredSelfImprovementCycle> {
  if (Buffer.byteLength(JSON.stringify(runtime)) > 128_000) throw new Error("Self-improvement runtime metadata is too large.");
  const rows = await sql`UPDATE omni_self_improvement_cycles SET stage=${cycle.stage},revision=${cycle.revision},snapshot=${cycle}::jsonb,runtime=${runtime}::jsonb,spend_usd=${spendUsd},usage_state=${usageState},lease_token_sha256=COALESCE(${lease?.tokenSha256 || null},lease_token_sha256),lease_expires_at=COALESCE(${lease?.expiresAt || null}::timestamptz,lease_expires_at),updated_at=${cycle.updatedAt} WHERE id=${cycle.id} AND tenant_id=${cycle.scope.tenantId} AND owner_actor_id=${cycle.scope.ownerActorId} AND revision=${before.cycle.revision} RETURNING *`;
  if (!rows[0]) throw new Error("Self-improvement compare-and-set lost its revision.");
  await event(sql, { id: before.configurationId, ...cycle.scope, projectId: before.projectId }, "self_improvement.cycle.updated", `${cycle.id}:${cycle.revision}`, { cycleId: cycle.id, stage: cycle.stage, revision: cycle.revision, policySha256: cycle.policy.policySha256, candidateSha256: cycle.candidate?.candidateSha256 || null, validationSha256: cycle.validation?.validationSha256 || null, releaseBindingSha256: cycle.release?.releaseBindingSha256 || null, spendUsd, usageState });
  if (before.cycle.stage !== cycle.stage) {
    const { admitSelfImprovementNotificationWithSql } = await import("./notifications");
    await admitSelfImprovementNotificationWithSql(sql, { tenantId: cycle.scope.tenantId, actorId: cycle.scope.ownerActorId,
      cycleId: cycle.id, eventId: `${cycle.id}:${cycle.revision}`, stage: cycle.stage, occurredAt: cycle.updatedAt });
  }
  return cycleFromRow(rows[0]);
}
/** Discard an unclaimed held candidate without taking an execution or release lease. */
export async function discardHeldSelfImprovementCandidate(input: {
  owner: SelfImprovementOwner; cycleId: string; expectedRevision: number; candidateSha256: string; validationSha256: string; now?: string;
}): Promise<StoredSelfImprovementCycle> {
  assertConfiguredSelfImprovementOwner(input.owner);
  const now = nowAt(input.now);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${opaque.parse(input.cycleId)} FOR UPDATE`;
    if (!rows[0]) throw new Error("The exact held candidate was not found.");
    const stored = cycleFromRow(rows[0]);
    // Discard must remain available after pausing or changing future policy,
    // while still requiring the configured owner's current administrator access.
    await requireAuthority(sql, input.owner, stored.projectId);
    if (!canDiscardHeldSelfImprovementCandidate(stored, now) || stored.cycle.revision !== input.expectedRevision ||
        stored.cycle.candidate?.candidateSha256 !== selfImprovementDigestSchema.parse(input.candidateSha256) ||
        stored.cycle.validation?.validationSha256 !== selfImprovementDigestSchema.parse(input.validationSha256)) {
      throw new Error("This exact held candidate cannot be discarded while claimed, active or uncertain.");
    }
    const unsettled = await sql`SELECT phase_id FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${stored.cycle.id} AND state<>'settled' LIMIT 1`;
    if (unsettled.length) throw new Error("This candidate has unsettled usage and cannot be discarded.");
    const cycle = selfImprovementCycleSchema.parse({ ...stored.cycle, stage: "cancelled", revision: stored.cycle.revision + 1, updatedAt: now });
    assertSelfImprovementCycleTransition(stored.cycle, cycle);
    const changed = await writeCycle(sql, stored, cycle, stored.runtime, stored.spendUsd, stored.usageState);
    await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.candidate.discarded", `${cycle.id}:${cycle.revision}:discard`, {
      cycleId: cycle.id, decision: "reject", candidateSha256: input.candidateSha256, validationSha256: input.validationSha256,
      holdCategory: stored.controllerHold!.category, previousRevision: stored.cycle.revision,
    });
    return changed;
  });
}
/** Renew only the exact unclaimed candidate whose prior approval expired while waiting for its controller. */
export async function reviewExpiredSelfImprovementApproval(input: {
  owner: SelfImprovementOwner; cycleId: string; expectedRevision: number; candidateSha256: string; validationSha256: string;
  decision: "approve" | "reject"; approval?: SelfImprovementApproval; now?: string;
}): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now), decision = z.enum(["approve", "reject"]).parse(input.decision);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${opaque.parse(input.cycleId)} FOR UPDATE`;
    if (!rows[0]) throw new Error("The exact expired candidate was not found.");
    const stored = cycleFromRow(rows[0]);
    await requireCycleEffectAuthority(sql, input.owner, stored);
    if (stored.cycle.stage !== "ready_for_release" || stored.cycle.revision !== input.expectedRevision || !stored.cycle.approval ||
        Date.parse(stored.cycle.approval.expiresAt) > Date.parse(now) || stored.controllerId || stored.controllerHold ||
        Date.parse(stored.leaseExpiresAt) > Date.parse(now) || stored.usageState !== "known" ||
        stored.cycle.candidate?.candidateSha256 !== selfImprovementDigestSchema.parse(input.candidateSha256) ||
        stored.cycle.validation?.validationSha256 !== selfImprovementDigestSchema.parse(input.validationSha256)) throw new Error("This exact candidate is not awaiting renewed owner approval.");
    const approval = decision === "approve" ? selfImprovementApprovalSchema.parse(input.approval) : null;
    const cycle = selfImprovementCycleSchema.parse({ ...stored.cycle, approval, stage: decision === "approve" ? "ready_for_release" : "cancelled",
      revision: stored.cycle.revision + 1, updatedAt: now });
    assertSelfImprovementCycleIntegrity(cycle);
    if (decision === "reject") assertSelfImprovementCycleTransition(stored.cycle, cycle);
    const changed = await writeCycle(sql, stored, cycle, stored.runtime, stored.spendUsd, stored.usageState);
    await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.review.renewed", `${cycle.id}:${cycle.revision}:review`, {
      cycleId: cycle.id, decision, candidateSha256: input.candidateSha256, validationSha256: input.validationSha256,
      previousApprovalSha256: stored.cycle.approval.receiptSha256, approvalReceiptSha256: approval?.receiptSha256 || null,
    });
    return changed;
  });
}
export async function transitionSelfImprovementCycle(input: SelfImprovementCycleFence & { nextStage: SelfImprovementStage; patch?: CyclePatch }): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now);
  return owned(input.owner, async (sql) => {
    const { stored } = await fenced(sql, input, now);
    if (stored.usageState === "unknown" && !["failed", "cancelled", "rolled_back", "succeeded"].includes(input.nextStage)) throw new Error("Unmetered usage must be reconciled before more autonomous work.");
    // Recheck live authority before starting a new effect; reconciliation of an
    // already-started release remains possible after access revocation.
    if (stored.cycle.stage !== "releasing" && !["failed", "cancelled", "no_change"].includes(input.nextStage)) await requireCycleEffectAuthority(sql, input.owner, stored);
    const cycle = selfImprovementCycleSchema.parse({ ...stored.cycle, ...cyclePatchSchema.parse(input.patch || {}), stage: input.nextStage, revision: stored.cycle.revision + 1, updatedAt: now });
    assertSelfImprovementCycleTransition(stored.cycle, cycle, Math.max(0, Date.parse(now) - Date.parse(stored.cycle.createdAt) - selfImprovementExecutionElapsedMs(stored.cycle.createdAt, stored.runtime, now)));
    return writeCycle(sql, stored, cycle, stored.runtime, stored.spendUsd, stored.usageState);
  });
}
export async function updateSelfImprovementCycleRuntime(input: SelfImprovementCycleFence & { runtime: Record<string, unknown>; patch?: Pick<CyclePatch, "runId" | "builderSessionId" | "checkpointId" | "verificationId" | "deliveryId" | "pullRequestUrl">; spendUsd?: number; usageState?: "known" | "unknown" }): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now);
  return owned(input.owner, async (sql) => {
    const { stored } = await fenced(sql, input, now);
    const spendUsd = input.spendUsd ?? stored.spendUsd, usageState = input.usageState ?? stored.usageState;
    if (!Number.isFinite(spendUsd) || spendUsd < stored.spendUsd || spendUsd > stored.cycle.dailyReservationUsd) throw new Error("Actual usage must be monotonic and within the reserved ceiling.");
    if (spendUsd !== stored.spendUsd || usageState !== stored.usageState) throw new Error("Usage changes require canonical phase settlement receipts.");
    const cycle = selfImprovementCycleSchema.parse({ ...stored.cycle, ...runtimePatchSchema.parse(input.patch || {}), revision: stored.cycle.revision + 1, updatedAt: now });
    assertSelfImprovementCycleIntegrity(cycle);
    return writeCycle(sql, stored, cycle, z.record(z.string(), z.unknown()).parse(input.runtime), spendUsd, usageState);
  });
}
/** Expiry never deletes a cycle or releases its repository lock. Recovery obtains a new fenced token. */
export async function renewSelfImprovementCycleLease(input: { owner: SelfImprovementOwner; cycleId: string; expectedRevision: number; leaseToken?: string; now?: string }): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now);
  return owned(input.owner, async (sql) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Self-improvement cycle was not found.");
    const before = cycleFromRow(rows[0]);
    if (before.cycle.revision !== input.expectedRevision || isSelfImprovementTerminalStage(before.cycle.stage)) throw new Error("Self-improvement lease recovery revision is stale.");
    if (Date.parse(before.leaseExpiresAt) > Date.parse(now) && (!input.leaseToken || tokenHash(input.leaseToken) !== rows[0].lease_token_sha256)) throw new Error("Another worker holds this self-improvement lease.");
    // Release recovery is read/reconcile-only in the controller. It must never
    // interpret an expired lease as permission to replay deployment.
    if (before.cycle.stage !== "releasing") await requireAuthority(sql, input.owner, before.projectId);
    const leaseToken = randomUUID(), leaseExpiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    const cycle = { ...before.cycle, revision: before.cycle.revision + 1, updatedAt: now };
    const changed = await sql`UPDATE omni_self_improvement_cycles SET lease_token_sha256=${tokenHash(leaseToken)},lease_expires_at=${leaseExpiresAt},revision=${cycle.revision},snapshot=${cycle}::jsonb,updated_at=${now} WHERE id=${cycle.id} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND revision=${input.expectedRevision} RETURNING *`;
    await event(sql, { id: before.configurationId, ...input.owner, projectId: before.projectId }, "self_improvement.cycle.lease_renewed", `${cycle.id}:${cycle.revision}`, { cycleId: cycle.id, revision: cycle.revision, stage: cycle.stage, leaseExpiresAt });
    return { ...cycleFromRow(changed[0]), leaseToken };
  });
}

export async function releaseSelfImprovementExecutionLease(input: SelfImprovementCycleFence): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now);
  return owned(input.owner, async (sql) => {
    const { stored } = await fenced(sql, input, now);
    const cycle = { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now };
    const rows = await sql`UPDATE omni_self_improvement_cycles SET lease_token_sha256=${tokenHash(randomUUID())},lease_expires_at=${now},revision=${cycle.revision},snapshot=${cycle}::jsonb,updated_at=${now} WHERE id=${cycle.id} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND revision=${input.expectedRevision} RETURNING *`;
    await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.cycle.execution_yielded", `${cycle.id}:${cycle.revision}`, { cycleId: cycle.id, revision: cycle.revision, stage: cycle.stage });
    return cycleFromRow(rows[0]);
  });
}

export type SelfImprovementPhaseReservation = Readonly<{ phaseId: string; reservedUsd: number; actualUsd: number | null; state: "reserved" | "settled" | "unknown"; evidenceSha256: string | null }>;
function phaseFromRow(row: SqlRow): SelfImprovementPhaseReservation {
  return { phaseId: String(row.phase_id), reservedUsd: Number(row.reserved_usd), actualUsd: row.actual_usd === null ? null : Number(row.actual_usd), state: z.enum(["reserved", "settled", "unknown"]).parse(row.state), evidenceSha256: row.evidence_sha256 === null ? null : String(row.evidence_sha256) };
}
/** Paid work uses a fixed UTC day, independently of the owner's chosen schedule zone. */
async function requireDailyPaidPhaseAllowance(sql: SqlClient, owner: SelfImprovementOwner, now: string, reservedUsd: number, ceilingUsd: number): Promise<void> {
  // The same owner lock is acquired by the database trigger. Outstanding work
  // remains charged until measured; a phase spanning midnight counts on both
  // its admission and settlement day so a delayed release cannot reset cost.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('self-improvement-paid-day',${owner.tenantId}::text,${owner.ownerActorId}::text)::text,0))`;
  const start = `${now.slice(0, 10)}T00:00:00.000Z`, end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const rows = await sql`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_usd ELSE GREATEST(reserved_usd,COALESCE(actual_usd,0)) END),0)+${reservedUsd}::numeric<=LEAST(100,${ceilingUsd}::numeric) AS admitted
    FROM omni_self_improvement_phase_reservations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId}
      AND (state IN ('reserved','unknown') OR (created_at>=${start}::timestamptz AND created_at<${end}::timestamptz) OR (settled_at>=${start}::timestamptz AND settled_at<${end}::timestamptz))`;
  if (rows[0]?.admitted !== true) throw new Error("The daily UTC AI limit is fully reserved, including work carried over from earlier days.");
}
export async function reserveSelfImprovementPhaseBudget(input: SelfImprovementCycleFence & { phaseId: string; reservedUsd: number }): Promise<{ outcome: "reserved" | "duplicate"; cycle: StoredSelfImprovementCycle; reservation: SelfImprovementPhaseReservation }> {
  const now = nowAt(input.now), phaseId = opaque.parse(input.phaseId), reservedUsd = z.number().finite().positive().max(100).parse(input.reservedUsd);
  return owned(input.owner, async (sql) => {
    const { stored } = await fenced(sql, input, now);
    await requireCycleEffectAuthority(sql, input.owner, stored);
    if (stored.usageState !== "known") throw new Error("Unknown usage holds further paid phases.");
    if (selfImprovementExecutionElapsedMs(stored.cycle.createdAt, stored.runtime, now) >= stored.cycle.policy.maxCycleDurationMs) throw new Error("Self-improvement cycle execution deadline expired.");
    const previous = await sql`SELECT * FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId} AND phase_id=${phaseId}`;
    if (previous[0]) {
      if (Number(previous[0].reserved_usd) !== reservedUsd) throw new Error("Phase budget request changed after admission.");
      return { outcome: "duplicate", cycle: stored, reservation: phaseFromRow(previous[0]) };
    }
    const used = await sql`SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) AS total FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId}`;
    if (Number(used[0].total) + reservedUsd > stored.cycle.dailyReservationUsd) throw new Error("The next phase exceeds the remaining reserved cycle budget.");
    await requireDailyPaidPhaseAllowance(sql, input.owner, now, reservedUsd, stored.cycle.policy.dailyBudgetUsd);
    const rows = await sql`INSERT INTO omni_self_improvement_phase_reservations (tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,actual_usd,state,evidence_sha256,created_at,settled_at) VALUES (${input.owner.tenantId},${input.owner.ownerActorId},${input.cycleId},${phaseId},${reservedUsd},NULL,'reserved',NULL,${now},NULL) RETURNING *`;
    const cycle = { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now };
    const changed = await writeCycle(sql, stored, cycle, stored.runtime, stored.spendUsd, stored.usageState);
    return { outcome: "reserved", cycle: changed, reservation: phaseFromRow(rows[0]) };
  });
}

export async function listRunnableSelfImprovementCyclesForTenant(tenantId: string, limit = 10): Promise<Array<{ ownerActorId: string; cycleId: string }>> {
  await database();
  return runWithDatabaseSystemScope("Discover self-improvement cycle owner and ID for existing durable coding recovery only.", async () => {
    const rows = await getSql()`SELECT owner_actor_id,id FROM omni_self_improvement_cycles WHERE tenant_id=${opaque.parse(tenantId)} AND stage IN ('observing','planned','implementing','validating','correcting') ORDER BY updated_at,id LIMIT ${Math.max(1, Math.min(50, limit))}`;
    return rows.map((row) => ({ ownerActorId: String(row.owner_actor_id), cycleId: String(row.id) }));
  });
}
export async function settleSelfImprovementPhaseBudget(input: SelfImprovementCycleFence & { phaseId: string; actualUsd: number | null; evidenceSha256: string }): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now), phaseId = opaque.parse(input.phaseId), evidenceSha256 = selfImprovementDigestSchema.parse(input.evidenceSha256);
  const actualUsd = input.actualUsd === null ? null : z.number().finite().min(0).max(1_000_000).parse(input.actualUsd);
  return owned(input.owner, async (sql) => {
    const { stored } = await fenced(sql, input, now);
    const previous = await sql`SELECT * FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId} AND phase_id=${phaseId} FOR UPDATE`;
    if (!previous[0]) throw new Error("The paid phase has no admitted budget reservation.");
    const phase = phaseFromRow(previous[0]);
    if (phase.state === "settled") {
      if (phase.actualUsd !== actualUsd || phase.evidenceSha256 !== evidenceSha256) throw new Error("Settled phase usage is immutable.");
      return stored;
    }
    await sql`UPDATE omni_self_improvement_phase_reservations SET state=${actualUsd === null ? "unknown" : "settled"},actual_usd=${actualUsd},evidence_sha256=${evidenceSha256},settled_at=${now} WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId} AND phase_id=${phaseId}`;
    const total = await sql`SELECT COALESCE(SUM(actual_usd),0) AS actual,COUNT(*) FILTER(WHERE state='unknown') AS unknown_count,COUNT(*) FILTER(WHERE actual_usd>reserved_usd) AS exceeded_count FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId}`;
    const spendUsd = Math.max(stored.spendUsd, Number(total[0].actual));
    // Preserve an unexpectedly high real bill instead of hiding it behind a rejected
    // write. The hold forbids another paid phase and retains all reservation evidence.
    const usageState = Number(total[0].unknown_count) || Number(total[0].exceeded_count) || spendUsd > stored.cycle.dailyReservationUsd ? "unknown" as const : "known" as const;
    return writeCycle(sql, stored, { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now }, stored.runtime, spendUsd, usageState);
  });
}

export async function readSelfImprovementReleaseLease(input: { owner: SelfImprovementOwner; cycleId: string; leaseToken: string; controllerId: string; allowCompletedNative?: boolean; now?: string }): Promise<StoredSelfImprovementCycle> {
  assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async (sql) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE id=${input.cycleId} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId}`;
    if (!rows[0]) throw new Error("Release cycle was not found.");
    const stored = cycleFromRow(rows[0]);
    const completedNative = input.allowCompletedNative === true && !!stored.cycle.release?.native && !!stored.cycle.releaseReceipt && ["succeeded", "failed", "rolled_back"].includes(stored.cycle.stage);
    if (stored.controllerId !== input.controllerId || rows[0].lease_token_sha256 !== tokenHash(input.leaseToken) || (!completedNative && Date.parse(stored.leaseExpiresAt) <= Date.parse(nowAt(input.now)))) throw new Error("Release controller lease is stale or belongs to another controller.");
    return stored;
  });
}
/** Recover only settlement authority for an already prepared native publication. No publication may be replayed. */
export async function recoverSelfImprovementNativeReleaseCompletion(input: { owner: SelfImprovementOwner; cycleId: string; leaseToken: string; controllerId: string; releaseBindingSha256: string; now?: string }): Promise<StoredSelfImprovementCycle> {
  assertConfiguredSelfImprovementOwner(input.owner); const now = nowAt(input.now);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE id=${input.cycleId} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Native release was not found.");
    const stored = cycleFromRow(rows[0]);
    await requireAuthority(sql, input.owner, stored.projectId);
    if (stored.controllerId !== input.controllerId || rows[0].lease_token_sha256 !== tokenHash(input.leaseToken)) throw new Error("Native completion recovery requires the exact latest controller token.");
    if (Date.parse(stored.leaseExpiresAt) > Date.parse(now)) throw new Error("The native publication still has a live lease.");
    if (stored.cycle.stage !== "releasing" || stored.cycle.releaseReceipt || stored.cycle.release?.releaseTarget !== "macos_app" || !stored.cycle.release.native || stored.cycle.release.runner !== "asael_macos_publisher" || stored.cycle.release.releaseBindingSha256 !== selfImprovementDigestSchema.parse(input.releaseBindingSha256)) throw new Error("Only the exact prepared native publication can recover completion authority.");
    assertSelfImprovementCycleIntegrity(stored.cycle);
    const runtime = selfImprovementRuntimeSchema.parse({ ...stored.runtime, releaseRecoveryOnly: { version: 1, releaseBindingSha256: input.releaseBindingSha256, controllerId: input.controllerId, recoveredAt: now } });
    const leaseToken = randomUUID(), leaseExpiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    const cycle = { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now };
    const changed = await writeCycle(sql, stored, cycle, runtime, stored.spendUsd, stored.usageState, { tokenSha256: tokenHash(leaseToken), expiresAt: leaseExpiresAt });
    await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.release.completion_recovered", `${cycle.id}:${cycle.revision}:recovery`, { cycleId: cycle.id, controllerId: input.controllerId, releaseBindingSha256: input.releaseBindingSha256, leaseExpiresAt, recoveryOnly: true });
    return { ...changed, leaseToken };
  });
}
export async function claimSelfImprovementReleaseCycle(input: { owner: SelfImprovementOwner; cycleId: string; candidateRevision: string; controllerId: string; pairedBaseline?: z.infer<typeof nativePairedBaselineSchema>; now?: string }): Promise<StoredSelfImprovementCycle & { releaseBudget: { phaseId: string; reservedUsd: number } }> {
  assertConfiguredSelfImprovementOwner(input.owner); const now = nowAt(input.now);
  return owned(input.owner, async (sql) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE id=${input.cycleId} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Release cycle was not found.");
    const stored = cycleFromRow(rows[0]); await requireCycleEffectAuthority(sql, input.owner, stored);
    if (stored.cycle.stage !== "ready_for_release" || stored.cycle.candidate?.revision !== input.candidateRevision || stored.controllerHold || stored.usageState !== "known") throw new Error("The exact candidate is not available for automatic release.");
    if (Date.parse(stored.leaseExpiresAt) > Date.parse(now)) throw new Error("Another execution still holds this candidate.");
    if (stored.controllerId) throw new Error("This release was already claimed and requires reconciliation; deployment cannot be replayed.");
    const phaseId = opaque.parse(`release:${input.controllerId}`);
    const used = await sql`SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) AS total FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId}`;
    const reservedUsd = stored.cycle.candidate.releaseTarget === "macos_app" ? 0 : Math.floor(Math.min(stored.cycle.dailyReservationUsd * 0.1, stored.cycle.dailyReservationUsd - Number(used[0].total)) * 1_000_000) / 1_000_000;
    if (stored.cycle.candidate.releaseTarget !== "macos_app" && reservedUsd < 0.02) throw new Error("The cycle has insufficient reserved budget for the paired release checks.");
    if (reservedUsd > 0) {
    await requireDailyPaidPhaseAllowance(sql, input.owner, now, reservedUsd, stored.cycle.policy.dailyBudgetUsd);
    await sql`INSERT INTO omni_self_improvement_phase_reservations (tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,actual_usd,state,evidence_sha256,created_at,settled_at) VALUES (${input.owner.tenantId},${input.owner.ownerActorId},${input.cycleId},${phaseId},${reservedUsd},NULL,'reserved',NULL,${now},NULL)`;
    }
    const leaseToken = randomUUID(), leaseExpiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    const cycle = { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now };
    assertSelfImprovementCycleIntegrity(cycle);
    const releaseRuntime = input.pairedBaseline ? { ...stored.runtime, releasePairedBaseline: nativePairedBaselineSchema.parse(input.pairedBaseline) } : stored.runtime;
    const changed = await sql`UPDATE omni_self_improvement_cycles SET runtime=${releaseRuntime}::jsonb,release_controller_id=${opaque.parse(input.controllerId)},lease_token_sha256=${tokenHash(leaseToken)},lease_expires_at=${leaseExpiresAt},revision=${cycle.revision},snapshot=${cycle}::jsonb,updated_at=${now} WHERE id=${cycle.id} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND revision=${stored.cycle.revision} RETURNING *`;
    await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.release.claimed", `${cycle.id}:${cycle.revision}`, { cycleId: cycle.id, controllerId: input.controllerId, candidateRevision: input.candidateRevision, policySha256: cycle.policy.policySha256, releaseBudget: { phaseId, reservedUsd } });
    return { ...cycleFromRow(changed[0]), leaseToken, releaseBudget: { phaseId, reservedUsd } };
  });
}
export async function holdSelfImprovementRelease(input: { owner: SelfImprovementOwner; cycleId: string; candidateRevision: string; controllerId: string; category: string; now?: string }): Promise<StoredSelfImprovementCycle> {
  assertConfiguredSelfImprovementOwner(input.owner); const now = nowAt(input.now), category = z.string().regex(/^[a-z0-9_]{1,120}$/).parse(input.category);
  return owned(input.owner, async (sql) => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE id=${input.cycleId} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Release cycle was not found.");
    const stored = cycleFromRow(rows[0]);
    if (stored.cycle.candidate?.revision !== input.candidateRevision || !["ready_for_release", "releasing"].includes(stored.cycle.stage) || (stored.controllerId && stored.controllerId !== input.controllerId)) throw new Error("Controller hold does not match this release.");
    if (stored.controllerHold) return stored;
    const cycle = { ...stored.cycle, revision: stored.cycle.revision + 1, updatedAt: now };
    const heldEvent = await event(sql, { id: stored.configurationId, ...input.owner, projectId: stored.projectId }, "self_improvement.release.held", `${cycle.id}:${cycle.revision}`, { cycleId: cycle.id, category, stage: cycle.stage, automaticRetry: false });
    const hold = { category, occurredAt: heldEvent.at };
    const changed = await sql`UPDATE omni_self_improvement_cycles SET controller_hold=${hold}::jsonb,revision=${cycle.revision},snapshot=${cycle}::jsonb,updated_at=${now} WHERE id=${cycle.id} AND tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND revision=${stored.cycle.revision} RETURNING *`;
    const { admitSelfImprovementNotificationWithSql } = await import("./notifications");
    await admitSelfImprovementNotificationWithSql(sql, { tenantId: input.owner.tenantId, actorId: input.owner.ownerActorId,
      cycleId: cycle.id, eventId: heldEvent.id, eventType: "self_improvement.release.held", stage: cycle.stage, category, occurredAt: heldEvent.at });
    return cycleFromRow(changed[0]);
  });
}

export async function recordSelfImprovementControllerPresence(owner: SelfImprovementOwner, input: { controllerId: string; status: "online" | "held"; category?: string }): Promise<void> {
  assertConfiguredSelfImprovementOwner(owner);
  await owned(owner, async (sql) => {
    const now = new Date().toISOString(), controllerId = opaque.parse(input.controllerId), category = input.category ? z.string().regex(/^[a-z0-9_]{1,120}$/).parse(input.category) : null;
    await sql`UPDATE omni_self_improvement_configurations SET controller_id=${controllerId},controller_last_seen_at=${now},controller_status=${input.status},controller_category=${category} WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId}`;
  });
}
export async function readSelfImprovementControllerPresence(owner: SelfImprovementOwner): Promise<{ lastSeenAt: string; controllerStatus: "online" | "held"; category?: string } | null> {
  return owned(owner, async (sql) => {
    const rows = await sql`SELECT controller_last_seen_at,controller_status,controller_category FROM omni_self_improvement_configurations WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND controller_last_seen_at IS NOT NULL ORDER BY controller_last_seen_at DESC LIMIT 1`;
    if (!rows[0]) return null;
    return { lastSeenAt: stamp(rows[0].controller_last_seen_at), controllerStatus: z.enum(["online", "held"]).parse(rows[0].controller_status), ...(rows[0].controller_category ? { category: String(rows[0].controller_category) } : {}) };
  });
}

export type SelfImprovementNativeLease = { owner: SelfImprovementOwner; cycleId: string; requestId: string; controllerId: string; leaseToken: string; now?: string; allowExpired?: boolean };
function activeNativeRequest(stored: StoredSelfImprovementCycle, requestId: string) {
  const runtime = selfImprovementRuntimeSchema.parse(stored.runtime);
  const entry = runtime.native?.requests.find(item => item.request.requestId === requestId);
  if (runtime.plan?.releaseTarget !== "macos_app" || runtime.native?.activeRequestId !== requestId || !entry || !["planned", "validating"].includes(stored.cycle.stage)) throw new Error("The exact native validation request is not active.");
  return { runtime, entry };
}
export async function claimSelfImprovementNativeValidation(input: { owner: SelfImprovementOwner; cycleId: string; requestId: string; requestSha256: string; controllerId: string; now?: string }) {
  const now = nowAt(input.now);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Native validation cycle was not found.");
    const before = cycleFromRow(rows[0]);
    await requireCycleEffectAuthority(sql, input.owner, before);
    const { runtime, entry } = activeNativeRequest(before, input.requestId);
    if (entry.status !== "queued" || entry.request.requestSha256 !== input.requestSha256 || before.usageState !== "known" || Date.parse(before.leaseExpiresAt) > Date.parse(now) || Date.parse(entry.request.expiresAt) <= Date.parse(now)) throw new Error("Native validation is claimed, held, expired or has changed.");
    const leaseToken = randomUUID(), expiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    entry.status = "claimed"; entry.controllerId = opaque.parse(input.controllerId); entry.claimedAt = now;
    const cycle = { ...before.cycle, revision: before.cycle.revision + 1, updatedAt: now };
    const changed = await writeCycle(sql, before, cycle, selfImprovementRuntimeSchema.parse(runtime), before.spendUsd, before.usageState, { tokenSha256: tokenHash(leaseToken), expiresAt });
    await event(sql, { id: before.configurationId, ...input.owner, projectId: before.projectId }, "self_improvement.native_validation.claimed", `${cycle.id}:${cycle.revision}:native`, { cycleId: cycle.id, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256, controllerId: entry.controllerId });
    return { cycle: { ...changed, leaseToken }, request: entry.request };
  });
}
export async function readSelfImprovementNativeLease(input: SelfImprovementNativeLease) {
  const now = nowAt(input.now);
  assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Native validation cycle was not found.");
    const before = cycleFromRow(rows[0]);
    if (input.allowExpired) {
      if (rows[0].lease_token_sha256 !== tokenHash(input.leaseToken) || isSelfImprovementTerminalStage(before.cycle.stage)) throw new Error("The exact retained native lease token is required for reconciliation.");
    } else await fenced(sql, { ...input, expectedRevision: before.cycle.revision }, now);
    const { runtime, entry } = activeNativeRequest(before, input.requestId);
    if (entry.status !== "claimed" || entry.controllerId !== input.controllerId || Date.parse(entry.request.expiresAt) <= Date.parse(now)) throw new Error("Native validation claim is stale or belongs to another publisher.");
    return { stored: before, runtime, entry };
  });
}
export async function finishSelfImprovementNativeValidation(input: SelfImprovementNativeLease & { receipt?: NativeValidationReceipt; holdCategory?: string }) {
  const now = nowAt(input.now); assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Native validation cycle was not found.");
    const before = cycleFromRow(rows[0]);
    await fenced(sql, { ...input, expectedRevision: before.cycle.revision }, now);
    const { runtime, entry } = activeNativeRequest(before, input.requestId);
    if (entry.status !== "claimed" || entry.controllerId !== input.controllerId) throw new Error("Native validation claim cannot be replayed.");
    if (input.receipt) {
      const receipt = nativeValidationReceiptSchema.parse(input.receipt);
      assertNativeValidationReceipt(entry.request, receipt);
      if (receipt.controllerId !== input.controllerId || Date.parse(receipt.completedAt) < Date.parse(entry.claimedAt!)) throw new Error("Native completion predates its current claim.");
      if (entry.request.purpose === "candidate") {
        const baseline = runtime.native!.requests.find(item => item.request.purpose === "baseline" && item.status === "completed")?.receipt;
        if (!baseline || baseline.toolchainSha256 !== receipt.toolchainSha256 || baseline.builderProfileSha256 !== receipt.builderProfileSha256 || baseline.installedBaseline.baselineSha256 !== receipt.installedBaseline.baselineSha256 || JSON.stringify(baseline.pairedBaseline) !== JSON.stringify(receipt.pairedBaseline)) throw new Error("Native candidate validation changed the baseline app, toolchain or server pair.");
      }
      entry.receipt = receipt; entry.status = "completed";
    } else {
      entry.holdCategory = z.string().regex(/^[a-z0-9_]{1,120}$/).parse(input.holdCategory); entry.status = "held";
    }
    const native = runtime.native!;
    if (native.waitStartedAt) native.waitedMs = Math.min(86_400_000, native.waitedMs + Math.max(0, Date.parse(now) - Date.parse(native.waitStartedAt)));
    native.waitStartedAt = null;
    const cycle = { ...before.cycle, revision: before.cycle.revision + 1, updatedAt: now };
    const changed = await writeCycle(sql, before, cycle, selfImprovementRuntimeSchema.parse(runtime), before.spendUsd, before.usageState, { tokenSha256: tokenHash(randomUUID()), expiresAt: now });
    await event(sql, { id: before.configurationId, ...input.owner, projectId: before.projectId }, `self_improvement.native_validation.${entry.status}`, `${cycle.id}:${cycle.revision}:native`, { cycleId: cycle.id, stage: cycle.stage, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256, receiptSha256: entry.receipt?.receiptSha256 ?? null, category: entry.holdCategory });
    if (entry.status === "held") {
      const { admitSelfImprovementNotificationWithSql } = await import("./notifications");
      await admitSelfImprovementNotificationWithSql(sql, { tenantId: input.owner.tenantId, actorId: input.owner.ownerActorId,
        cycleId: cycle.id, eventId: `${cycle.id}:${cycle.revision}:native`, eventType: "self_improvement.native_validation.held", stage: cycle.stage,
        category: entry.holdCategory!, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256, occurredAt: now });
    }
    return changed;
  });
}

/** Expired keyless validation never runs twice. Preserve its claim as a held occurrence for the owner. */
export async function holdExpiredSelfImprovementNativeValidation(input: { owner: SelfImprovementOwner; cycleId: string; requestId: string; requestSha256: string; now?: string }): Promise<{ outcome: "held" | "unchanged"; cycle: StoredSelfImprovementCycle }> {
  const now = nowAt(input.now); assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("Native validation cycle was not found.");
    const before = cycleFromRow(rows[0]);
    await requireAuthority(sql, input.owner, before.projectId);
    if (isSelfImprovementTerminalStage(before.cycle.stage)) return { outcome: "unchanged", cycle: before };
    const { runtime, entry } = activeNativeRequest(before, input.requestId);
    if (entry.request.requestSha256 !== input.requestSha256) throw new Error("The expired native request binding changed.");
    if (entry.status !== "claimed" || Date.parse(entry.request.expiresAt) > Date.parse(now) || Date.parse(before.leaseExpiresAt) > Date.parse(now)) return { outcome: "unchanged", cycle: before };
    entry.status = "held"; entry.holdCategory = "native_validation_expired";
    const native = runtime.native!;
    if (native.waitStartedAt) native.waitedMs = Math.min(86_400_000, native.waitedMs + Math.max(0, Date.parse(now) - Date.parse(native.waitStartedAt)));
    native.waitStartedAt = null;
    const cycle = { ...before.cycle, revision: before.cycle.revision + 1, updatedAt: now };
    const changed = await writeCycle(sql, before, cycle, runtime, before.spendUsd, before.usageState, { tokenSha256: tokenHash(randomUUID()), expiresAt: now });
    await event(sql, { id: before.configurationId, ...input.owner, projectId: before.projectId }, "self_improvement.native_validation.held", `${cycle.id}:${cycle.revision}:native`, { cycleId: cycle.id, stage: cycle.stage, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256, receiptSha256: null, category: entry.holdCategory });
    const { admitSelfImprovementNotificationWithSql } = await import("./notifications");
    await admitSelfImprovementNotificationWithSql(sql, { tenantId: input.owner.tenantId, actorId: input.owner.ownerActorId, cycleId: cycle.id,
      eventId: `${cycle.id}:${cycle.revision}:native`, eventType: "self_improvement.native_validation.held", stage: cycle.stage,
      category: entry.holdCategory, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256, occurredAt: now });
    return { outcome: "held", cycle: changed };
  });
}

export function canStopSelfImprovementNativeCheck(stored: StoredSelfImprovementCycle, now = new Date().toISOString()): boolean {
  const runtime = selfImprovementRuntimeSchema.safeParse(stored.runtime);
  const entry = runtime.success ? runtime.data.native?.requests.find(item => item.request.requestId === runtime.data.native?.activeRequestId) : undefined;
  return Boolean(entry?.status === "held" && ["planned", "validating"].includes(stored.cycle.stage) && !stored.controllerId && !stored.cycle.release && !stored.cycle.releaseReceipt && stored.usageState === "known" && stored.unsettledPaidUsage === false && Date.parse(stored.leaseExpiresAt) <= Date.parse(now) && runtime.success && !runtime.data.phaseAttempt);
}
export async function stopSelfImprovementNativeCheck(input: { owner: SelfImprovementOwner; cycleId: string; expectedRevision: number; requestId: string; requestSha256: string; now?: string }): Promise<StoredSelfImprovementCycle> {
  const now = nowAt(input.now); assertConfiguredSelfImprovementOwner(input.owner);
  return owned(input.owner, async sql => {
    const rows = await sql`SELECT * FROM omni_self_improvement_cycles WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND id=${input.cycleId} FOR UPDATE`;
    if (!rows[0]) throw new Error("The native check cycle was not found.");
    let before = cycleFromRow(rows[0]); await requireAuthority(sql, input.owner, before.projectId);
    const { entry } = activeNativeRequest(before, input.requestId);
    const unresolved = await sql`SELECT phase_id FROM omni_self_improvement_phase_reservations WHERE tenant_id=${input.owner.tenantId} AND owner_actor_id=${input.owner.ownerActorId} AND cycle_id=${input.cycleId} AND state<>'settled' LIMIT 1`;
    if (unresolved.length) throw new Error("Unsettled paid usage must be reconciled before stopping this check.");
    before = { ...before, unsettledPaidUsage: false };
    if (before.cycle.revision !== input.expectedRevision || entry.request.requestSha256 !== input.requestSha256 || !canStopSelfImprovementNativeCheck(before, now)) throw new Error("The exact held native check is no longer available to stop.");
    const cycle = { ...before.cycle, stage: "cancelled" as const, revision: before.cycle.revision + 1, updatedAt: now };
    assertSelfImprovementCycleTransition(before.cycle, cycle);
    const changed = await writeCycle(sql, before, cycle, before.runtime, before.spendUsd, before.usageState);
    await event(sql, { id: before.configurationId, ...input.owner, projectId: before.projectId }, "self_improvement.native_validation.stopped", `${cycle.id}:${cycle.revision}:native`, { cycleId: cycle.id, stage: cycle.stage, requestId: entry.request.requestId, requestSha256: entry.request.requestSha256 });
    return changed;
  });
}
