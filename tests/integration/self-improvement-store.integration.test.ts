/** Explicit opt-in: real runtime RLS, leases and budgets on a disposable loopback database. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createStudioProject } from "@/lib/studio/projects";
import { studioProjectProfileDefaults } from "@/lib/studio/contracts";
import type { SecurityContext } from "@/lib/security/types";
import { withAvailabilityOwner } from "@/lib/availability-watches/store";
import { admitSelfImprovementNotificationWithSql } from "@/lib/self-improvement/notifications";
import { createBuilderSessionRecord, resetSourceOnlyBuilderSessionRecord, transitionBuilderSession } from "@/lib/app-builder/store";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
import { withSyntheticCriterionReview } from "@/lib/self-improvement/review-release-test-fixtures";
import { appendDomainEvent } from "@/lib/events/store";
import { createExecutionScope, parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { governedToolExecutionId } from "@/lib/tools/execution-id";
import { toolExecutionScopeBoundEvent, toolInputSha256 } from "@/lib/tools/execution-scope";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import { getSelfImprovementSetupRetry, retryPreAiSelfImprovementCycle } from "@/lib/self-improvement/store";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { selfImprovementPolicySchema, selfImprovementSha256, sealSelfImprovementApproval, sealSelfImprovementCandidate, sealSelfImprovementValidation, sealSelfImprovementReleaseBinding } from "@/lib/self-improvement/contracts";
import { assertSelfImprovementOwnerAuthority, discardHeldSelfImprovementCandidate, reviewExpiredSelfImprovementApproval, claimSelfImprovementReleaseCycle, holdSelfImprovementRelease, readSelfImprovementReleaseLease, recordSelfImprovementControllerPresence, readSelfImprovementControllerPresence } from "@/lib/self-improvement/store";
import { claimDueSelfImprovementCycles, claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementConfiguration, getSelfImprovementCycle, listDueSelfImprovementConfigurations, pauseSelfImprovement, releaseSelfImprovementExecutionLease, renewSelfImprovementCycleLease, reserveSelfImprovementPhaseBudget, settleSelfImprovementPhaseBudget, transitionSelfImprovementCycle, updateSelfImprovementCycleRuntime, type SelfImprovementConfiguration, type StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
const setup = vi.hoisted(() => ({ serving: false }));
vi.mock("@/lib/db/client", async (original) => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
async function persistSyntheticReview(stored: StoredSelfImprovementCycle, artifact: ReturnType<typeof sealSelfImprovementCandidate>, validation: ReturnType<typeof sealSelfImprovementValidation>, leaseToken: string, now: string) {
  const reviewed = withSyntheticCriterionReview({ ...stored, cycle: { ...stored.cycle, candidate: artifact, validation } });
  const updated = await updateSelfImprovementCycleRuntime({ owner: { tenantId: stored.cycle.scope.tenantId, ownerActorId: stored.cycle.scope.ownerActorId }, cycleId: stored.cycle.id,
    expectedRevision: stored.cycle.revision, leaseToken, now, runtime: reviewed.runtime,
    patch: { builderSessionId: reviewed.cycle.builderSessionId, checkpointId: reviewed.cycle.checkpointId, verificationId: reviewed.cycle.verificationId } });
  return { stored: updated, validation: reviewed.cycle.validation! };
}
const tenantId = `self-improvement-candidate-${randomUUID()}`;
const actors = [randomUUID(), randomUUID()].map((userId) => ({ userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` }));
const role = `self_improvement_${randomBytes(6).toString("hex")}`;
const repository = { owner: "isolated-candidate", name: `app-${randomBytes(4).toString("hex")}`, defaultBranch: "main" };
const repositoryId = String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16));
const now = "2026-10-26T12:00:00.000Z", evidenceSha256 = "a".repeat(64);
const context = (actor: typeof actors[number]): SecurityContext => ({ tenantId, actorId: actor.email, source: "session", role: "operator", auth: { userId: actor.userId, email: actor.email, sessionId: "isolated-no-login", tenantName: "Self-improvement candidate" } });
const scoped = <T>(actor: typeof actors[number], run: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.ownerActorId, actor.email], run);
candidate("Self-improvement PostgreSQL candidate", () => {
  let admin: ReturnType<typeof postgres>;
  const configs: SelfImprovementConfiguration[] = [];
  let winner = 0, stored: StoredSelfImprovementCycle;
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the disposable self-improvement candidate URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the disposable loopback self-improvement database is allowed.");
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(266);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts TO ${role}`);
    await admin.unsafe(`GRANT UPDATE ON omni_tool_executions TO ${role}`); // FOR SHARE fences the exact failed receipt against reclamation.
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships,omni_today_preferences TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_personal_notifications,omni_notification_dispositions,omni_app_builder_sessions,omni_app_builder_events TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_mobile_push_registrations,omni_mobile_sessions,omni_web_push_registrations,omni_auth_sessions TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Self-improvement candidate',${tenantId})`;
    for (const actor of actors) {
      await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${actor.userId},${actor.email},'synthetic-no-login')`;
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${actor.userId},'admin')`;
      await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,notifications_enabled,quiet_hours_enabled,timezone,quiet_hours_start,quiet_hours_end) VALUES(${tenantId},${actor.ownerActorId},TRUE,FALSE,'UTC','00:00','23:59')`;
    }
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4"); setup.serving = true;
    for (const actor of actors) {
      vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actor.ownerActorId);
      await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
      const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Self-improvement isolated project", profile: studioProjectProfileDefaults("ai-tech", "Synthetic engineering") }, randomUUID()));
      // Different display names with one immutable provider ID model a repository rename.
      configs.push(await configureSelfImprovement({ tenantId, ownerActorId: actor.ownerActorId, projectId: project.id, repositoryId, repository: { ...repository, name: `${repository.name}-${configs.length}` }, policy: createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 }), now, nextDueAt: now }));
    }
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it("admits one repository cycle across concurrent owners and isolates readback", async () => {
    const outcomes = await Promise.all(configs.map((config) => {
      // Each admission captures the exact configured operator at request entry.
      vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", config.ownerActorId);
      return claimManualSelfImprovementCycle({ owner: { tenantId, ownerActorId: config.ownerActorId }, configurationId: config.id, expectedGeneration: config.generation, baseRevision: "b".repeat(40), idempotencyKey: "initial", now: "2026-10-27T02:00:00.000+14:00" });
    }));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["busy", "claimed"]);
    winner = outcomes.findIndex((result) => result.outcome === "claimed"); stored = outcomes[winner].cycle!;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actors[winner].ownerActorId);
    expect(stored.leaseToken).toBeTruthy();
    expect(stored.day).toBe("2026-10-26"); expect(stored.cycle.createdAt).toBe(now);
    expect(await getSelfImprovementCycle({ tenantId, ownerActorId: actors[1 - winner].ownerActorId }, stored.cycle.id)).toBeNull();
    expect(await scoped(actors[winner], async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_self_improvement_cycles') AS active FROM pg_roles WHERE rolname=current_user`)[0])).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    const input = { owner: { tenantId, ownerActorId: actors[winner].ownerActorId }, configurationId: configs[winner].id, expectedGeneration: 1, baseRevision: "b".repeat(40), idempotencyKey: "initial", now };
    const duplicate = await claimManualSelfImprovementCycle(input);
    expect(duplicate.outcome).toBe("duplicate"); expect(duplicate.cycle?.leaseToken).toBeUndefined();
    await expect(claimManualSelfImprovementCycle({ ...input, baseRevision: "c".repeat(40) })).rejects.toThrow(/idempotency/);
  });
  it("fences stale workers and renews after execution yield without releasing the repository", async () => {
    const owner = { tenantId, ownerActorId: actors[winner].ownerActorId }, token = stored.leaseToken!, staleRevision = stored.cycle.revision;
    stored = await updateSelfImprovementCycleRuntime({ owner, cycleId: stored.cycle.id, expectedRevision: staleRevision, leaseToken: token, now, runtime: { phase: "inspect" } });
    await expect(updateSelfImprovementCycleRuntime({ owner, cycleId: stored.cycle.id, expectedRevision: staleRevision, leaseToken: token, now, runtime: {} })).rejects.toThrow(/stale/);
    stored = await releaseSelfImprovementExecutionLease({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: token, now });
    stored = await renewSelfImprovementCycleLease({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, now });
    expect(stored.leaseToken).not.toBe(token);
    await expect(updateSelfImprovementCycleRuntime({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: token, now, runtime: {} })).rejects.toThrow(/stale/);
  });
  it("reserves before paid phases, retains ambiguous usage, and cannot reset the daily ceiling by pausing", async () => {
    const owner = { tenantId, ownerActorId: actors[winner].ownerActorId }, token = stored.leaseToken!;
    const fence = () => ({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: token, now });
    stored = (await reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "inspect", reservedUsd: 70 })).cycle;
    expect((await reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "inspect", reservedUsd: 70 })).outcome).toBe("duplicate");
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "implementation", reservedUsd: 40 })).rejects.toThrow(/remaining/);
    stored = await settleSelfImprovementPhaseBudget({ ...fence(), phaseId: "inspect", actualUsd: 5, evidenceSha256 });
    stored = (await reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "implementation", reservedUsd: 95 })).cycle;
    stored = await settleSelfImprovementPhaseBudget({ ...fence(), phaseId: "implementation", actualUsd: null, evidenceSha256 });
    expect(stored).toMatchObject({ spendUsd: 5, usageState: "unknown" });
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "retry", reservedUsd: 1 })).rejects.toThrow(/Unknown usage/);
    stored = await transitionSelfImprovementCycle({ ...fence(), nextStage: "failed" });
    const paused = await pauseSelfImprovement({ owner, configurationId: configs[winner].id, expectedGeneration: 1, paused: true, now });
    const resumed = await pauseSelfImprovement({ owner, configurationId: configs[winner].id, expectedGeneration: paused.generation, paused: false, now });
    expect((await claimManualSelfImprovementCycle({ owner, configurationId: resumed.id, expectedGeneration: resumed.generation, baseRevision: "b".repeat(40), idempotencyKey: "after-resume", now })).outcome).toBe("budget_exhausted");
    await expect(scoped(actors[winner], () => getSql()`DELETE FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId}`)).rejects.toThrow();
  });
  it("keeps an uncertain release locked after lease expiry and reports real controller presence", async () => {
    const index = 1 - winner, owner = { tenantId, ownerActorId: actors[index].ownerActorId }, config = configs[index];
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    let release = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation, baseRevision: "b".repeat(40), idempotencyKey: "release", now })).cycle!;
    const token = release.leaseToken!, scope = release.cycle.scope;
    const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", summary: "Synthetic title repair", symptomSha256: "a".repeat(64), observations: [{ sourceKind: "owner_feedback", sourceId: "fixture", sourceSha256: "b".repeat(64), observedAt: now, outcome: "needs_work" }] });
    const artifact = sealSelfImprovementCandidate({ revision: "c".repeat(40), workspaceSha256: "a".repeat(64), diffSha256: "b".repeat(64), changedFiles: [{ path: "src/lib/studio/graph.ts", beforeSha256: "c".repeat(64), afterSha256: "d".repeat(64) }], changedLines: 3, architectureImpact: "major" });
    let validation = sealSelfImprovementValidation({ scope, policySha256: release.cycle.policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: artifact.candidateSha256, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map((kind) => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: kind, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, evidenceSha256, declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: now })) });
    const fence = () => ({ owner, cycleId: release.cycle.id, expectedRevision: release.cycle.revision, leaseToken: token, now });
    release = await transitionSelfImprovementCycle({ ...fence(), nextStage: "planned", patch: { signal } });
    release = await transitionSelfImprovementCycle({ ...fence(), nextStage: "implementing" });
    release = await transitionSelfImprovementCycle({ ...fence(), nextStage: "validating" });
    ({ stored: release, validation } = await persistSyntheticReview(release, artifact, validation, token, now));
    const approval = sealSelfImprovementApproval({ approvalId: "initial-owner-review", ...owner, candidateSha256: artifact.candidateSha256,
      validationSha256: validation.validationSha256, policySha256: release.cycle.policy.policySha256, decision: "approved", approvedAt: now, expiresAt: "2026-10-26T12:01:00.000Z" });
    release = await transitionSelfImprovementCycle({ ...fence(), nextStage: "ready_for_release", patch: { candidate: artifact, validation, approval, pullRequestUrl: "https://github.com/isolated-candidate/app/pull/1" } });
    release = await releaseSelfImprovementExecutionLease(fence());
    const paused = await pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: config.generation, paused: true, now });
    await expect(claimSelfImprovementReleaseCycle({ owner, cycleId: release.cycle.id, candidateRevision: artifact.revision, controllerId: "controller", now })).rejects.toThrow(/paused/);
    const resumed = await pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: paused.generation, paused: false, now });
    expect(resumed.generation).toBeGreaterThan(release.configurationGeneration);
    const resumedAt = "2026-10-26T12:02:00.000Z";
    await expect(claimSelfImprovementReleaseCycle({ owner, cycleId: release.cycle.id, candidateRevision: artifact.revision, controllerId: "controller", now: resumedAt })).rejects.toThrow(/approval/);
    const { receiptSha256: _priorApprovalSha256, ...approvalBody } = approval;
    const renewedApproval = sealSelfImprovementApproval({ ...approvalBody, approvalId: "renewed-owner-review", approvedAt: resumedAt, expiresAt: "2026-10-26T13:00:00.000Z" });
    const renewal = { owner, cycleId: release.cycle.id, expectedRevision: release.cycle.revision, candidateSha256: artifact.candidateSha256,
      validationSha256: validation.validationSha256, decision: "approve" as const, approval: renewedApproval, now: resumedAt };
    await expect(reviewExpiredSelfImprovementApproval({ ...renewal, candidateSha256: "f".repeat(64) })).rejects.toThrow(/not awaiting/);
    release = await reviewExpiredSelfImprovementApproval(renewal);
    expect(release.cycle).toMatchObject({ stage: "ready_for_release", candidate: artifact, validation, approval: renewedApproval, dailyReservationUsd: 100 });
    await expect(reviewExpiredSelfImprovementApproval(renewal)).rejects.toThrow(/not awaiting/);
    const claimedRelease = await claimSelfImprovementReleaseCycle({ owner, cycleId: release.cycle.id, candidateRevision: artifact.revision, controllerId: "controller", now: resumedAt });
    release = claimedRelease;
    expect(claimedRelease.releaseBudget).toEqual({ phaseId: "release:controller", reservedUsd: 10 });
    const releaseToken = release.leaseToken!;
    const binding = sealSelfImprovementReleaseBinding({ releaseId: "release", scope, previousRevision: scope.baseRevision, sourceCandidateRevision: artifact.revision, candidateRevision: "d".repeat(40), sourceTree: "e".repeat(40), mergedTree: "e".repeat(40), pullRequestUrl: release.cycle.pullRequestUrl!, candidateSha256: artifact.candidateSha256, policySha256: release.cycle.policy.policySha256, validationSha256: validation.validationSha256, runner: "asael_paired_production" });
    release = await transitionSelfImprovementCycle({ ...fence(), now: resumedAt, leaseToken: releaseToken, nextStage: "releasing", patch: { release: binding } });
    await pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: resumed.generation, paused: true, now: resumedAt });
    await expect(readSelfImprovementReleaseLease({ owner, cycleId: release.cycle.id, leaseToken: releaseToken, controllerId: "other", now })).rejects.toThrow(/another controller/);
    const recovered = await renewSelfImprovementCycleLease({ owner, cycleId: release.cycle.id, expectedRevision: release.cycle.revision, now: "2026-10-26T12:08:00.000Z" });
    expect(recovered.cycle.stage).toBe("releasing");
    await expect(transitionSelfImprovementCycle({ owner, cycleId: recovered.cycle.id, expectedRevision: recovered.cycle.revision, leaseToken: recovered.leaseToken!, now: "2026-10-26T12:08:00.000Z", nextStage: "failed" })).rejects.toThrow(/uncertain/);
    const unmetered = await settleSelfImprovementPhaseBudget({ owner, cycleId: recovered.cycle.id, expectedRevision: recovered.cycle.revision, leaseToken: recovered.leaseToken!, now: "2026-10-26T12:08:00.000Z", phaseId: claimedRelease.releaseBudget.phaseId, actualUsd: null, evidenceSha256 });
    expect(unmetered.usageState).toBe("unknown"); expect(unmetered.cycle.stage).toBe("releasing");
    const held = await holdSelfImprovementRelease({ owner, cycleId: release.cycle.id, candidateRevision: artifact.revision, controllerId: "controller", category: "outcome_unconfirmed", now: "2026-10-26T12:08:00.000Z" });
    expect(held.cycle.stage).toBe("releasing");
    expect(await scoped(actors[index], () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId} AND source_id=${held.cycle.id}`)).toHaveLength(1);
    await withAvailabilityOwner({ tenantId, actorId: owner.ownerActorId }, sql => admitSelfImprovementNotificationWithSql(sql, { tenantId, actorId: owner.ownerActorId, cycleId: held.cycle.id, eventId: `${held.cycle.id}:${held.cycle.revision}`, eventType: "self_improvement.release.held", stage: "releasing", category: "outcome_unconfirmed", occurredAt: held.controllerHold!.occurredAt }));
    expect(await scoped(actors[index], () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId} AND source_id=${held.cycle.id}`)).toHaveLength(1);
    await recordSelfImprovementControllerPresence(owner, { controllerId: "controller", status: "held", category: "outcome_unconfirmed" });
    expect(await readSelfImprovementControllerPresence(owner)).toMatchObject({ controllerStatus: "held", category: "outcome_unconfirmed" });
  });
  it("persists the next local schedule when hour or zone changes, preserving unchanged due work", async () => {
    const owner = { tenantId, ownerActorId: actors[winner].ownerActorId };
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    const previous = (await getSelfImprovementConfiguration(owner, configs[winner].id))!;
    const changed = await configureSelfImprovement({ ...owner, projectId: previous.projectId, repositoryId, repository: previous.repository,
      policy: previous.policy, expectedGeneration: previous.generation, timeZone: "Asia/Kolkata", dailyHour: 19, now });
    expect(changed.nextDueAt).toBe("2026-10-26T13:30:00.000Z");
    expect((await getSelfImprovementConfiguration(owner, changed.id))?.nextDueAt).toBe(changed.nextDueAt);
    const unchanged = await configureSelfImprovement({ ...owner, projectId: changed.projectId, repositoryId, repository: changed.repository,
      policy: changed.policy, expectedGeneration: changed.generation, timeZone: "Asia/Kolkata", dailyHour: 19, now: "2026-10-26T14:00:00.000Z" });
    expect(unchanged.nextDueAt).toBe(changed.nextDueAt);
    const zoned = await configureSelfImprovement({ ...owner, projectId: changed.projectId, repositoryId, repository: changed.repository,
      policy: changed.policy, expectedGeneration: unchanged.generation, timeZone: "UTC", dailyHour: 19, now: "2026-10-26T14:00:00.000Z" });
    expect(zoned.nextDueAt).toBe("2026-10-26T19:00:00.000Z");
  });
  it("skips an already reserved UTC day once and keeps the next scheduled cycle at the local hour", async () => {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` };
    const owner = { tenantId, ownerActorId: actor.ownerActorId };
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Isolated local schedule", profile: studioProjectProfileDefaults("ai-tech", "Synthetic scheduling") }, randomUUID()));
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: `${repositoryId}2`, repository,
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 10 }), timeZone: "Asia/Kolkata", dailyHour: 3, now });
    const trialRequest = { owner, configurationId: configuration.id, expectedGeneration: configuration.generation,
      baseRevision: "b".repeat(40), idempotencyKey: "manual-trial", now };
    const trial = (await claimManualSelfImprovementCycle(trialRequest)).cycle!;
    await transitionSelfImprovementCycle({ owner, cycleId: trial.cycle.id, expectedRevision: trial.cycle.revision, leaseToken: trial.leaseToken!, nextStage: "no_change", now });
    const upgraded = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: configuration.repositoryId, repository,
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 100 }), expectedGeneration: configuration.generation, timeZone: "Asia/Kolkata", dailyHour: 3, now });
    expect((await claimManualSelfImprovementCycle(trialRequest)).outcome).toBe("duplicate");
    await expect(claimManualSelfImprovementCycle({ ...trialRequest, baseRevision: "c".repeat(40) })).rejects.toThrow(/idempotency/);
    expect((await claimManualSelfImprovementCycle({ ...trialRequest, expectedGeneration: upgraded.generation, idempotencyKey: "manual-again" })).outcome).toBe("budget_exhausted");
    const dueAt = "2026-10-26T21:30:00.000Z", nextDueAt = "2026-10-27T21:30:00.000Z";
    expect((await getSelfImprovementConfiguration(owner, configuration.id))?.nextDueAt).toBe(dueAt);
    const target = { configurationId: configuration.id, ownerActorId: owner.ownerActorId, expectedGeneration: upgraded.generation, baseRevision: "b".repeat(40) };
    const skipped = await Promise.all([0, 1].map(() => claimDueSelfImprovementCycles({ tenantId, targets: [target], now: dueAt })));
    expect(skipped.map(([claim]) => claim.outcome).sort()).toEqual(["budget_exhausted", "not_due"]);
    expect((await getSelfImprovementConfiguration(owner, configuration.id))?.nextDueAt).toBe(nextDueAt);
    expect((await listDueSelfImprovementConfigurations({ tenantId, now: "2026-10-27T00:00:00.000Z", limit: 20 })).some(item => item.id === configuration.id)).toBe(false);
    expect((await claimDueSelfImprovementCycles({ tenantId, targets: [target], now: "2026-10-27T00:00:00.000Z" }))[0].outcome).toBe("not_due");
    const skippedEvents = await scoped(actor, () => getSql()`SELECT payload FROM omni_events WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId} AND stream_id=${`self-improvement:${configuration.id}`} AND type='self_improvement.schedule.skipped'`);
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].payload).toMatchObject({ reason: "utc_day_already_reserved", dueAt, nextDueAt, budgetDay: "2026-10-26", reservedUsd: 10, dailyBudgetUsd: 100, policySha256: upgraded.policy.policySha256 });
    const scheduled = (await claimDueSelfImprovementCycles({ tenantId, targets: [target], now: nextDueAt }))[0];
    expect(scheduled.outcome).toBe("claimed"); expect(scheduled.cycle?.day).toBe("2026-10-27");
    const cycle = scheduled.cycle!;
    await transitionSelfImprovementCycle({ owner, cycleId: cycle.cycle.id, expectedRevision: cycle.cycle.revision, leaseToken: cycle.leaseToken!, nextStage: "no_change", now: nextDueAt });
    // A later local slot on that same UTC day must skip even if a prior daily
    // request has a different configuration generation or baseline revision.
    const rescheduled = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: configuration.repositoryId, repository,
      policy: upgraded.policy, expectedGeneration: upgraded.generation, timeZone: "Asia/Kolkata", dailyHour: 5, now: "2026-10-27T22:00:00.000Z" });
    expect(rescheduled.nextDueAt).toBe("2026-10-27T23:30:00.000Z");
    expect((await claimDueSelfImprovementCycles({ tenantId, targets: [{ ...target, expectedGeneration: rescheduled.generation, baseRevision: "c".repeat(40) }], now: rescheduled.nextDueAt }))[0].outcome).toBe("budget_exhausted");
    expect((await getSelfImprovementConfiguration(owner, configuration.id))?.nextDueAt).toBe("2026-10-28T23:30:00.000Z");
    expect(await scoped(actor, () => getSql()`SELECT cycle_id FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${owner.ownerActorId}`)).toHaveLength(2);
  });
  it("co-commits one meaningful Inbox item and deduplicates exact event replay without crossing owners", async () => {
    const actor = actors[winner], eventId = `${stored.cycle.id}:${stored.cycle.revision}`;
    const admission = { tenantId, actorId: actor.ownerActorId, cycleId: stored.cycle.id, eventId, stage: "failed", occurredAt: stored.cycle.updatedAt };
    const rows = await scoped(actor, () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${actor.ownerActorId} AND source_id=${stored.cycle.id}`);
    expect(rows).toHaveLength(1);
    await withAvailabilityOwner({ tenantId, actorId: actor.ownerActorId }, (sql) => admitSelfImprovementNotificationWithSql(sql, admission));
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${actor.ownerActorId} AND source_id=${stored.cycle.id}`)).toHaveLength(1);
    const other = actors[1-winner];
    expect(await withAvailabilityOwner({ tenantId, actorId: other.ownerActorId }, (sql) => admitSelfImprovementNotificationWithSql(sql, { ...admission, actorId: other.ownerActorId }))).toMatchObject({ state: "superseded" });
    expect(await scoped(other, () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${other.ownerActorId} AND source_id=${stored.cycle.id}`)).toHaveLength(0);
  });
  it("keeps a notification-opted-out trial out of shared Inbox and outboxes even after later enrollment enables alerts", async () => {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` };
    const owner = { tenantId, ownerActorId: actor.ownerActorId };
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,notifications_enabled,quiet_hours_enabled,timezone) VALUES(${tenantId},${actor.ownerActorId},TRUE,FALSE,'UTC')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Isolated silent release trial", profile: studioProjectProfileDefaults("ai-tech", "Synthetic compatibility") }, randomUUID()));
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: `${repositoryId}3`, repository,
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 10, notifyOutcomes: false }), now });
    const started = (await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation,
      baseRevision: "b".repeat(40), idempotencyKey: "silent-trial", now })).cycle!;
    const failed = await transitionSelfImprovementCycle({ owner, cycleId: started.cycle.id, expectedRevision: started.cycle.revision, leaseToken: started.leaseToken!, nextStage: "failed", now });
    const eventId = `${failed.cycle.id}:${failed.cycle.revision}`;
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_events WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId} AND id=${eventId} AND type='self_improvement.cycle.updated' AND payload->>'stage'='failed'`)).toHaveLength(1);
    await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: configuration.repositoryId, repository,
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 100, notifyOutcomes: true }), expectedGeneration: configuration.generation, now });
    expect(await withAvailabilityOwner({ tenantId, actorId: owner.ownerActorId }, sql => admitSelfImprovementNotificationWithSql(sql,
      { tenantId, actorId: owner.ownerActorId, cycleId: failed.cycle.id, eventId, stage: "failed", occurredAt: failed.cycle.updatedAt }))).toEqual({ state: "policy_disabled", notificationId: null });
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId}`)).toHaveLength(0);
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_notification_dispositions WHERE tenant_id=${tenantId} AND owner_actor_id=${owner.ownerActorId}`)).toHaveLength(0);
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_mobile_push_deliveries WHERE tenant_id=${tenantId} AND owner_actor_id=${actor.email}`)).toHaveLength(0);
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_web_push_deliveries WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId}`)).toHaveLength(0);
    expect((await scoped(actor, () => getSql()`SELECT notifications_enabled FROM omni_today_preferences WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId}`))[0].notifications_enabled).toBe(true);
  });
  it("holds meaningful notifications during quiet hours without enqueueing a premature Inbox item", async () => {
    const actor = actors[winner], owner = { tenantId, ownerActorId: actor.ownerActorId }, nextDay = "2026-10-27T12:00:00.000Z";
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await admin`UPDATE omni_today_preferences SET quiet_hours_enabled=TRUE WHERE tenant_id=${tenantId} AND actor_id=${actor.ownerActorId}`;
    const config = await configureSelfImprovement({ ...owner, projectId: configs[winner].projectId, repositoryId: `${repositoryId}1`, repository: { ...repository, name: `${repository.name}-quiet` }, policy: createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 }), now: nextDay });
    let quiet = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: 1, baseRevision: "b".repeat(40), idempotencyKey: "quiet", now: nextDay })).cycle!;
    quiet = await transitionSelfImprovementCycle({ owner, cycleId: quiet.cycle.id, expectedRevision: quiet.cycle.revision, leaseToken: quiet.leaseToken!, nextStage: "failed", now: nextDay });
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND source_id=${quiet.cycle.id}`)).toHaveLength(0);
    expect(await scoped(actor, () => getSql()`SELECT state,outcome FROM omni_notification_dispositions WHERE tenant_id=${tenantId} AND owner_actor_id=${actor.ownerActorId} AND source_id=${quiet.cycle.id}`)).toMatchObject([{ state: "pending", outcome: "defer" }]);
  });
  it("discards only an exact unclaimed held candidate, retaining evidence and freeing the repository", async () => {
    // Prior scenarios intentionally leave unknown spend; a discard scenario needs
    // its own owner so those durable reservations cannot contaminate its allowance.
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` };
    const owner = { tenantId, ownerActorId: actor.ownerActorId }, firstDay = "2026-10-28T12:00:00.000Z", nextDay = "2026-10-29T12:00:00.000Z";
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Isolated held candidate", profile: studioProjectProfileDefaults("ai-tech", "Synthetic discard") }, randomUUID()));
    let config = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: `${repositoryId}4`, repository,
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 10, notifyOutcomes: false }), now: firstDay });
    let held = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation,
      baseRevision: "b".repeat(40), idempotencyKey: "held-candidate", now: firstDay })).cycle!;
    let token = held.leaseToken!;
    const fence = (at = firstDay) => ({ owner, cycleId: held.cycle.id, expectedRevision: held.cycle.revision, leaseToken: token, now: at });
    held = (await reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: "candidate-check", reservedUsd: 1 })).cycle;
    const signal = sealEngineeringSignal({ version: 1, scope: held.cycle.scope, kind: "owner_correction", summary: "Synthetic held repair", symptomSha256: evidenceSha256,
      observations: [{ sourceKind: "owner_feedback", sourceId: "fixture", sourceSha256: evidenceSha256, observedAt: firstDay, outcome: "needs_work" }] });
    const artifact = sealSelfImprovementCandidate({ revision: "c".repeat(40), workspaceSha256: evidenceSha256, diffSha256: "b".repeat(64), changedFiles: [{ path: "src/lib/studio/graph.ts", beforeSha256: "c".repeat(64), afterSha256: "d".repeat(64) }], changedLines: 3, architectureImpact: "minor" });
    let validation = sealSelfImprovementValidation({ scope: held.cycle.scope, policySha256: held.cycle.policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: artifact.candidateSha256,
      candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: kind, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, evidenceSha256, declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: firstDay })) });
    const ready = async (at: string) => {
      held = await transitionSelfImprovementCycle({ ...fence(at), nextStage: "planned", patch: { signal } });
      held = await transitionSelfImprovementCycle({ ...fence(at), nextStage: "implementing" });
      held = await transitionSelfImprovementCycle({ ...fence(at), nextStage: "validating" });
      ({ stored: held, validation } = await persistSyntheticReview(held, artifact, validation, token, at));
      held = await transitionSelfImprovementCycle({ ...fence(at), nextStage: "ready_for_release", patch: { candidate: artifact, validation, pullRequestUrl: "https://github.com/isolated-candidate/app/pull/3" } });
    };
    await ready(firstDay);
    held = await holdSelfImprovementRelease({ owner, cycleId: held.cycle.id, candidateRevision: artifact.revision, controllerId: "not-claimed", category: "base_revision_changed", now: firstDay });
    const discard = (at = firstDay) => ({ owner, cycleId: held.cycle.id, expectedRevision: held.cycle.revision, candidateSha256: artifact.candidateSha256, validationSha256: validation.validationSha256, now: at });
    await expect(discardHeldSelfImprovementCandidate(discard())).rejects.toThrow(/claimed, active or uncertain/);
    held = await releaseSelfImprovementExecutionLease(fence());
    await expect(discardHeldSelfImprovementCandidate(discard())).rejects.toThrow(/unsettled usage/);
    held = await renewSelfImprovementCycleLease({ owner, cycleId: held.cycle.id, expectedRevision: held.cycle.revision, now: firstDay }); token = held.leaseToken!;
    held = await settleSelfImprovementPhaseBudget({ ...fence(), phaseId: "candidate-check", actualUsd: 0.05, evidenceSha256 });
    held = await releaseSelfImprovementExecutionLease(fence());
    config = await pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: config.generation, paused: true, now: firstDay });
    await expect(discardHeldSelfImprovementCandidate({ ...discard(), expectedRevision: held.cycle.revision-1 })).rejects.toThrow(/exact held candidate/);
    await expect(discardHeldSelfImprovementCandidate({ ...discard(), candidateSha256: "f".repeat(64) })).rejects.toThrow(/exact held candidate/);
    const saved = held, request = discard(), attempts = await Promise.allSettled([discardHeldSelfImprovementCandidate(request), discardHeldSelfImprovementCandidate(request)]);
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const discarded = (await getSelfImprovementCycle(owner, held.cycle.id))!;
    expect(discarded).toMatchObject({ cycle: { stage: "cancelled", candidate: artifact, validation, approval: saved.cycle.approval }, controllerHold: saved.controllerHold, spendUsd: 0.05, controllerId: null });
    expect(await scoped(actor, () => getSql()`SELECT id FROM omni_events WHERE tenant_id=${tenantId} AND actor_id=${owner.ownerActorId} AND type='self_improvement.candidate.discarded' AND payload->>'cycleId'=${held.cycle.id}`)).toHaveLength(1);
    const phases = await scoped(actor, () => getSql()`SELECT phase_id,actual_usd,state FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${owner.ownerActorId} AND cycle_id=${held.cycle.id}`);
    expect(phases).toMatchObject([{ phase_id: "candidate-check", state: "settled" }]); expect(Number(phases[0].actual_usd)).toBe(0.05);
    config = await pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: config.generation, paused: false, now: nextDay });
    const next = await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation, baseRevision: "b".repeat(40), idempotencyKey: "after-discard", now: nextDay });
    expect(next.outcome).toBe("claimed"); held = next.cycle!; token = held.leaseToken!;
    await ready(nextDay); held = await releaseSelfImprovementExecutionLease(fence(nextDay));
    held = await claimSelfImprovementReleaseCycle({ owner, cycleId: held.cycle.id, candidateRevision: artifact.revision, controllerId: "already-claimed", now: nextDay });
    held = await holdSelfImprovementRelease({ owner, cycleId: held.cycle.id, candidateRevision: artifact.revision, controllerId: "already-claimed", category: "outcome_unconfirmed", now: nextDay });
    await expect(discardHeldSelfImprovementCandidate(discard("2026-10-29T13:00:00.000Z"))).rejects.toThrow(/claimed, active or uncertain/);
    expect((await getSelfImprovementCycle(owner, held.cycle.id))?.cycle.stage).toBe("ready_for_release");
  });
  it("recovers only disposable source-only Builder sessions with fenced idempotent reprovision receipts", async () => {
    const actor = actors[winner], owner = { tenantId, actorId: actor.ownerActorId };
    await scoped(actor, async () => {
      const created = await createBuilderSessionRecord({ ...owner, projectId: configs[winner].projectId, idempotencyKey: "source-only", workspaceMode: "source_only" });
      const failed = await transitionBuilderSession({ ...owner, session: created.session, status: "failed", eventType: "app_builder.session.failed", eventKey: "failure", lastErrorCode: "builder_aaaaaaaaaaaa" });
      const request = { ...owner, session: failed, expectedRevision: failed.revision, idempotencyKey: "recover", reason: "failed" as const };
      const recovered = await resetSourceOnlyBuilderSessionRecord(request);
      expect(recovered.reset).toBe(true); expect(recovered.session).toMatchObject({ id: failed.id, status: "provisioning", workspaceMode: "source_only" });
      expect(recovered.session.sandboxName).not.toBe(failed.sandboxName); expect(recovered.session.lastErrorCode).toBeUndefined();
      expect((await resetSourceOnlyBuilderSessionRecord(request)).reset).toBe(false);
      await expect(resetSourceOnlyBuilderSessionRecord({ ...request, idempotencyKey: "different" })).rejects.toThrow(/changed/);
    });
    const interactiveActor = actors[1-winner], interactiveOwner = { tenantId, actorId: interactiveActor.ownerActorId };
    await scoped(interactiveActor, async () => {
      const interactive = await createBuilderSessionRecord({ ...interactiveOwner, projectId: configs[1-winner].projectId, idempotencyKey: "interactive" });
      await expect(resetSourceOnlyBuilderSessionRecord({ ...interactiveOwner, session: interactive.session, expectedRevision: interactive.session.revision, idempotencyKey: "unsafe-reset", reason: "sandbox_missing" })).rejects.toThrow(/Interactive/);
    });
  });
  it("revokes engineering effects when the configured owner loses administrator membership", async () => {
    const actor = actors[winner], owner = { tenantId, ownerActorId: actor.ownerActorId };
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    const config = (await getSelfImprovementConfiguration(owner, configs[winner].id))!;
    await expect(assertSelfImprovementOwnerAuthority(owner, config.projectId)).resolves.toBeUndefined();
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${tenantId} AND user_id=${actor.userId}`;
    try {
      await expect(assertSelfImprovementOwnerAuthority(owner, config.projectId)).rejects.toThrow(/administrator/);
      await expect(pauseSelfImprovement({ owner, configurationId: config.id, expectedGeneration: config.generation, paused: true })).rejects.toThrow(/administrator/);
    } finally { await admin`UPDATE omni_auth_memberships SET role='admin' WHERE tenant_id=${tenantId} AND user_id=${actor.userId}`; }
  });
  it("caps delayed release and new-cycle phases together, retaining unresolved reservations across UTC midnight", async () => {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` }, owner = { tenantId, ownerActorId: actor.ownerActorId };
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,notifications_enabled,quiet_hours_enabled,timezone,quiet_hours_start,quiet_hours_end) VALUES(${tenantId},${actor.ownerActorId},FALSE,FALSE,'UTC','00:00','23:59')`;
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Daily cap fixture", profile: studioProjectProfileDefaults("ai-tech", "Synthetic carry-over verification") }, randomUUID()));
    const firstDay = "2026-11-01T12:00:00.000Z", secondDay = "2026-11-02T12:00:00.000Z", thirdDay = "2026-11-03T12:00:00.000Z";
    const config = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: `${repositoryId}2`, repository: { ...repository, name: `${repository.name}-daily` }, policy: createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 }), now: firstDay });
    let previous = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation, baseRevision: "b".repeat(40), idempotencyKey: "previous-day", now: firstDay })).cycle!;
    const source = previous.cycle.scope, token = previous.leaseToken!;
    const signal = sealEngineeringSignal({ version: 1, scope: source, kind: "owner_correction", summary: "Synthetic repair", symptomSha256: "a".repeat(64), observations: [{ sourceKind: "owner_feedback", sourceId: "fixture", sourceSha256: "b".repeat(64), observedAt: firstDay, outcome: "needs_work" }] });
    const artifact = sealSelfImprovementCandidate({ revision: "c".repeat(40), workspaceSha256: "a".repeat(64), diffSha256: "b".repeat(64), changedFiles: [{ path: "src/lib/studio/graph.ts", beforeSha256: "c".repeat(64), afterSha256: "d".repeat(64) }], changedLines: 3, architectureImpact: "minor" });
    let validation = sealSelfImprovementValidation({ scope: source, policySha256: previous.cycle.policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: artifact.candidateSha256, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256,
      checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: kind, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, evidenceSha256, declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: firstDay })) });
    const oldFence = () => ({ owner, cycleId: previous.cycle.id, expectedRevision: previous.cycle.revision, leaseToken: token, now: firstDay });
    previous = await transitionSelfImprovementCycle({ ...oldFence(), nextStage: "planned", patch: { signal } });
    previous = await transitionSelfImprovementCycle({ ...oldFence(), nextStage: "implementing" });
    previous = await transitionSelfImprovementCycle({ ...oldFence(), nextStage: "validating" });
    ({ stored: previous, validation } = await persistSyntheticReview(previous, artifact, validation, token, firstDay));
    previous = await transitionSelfImprovementCycle({ ...oldFence(), nextStage: "ready_for_release", patch: { candidate: artifact, validation, pullRequestUrl: "https://github.com/isolated-candidate/app/pull/2" } });
    previous = await releaseSelfImprovementExecutionLease(oldFence());
    const claimed = await claimSelfImprovementReleaseCycle({ owner, cycleId: previous.cycle.id, candidateRevision: artifact.revision, controllerId: "delayed", now: secondDay });
    previous = claimed;
    const release = sealSelfImprovementReleaseBinding({ releaseId: "delayed-release", scope: source, previousRevision: source.baseRevision, sourceCandidateRevision: artifact.revision, candidateRevision: "d".repeat(40), sourceTree: "e".repeat(40), mergedTree: "e".repeat(40), pullRequestUrl: previous.cycle.pullRequestUrl!, candidateSha256: artifact.candidateSha256, policySha256: previous.cycle.policy.policySha256, validationSha256: validation.validationSha256, runner: "asael_paired_production" });
    const releaseFence = () => ({ owner, cycleId: previous.cycle.id, expectedRevision: previous.cycle.revision, leaseToken: claimed.leaseToken!, now: secondDay });
    previous = await transitionSelfImprovementCycle({ ...releaseFence(), nextStage: "releasing", patch: { release } });
    previous = await settleSelfImprovementPhaseBudget({ ...releaseFence(), phaseId: claimed.releaseBudget.phaseId, actualUsd: 8, evidenceSha256 });
    previous = await transitionSelfImprovementCycle({ ...releaseFence(), nextStage: "failed", patch: { releaseReceipt: { releaseBindingSha256: release.releaseBindingSha256, outcome: "failed", webRevision: source.baseRevision, workerRevision: source.baseRevision, manifestSha256: evidenceSha256, healthEvidenceSha256: evidenceSha256, behaviorEvidenceSha256: validation.validationSha256, evidenceSha256, recordedAt: secondDay } } });
    let current = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation, baseRevision: source.baseRevision, idempotencyKey: "second-day", now: secondDay })).cycle!;
    const currentToken = current.leaseToken!, currentFence = () => ({ owner, cycleId: current.cycle.id, expectedRevision: current.cycle.revision, leaseToken: currentToken, now: secondDay });
    current = (await reserveSelfImprovementPhaseBudget({ ...currentFence(), phaseId: "new-work", reservedUsd: 92 })).cycle;
    await expect(reserveSelfImprovementPhaseBudget({ ...currentFence(), phaseId: "would-exceed", reservedUsd: 1 })).rejects.toThrow(/daily UTC/);
    current = await settleSelfImprovementPhaseBudget({ ...currentFence(), phaseId: "new-work", actualUsd: null, evidenceSha256 });
    current = await transitionSelfImprovementCycle({ ...currentFence(), nextStage: "failed" });
    let next = (await claimManualSelfImprovementCycle({ owner, configurationId: config.id, expectedGeneration: config.generation, baseRevision: source.baseRevision, idempotencyKey: "third-day", now: thirdDay })).cycle!;
    let nextToken = next.leaseToken!;
    const nextFence = () => ({ owner, cycleId: next.cycle.id, expectedRevision: next.cycle.revision, leaseToken: nextToken, now: thirdDay });
    await expect(reserveSelfImprovementPhaseBudget({ ...nextFence(), phaseId: "unknown-carry", reservedUsd: 9 })).rejects.toThrow(/daily UTC/);
    const concurrent = await Promise.allSettled(["a", "b"].map(phase => scoped(actor, () => getSql()`INSERT INTO omni_self_improvement_phase_reservations(tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,actual_usd,state,evidence_sha256,created_at,settled_at)
      VALUES(${tenantId},${actor.ownerActorId},${next.cycle.id},${`concurrent-${phase}`},5,NULL,'reserved',NULL,${thirdDay},NULL)`)));
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "rejected")).toHaveLength(1);
    next = (await reserveSelfImprovementPhaseBudget({ ...nextFence(), phaseId: "last-three", reservedUsd: 3 })).cycle;
    next = await transitionSelfImprovementCycle({ ...nextFence(), nextStage: "planned", patch: { signal } });
    next = await transitionSelfImprovementCycle({ ...nextFence(), nextStage: "implementing" });
    next = await transitionSelfImprovementCycle({ ...nextFence(), nextStage: "validating" });
    ({ stored: next, validation } = await persistSyntheticReview(next, artifact, validation, nextToken, thirdDay));
    next = await transitionSelfImprovementCycle({ ...nextFence(), nextStage: "ready_for_release", patch: { candidate: artifact, validation, pullRequestUrl: "https://github.com/isolated-candidate/app/pull/3" } });
    next = await releaseSelfImprovementExecutionLease(nextFence());
    await expect(claimSelfImprovementReleaseCycle({ owner, cycleId: next.cycle.id, candidateRevision: artifact.revision, controllerId: "over-daily-cap", now: thirdDay })).rejects.toThrow(/daily UTC/);
    expect((await getSelfImprovementCycle(owner, next.cycle.id))?.controllerId).toBeNull();
    next = await renewSelfImprovementCycleLease({ owner, cycleId: next.cycle.id, expectedRevision: next.cycle.revision, now: thirdDay }); nextToken = next.leaseToken!;
    next = await settleSelfImprovementPhaseBudget({ ...nextFence(), phaseId: "last-three", actualUsd: 4, evidenceSha256 });
    expect(next).toMatchObject({ spendUsd: 4, usageState: "unknown" }); // Preserve an unexpected provider overage rather than falsifying cost.
  });
  async function retryFixture(admittedAt = now) {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` }, owner = { tenantId, ownerActorId: actor.ownerActorId };
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actor.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject(context(actor), { title: "Setup retry fixture", profile: studioProjectProfileDefaults("ai-tech", "Synthetic retry") }, randomUUID()));
    const id = String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16));
    // This fixture exercises the already shipped, sealed legacy retry contract.
    const { maxCycleBudgetUsd: _cap, policySha256: _hash, ...legacyBody } = createSelfImprovementPolicy({ dailyBudgetUsd: 10, notifyOutcomes: false });
    const legacyPolicy = selfImprovementPolicySchema.parse({ ...legacyBody, policySha256: selfImprovementSha256("policy", legacyBody) });
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId: id, repository: { ...repository, name: `retry-${id}` }, policy: legacyPolicy, now });
    const admitted = (await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, baseRevision: "b".repeat(40), idempotencyKey: "original", now: admittedAt })).cycle!;
    return { actor, owner, configuration, admitted };
  }
  async function failSetup(fixture: Awaited<ReturnType<typeof retryFixture>>, receipt = true, captured?: { runtime: Record<string, unknown>; updatedAt: string }) {
    let cycle = fixture.admitted;
    const start = Date.parse(cycle.cycle.createdAt), token = cycle.leaseToken!;
    const fence = (offset: number) => ({ owner: fixture.owner, cycleId: cycle.cycle.id, expectedRevision: cycle.cycle.revision, leaseToken: token, now: captured?.updatedAt || new Date(start + offset).toISOString() });
    cycle = await updateSelfImprovementCycleRuntime({ ...fence(1_000), runtime: captured?.runtime || { ...initialSelfImprovementRuntime(), errorCode: "phase_failed", summary: "Improvement operation did not execute: app.projects.builder.create (failed)." } });
    cycle = await transitionSelfImprovementCycle({ ...fence(2_000), nextStage: "failed" });
    if (receipt) await setupReceipt(fixture, cycle);
    return cycle;
  }
  async function setupReceipt(fixture: Awaited<ReturnType<typeof retryFixture>>, cycle: StoredSelfImprovementCycle, wrongCycle = false, error = "Project was not found.") {
    const input = { projectId: fixture.configuration.projectId, workspaceMode: "source_only" };
    const record = { id: governedToolExecutionId(tenantId, `self-improvement:${cycle.cycle.id}:workspace`), tenantId, actorId: fixture.owner.ownerActorId,
      toolId: "app.projects.builder.create", toolName: "Create workspace", riskLevel: 1 as const, status: "failed" as const, dryRun: false, approvalRequired: false, input,
      output: { error }, reason: error, createdAt: cycle.cycle.createdAt, completedAt: cycle.cycle.updatedAt };
    await admin`INSERT INTO omni_tool_executions(id,tenant_id,actor_id,tool_id,tool_name,risk_level,status,dry_run,approval_required,input,output,reason,created_at,completed_at)
      VALUES(${record.id},${tenantId},${record.actorId},${record.toolId},${record.toolName},1,'failed',FALSE,FALSE,${JSON.stringify(input)}::jsonb,${JSON.stringify(record.output)}::jsonb,${record.reason},${record.createdAt},${record.completedAt})`;
    await scoped(fixture.actor, () => appendDomainEvent(toolExecutionScopeBoundEvent({ record, toolInput: input, requesterRole: "operator", executionScope: createExecutionScope({
      tenantId, initiatingActorId: record.actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: fixture.configuration.projectId,
      correlationId: wrongCycle ? "different-cycle" : cycle.cycle.id, causationId: wrongCycle ? "different-cycle" : cycle.cycle.id, purpose: "self_improvement.cycle.v1" }) })));
  }
  async function setupRetryAt(owner: Parameters<typeof getSelfImprovementSetupRetry>[0], cycleId: string, at: string) {
    // Eligibility intentionally uses the current UTC day. Keep the captured
    // fixture clock explicit without replacing PostgreSQL/network timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    try { return await getSelfImprovementSetupRetry(owner, cycleId); }
    finally { vi.useRealTimers(); }
  }
  it("retries only one proved pre-AI setup failure, preserving terminal evidence and both reservation rows", async () => {
    const fixture = await retryFixture();
    const parent = await failSetup(fixture, false);
    const request = { owner: fixture.owner, configurationId: fixture.configuration.id, expectedGeneration: fixture.configuration.generation, failedCycleId: parent.cycle.id,
      expectedRevision: parent.cycle.revision, baseRevision: "c".repeat(40), now: "2026-10-26T12:00:03.000Z" };
    await expect(retryPreAiSelfImprovementCycle(request)).rejects.toThrow(/proven pre-AI/);
    await setupReceipt(fixture, parent);
    expect(await setupRetryAt(fixture.owner, parent.cycle.id, request.now)).toMatchObject({ cycleId: parent.cycle.id, revision: parent.cycle.revision });
    await expect(retryPreAiSelfImprovementCycle({ ...request, expectedRevision: 99 })).rejects.toThrow(/exact failed/);
    await expect(retryPreAiSelfImprovementCycle({ ...request, now: "2026-10-27T00:00:00.000Z" })).rejects.toThrow(/proven pre-AI/);
    const changed = await configureSelfImprovement({ ...fixture.owner, projectId: fixture.configuration.projectId, repositoryId: fixture.configuration.repositoryId,
      repository: fixture.configuration.repository, expectedGeneration: 1, policy: createSelfImprovementPolicy({ dailyBudgetUsd: 11, notifyOutcomes: false }), now });
    await expect(retryPreAiSelfImprovementCycle({ ...request, expectedGeneration: changed.generation })).rejects.toThrow(/admitted policy/);
    const restored = await configureSelfImprovement({ ...fixture.owner, projectId: fixture.configuration.projectId, repositoryId: fixture.configuration.repositoryId,
      repository: fixture.configuration.repository, expectedGeneration: changed.generation, policy: fixture.configuration.policy, now });
    const paused = await pauseSelfImprovement({ owner: fixture.owner, configurationId: fixture.configuration.id, expectedGeneration: restored.generation, paused: true, now });
    expect(await retryPreAiSelfImprovementCycle({ ...request, expectedGeneration: paused.generation })).toEqual({ outcome: "paused" });
    const resumed = await pauseSelfImprovement({ owner: fixture.owner, configurationId: paused.id, expectedGeneration: paused.generation, paused: false, now });
    request.expectedGeneration = resumed.generation;
    const results = await Promise.all([retryPreAiSelfImprovementCycle(request), retryPreAiSelfImprovementCycle(request)]);
    expect(results.map(item => item.outcome).sort()).toEqual(["claimed", "duplicate"]);
    expect(new Set(results.map(item => item.cycle!.cycle.id)).size).toBe(1);
    const child = results.find(item => item.outcome === "claimed")!;
    expect(child.retryOf).toMatchObject({ cycleId: parent.cycle.id, revision: parent.cycle.revision });
    expect(child.cycle!.cycle.scope.baseRevision).toBe("c".repeat(40));
    expect(await getSelfImprovementCycle(fixture.owner, parent.cycle.id)).toEqual({ ...parent, unsettledPaidUsage: false });
    expect(await setupRetryAt(fixture.owner, parent.cycle.id, request.now)).toBeNull();
    const reservations = await scoped(fixture.actor, () => getSql()`SELECT cycle_id,reserved_usd FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${fixture.owner.ownerActorId} ORDER BY cycle_id`);
    expect(reservations).toHaveLength(2); expect(reservations.map(item => Number(item.reserved_usd))).toEqual([10, 10]);
    const failedChild = await failSetup({ ...fixture, admitted: child.cycle! });
    await expect(retryPreAiSelfImprovementCycle({ ...request, failedCycleId: failedChild.cycle.id, expectedRevision: failedChild.cycle.revision, now: "2026-10-26T12:00:06.000Z" })).rejects.toThrow(/proven pre-AI/);
    expect((await claimManualSelfImprovementCycle({ owner: fixture.owner, configurationId: resumed.id, expectedGeneration: resumed.generation, baseRevision: "c".repeat(40), idempotencyKey: "ordinary-run", now })).outcome).toBe("budget_exhausted");
  });
  it("rejects setup retry with paid phase history, an existing Builder resource or a changed tool scope", async () => {
    for (const condition of ["phase", "builder", "scope", "uncertain_error"] as const) {
      const fixture = await retryFixture();
      if (condition === "phase") {
        const reserved = await reserveSelfImprovementPhaseBudget({ owner: fixture.owner, cycleId: fixture.admitted.cycle.id, expectedRevision: fixture.admitted.cycle.revision,
          leaseToken: fixture.admitted.leaseToken!, phaseId: "inspect:0", reservedUsd: 1, now });
        const settled = await settleSelfImprovementPhaseBudget({ owner: fixture.owner, cycleId: reserved.cycle.cycle.id, expectedRevision: reserved.cycle.cycle.revision,
          leaseToken: fixture.admitted.leaseToken!, phaseId: "inspect:0", actualUsd: 0, evidenceSha256, now });
        fixture.admitted = { ...settled, leaseToken: fixture.admitted.leaseToken };
      }
      const parent = await failSetup(fixture, condition !== "scope" && condition !== "uncertain_error");
      if (condition === "scope") await setupReceipt(fixture, parent, true);
      if (condition === "uncertain_error") await setupReceipt(fixture, parent, false, "Sandbox provisioning response was lost.");
      if (condition === "builder") await scoped(fixture.actor, () => createBuilderSessionRecord({ tenantId, actorId: fixture.owner.ownerActorId, projectId: fixture.configuration.projectId, workspaceMode: "source_only", idempotencyKey: "existing-resource" }));
      await expect(retryPreAiSelfImprovementCycle({ owner: fixture.owner, configurationId: fixture.configuration.id, expectedGeneration: 1, failedCycleId: parent.cycle.id,
        expectedRevision: parent.cycle.revision, baseRevision: "c".repeat(40), now: "2026-10-26T12:00:03.000Z" })).rejects.toThrow(/proven pre-AI/);
      expect(await getSelfImprovementCycle(fixture.owner, parent.cycle.id)).toEqual({ ...parent, unsettledPaidUsage: false });
    }
  });
  it.skipIf(!process.env.ASAEL_SELF_IMPROVEMENT_CAPTURE_DIRECTORY)("replays the captured setup rejection and its original scope/admission hashes in isolated PostgreSQL", async () => {
    const directory = process.env.ASAEL_SELF_IMPROVEMENT_CAPTURE_DIRECTORY!;
    const read = async (name: string) => JSON.parse(await readFile(join(directory, name), "utf8"));
    const [runtime, ownerReadback, tools, scopes, admissions] = await Promise.all([
      read("failed-cycle-runtime-readback.json"), read("failed-cycle-owner-readback.json"), read("failed-builder-tool-receipt.json"), read("failed-builder-scope-events.json"), read("failed-cycle-domain-events.json"),
    ]);
    expect(runtime.readOnly).toBe(true); expect(runtime.id).toBe(ownerReadback.cycle.id);
    expect(runtime.runtime).toMatchObject({ phase: "setup", setupStep: "create", agentRuns: [], phaseAttempt: null, reservedModelUsd: 0 });
    expect(Number(runtime.spend_usd)).toBe(0); expect(runtime.usage_state).toBe("known");
    const original = tools.matches[0] as ToolExecutionRecord;
    const binding = scopes.events.find((item: { type: string }) => item.type === "tool.scope_bound");
    const originalScope = parsePersistedExecutionScope(binding.payload._executionScope)!;
    expect(binding.payload.inputSha256).toBe(toolInputSha256(original.input));
    expect(binding.payload.scopeSha256).toBe(toolInputSha256(originalScope));
    expect(original.id).toBe(governedToolExecutionId(original.tenantId!, `self-improvement:${runtime.id}:workspace`));
    const started = admissions.events.find((item: { id: string; type: string }) => item.id === `${runtime.id}:1` && item.type === "self_improvement.cycle.started");
    expect(started.payload).toMatchObject({ cycleId: runtime.id, trigger: "owner", reservationUsd: 10, policySha256: ownerReadback.configuration.policy.policySha256 });
    const fixture = await retryFixture(ownerReadback.cycle.createdAt);
    const parent = await failSetup(fixture, false, { runtime: runtime.runtime, updatedAt: ownerReadback.cycle.updatedAt });
    // Keep the captured runtime, error, status, tool and timestamps. Remap only
    // identities so the real local trial's existing records remain untouched.
    const record = { ...original, id: governedToolExecutionId(tenantId, `self-improvement:${parent.cycle.id}:workspace`), tenantId, actorId: fixture.owner.ownerActorId,
      input: { ...original.input, projectId: fixture.configuration.projectId } };
    await admin`INSERT INTO omni_tool_executions(id,tenant_id,actor_id,tool_id,tool_name,risk_level,status,dry_run,approval_required,input,output,reason,created_at,completed_at)
      VALUES(${record.id},${tenantId},${record.actorId},${record.toolId},${record.toolName},${record.riskLevel},${record.status},${record.dryRun},${record.approvalRequired},${JSON.stringify(record.input)}::jsonb,${JSON.stringify(record.output)}::jsonb,${record.reason!},${record.createdAt},${record.completedAt!})`;
    const scope = createExecutionScope({ ...originalScope, tenantId, initiatingActorId: fixture.owner.ownerActorId, projectId: fixture.configuration.projectId, correlationId: parent.cycle.id, causationId: parent.cycle.id });
    await scoped(fixture.actor, () => appendDomainEvent(toolExecutionScopeBoundEvent({ record, toolInput: record.input, requesterRole: "operator", executionScope: scope })));
    expect(await setupRetryAt(fixture.owner, parent.cycle.id, ownerReadback.cycle.updatedAt)).toMatchObject({ cycleId: parent.cycle.id, toolExecutionId: record.id });
    const result = await retryPreAiSelfImprovementCycle({ owner: fixture.owner, configurationId: fixture.configuration.id, expectedGeneration: 1,
      failedCycleId: parent.cycle.id, expectedRevision: parent.cycle.revision, baseRevision: "c".repeat(40), now: new Date(Date.parse(parent.cycle.updatedAt) + 1_000).toISOString() });
    expect(result.outcome).toBe("claimed"); expect(result.retryOf?.toolExecutionId).toBe(record.id);
    expect(await getSelfImprovementCycle(fixture.owner, parent.cycle.id)).toEqual({ ...parent, unsettledPaidUsage: false });
  });
});
