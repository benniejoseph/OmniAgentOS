/** Opt-in runtime-role PostgreSQL/RLS proof; identities and paired health are synthetic. */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createStudioProject } from "@/lib/studio/projects";
import { studioProjectProfileDefaults } from "@/lib/studio/contracts";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { sealSelfImprovementCandidate, sealSelfImprovementReleaseBinding, sealSelfImprovementValidation } from "@/lib/self-improvement/contracts";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle, reconcileSelfImprovementWebPredeploymentFailure } from "@/lib/self-improvement/store";
import { executeSelfImprovementControllerAction } from "@/lib/self-improvement/release-service";
const setup = vi.hoisted(() => ({ serving: false }));
vi.mock("@/lib/db/client", async original => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `web-reconciliation-${randomUUID()}`, role = `web_reconciliation_${randomBytes(6).toString("hex")}`;
const actors = [randomUUID(), randomUUID()].map(userId => ({ userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` }));
const owner = { tenantId, ownerActorId: actors[0].ownerActorId };
const git = (value: string) => value.repeat(40), sha = (value: string) => value.repeat(64);
const initialAt = new Date(Date.now() - 600_000).toISOString();
const context = (actor: typeof actors[number]): SecurityContext => ({ tenantId, actorId: actor.email, source: "session", role: "admin",
  auth: { userId: actor.userId, email: actor.email, sessionId: "synthetic-no-login", tenantName: "Synthetic reconciliation" } });
const scoped = <T>(actor: typeof actors[number], work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.ownerActorId, actor.email], work);
candidate("held web publication terminal reconciliation PostgreSQL boundary", () => {
  let admin: ReturnType<typeof postgres>;
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
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects,omni_personal_notifications,omni_notification_dispositions TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships,omni_today_preferences TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_mobile_push_registrations,omni_mobile_sessions,omni_web_push_registrations,omni_auth_sessions,omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Synthetic web reconciliation',${tenantId})`;
    for (const actor of actors) {
      await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${actor.userId},${actor.email},'synthetic-no-login')`;
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${actor.userId},'admin')`;
      await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,notifications_enabled,quiet_hours_enabled,timezone,quiet_hours_start,quiet_hours_end) VALUES(${tenantId},${actor.ownerActorId},FALSE,FALSE,'UTC','00:00','23:59')`;
    }
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1"); setup.serving = true;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    for (const actor of actors) await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });
  async function fixture(mode: "known" | "started" | "unknown" = "known") {
    const repositoryId = String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16));
    const repository = { owner: "synthetic", name: `app-${repositoryId}`, defaultBranch: "main" };
    const project = await scoped(actors[0], () => createStudioProject(context(actors[0]), { title: "Synthetic reconciliation", profile: studioProjectProfileDefaults("ai-tech", "Synthetic regression") }, randomUUID()));
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId, repository,
      policy: createSelfImprovementPolicy({ maxCycleBudgetUsd: 10 }), now: initialAt, nextDueAt: initialAt });
    const admission = await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation,
      baseRevision: git("a"), idempotencyKey: `synthetic-${repositoryId}`, now: initialAt });
    expect(admission.outcome).toBe("claimed");
    const stored = admission.cycle!, { scope, policy } = stored.cycle;
    const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", symptomSha256: sha("a"), summary: "Synthetic predeployment failure",
      observations: [{ sourceKind: "owner_feedback", sourceId: "synthetic", sourceSha256: sha("b"), observedAt: initialAt, outcome: "needs_work" }] });
    const artifact = sealSelfImprovementCandidate({ revision: git("b"), workspaceSha256: sha("c"), diffSha256: sha("d"),
      changedFiles: [{ path: "src/lib/example.ts", beforeSha256: sha("e"), afterSha256: sha("f") }], changedLines: 5, architectureImpact: "minor" });
    const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: artifact.candidateSha256,
      candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256,
      checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: `synthetic:${kind}`, candidateRevision: artifact.revision, workspaceSha256: artifact.workspaceSha256, evidenceSha256: sha("a"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: initialAt })) });
    const release = sealSelfImprovementReleaseBinding({ releaseId: `synthetic-release-${repositoryId}`, scope, previousRevision: git("a"), sourceCandidateRevision: git("b"), candidateRevision: git("c"),
      sourceTree: git("d"), mergedTree: git("d"), pullRequestUrl: `https://github.com/synthetic/${repository.name}/pull/1`, candidateSha256: artifact.candidateSha256,
      policySha256: policy.policySha256, validationSha256: validation.validationSha256, runner: "asael_paired_production" });
    const cycle = { ...stored.cycle, stage: "releasing", revision: stored.cycle.revision + 1, signal, candidate: artifact, validation, release, pullRequestUrl: release.pullRequestUrl };
    const hold = { category: "trusted_command_failed", occurredAt: initialAt }, phaseId = "release:synthetic-controller";
    // Admin setup supplies historical synthetic rows; actions use real runtime RLS.
    await admin`UPDATE omni_self_improvement_cycles SET stage='releasing',revision=${cycle.revision},snapshot=${admin.json(cycle)}::jsonb,
      spend_usd=${mode === "unknown" ? 0 : 3.820655},release_controller_id='synthetic-controller',controller_hold=${admin.json(hold)}::jsonb WHERE id=${cycle.id}`;
    await admin`INSERT INTO omni_self_improvement_phase_reservations(tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,actual_usd,state,evidence_sha256,created_at,settled_at)
      VALUES(${tenantId},${owner.ownerActorId},${cycle.id},'inspect:0',9,${mode === "unknown" ? null : 3.820655},${mode === "unknown" ? "unknown" : "settled"},${sha("b")},${initialAt},${initialAt})`;
    const digest = canonicalJsonSha256({ releaseBudget: { phaseId, reservedUsd: 1 }, usage: null, started: mode === "started" });
    await admin`INSERT INTO omni_self_improvement_phase_reservations(tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,actual_usd,state,evidence_sha256,created_at,settled_at)
      VALUES(${tenantId},${owner.ownerActorId},${cycle.id},${phaseId},1,0,'settled',${digest},${initialAt},${initialAt})`;
    const observedAt = new Date().toISOString();
    return { owner, action: { action: "reconcile_web_predeployment_failure" as const, cycleId: cycle.id, expectedRevision: cycle.revision, controllerId: "synthetic-controller",
      releaseBindingSha256: release.releaseBindingSha256, controllerHoldSha256: canonicalJsonSha256(hold),
      attestation: { version: 1 as const, kind: "operator_attested_predeployment_failure" as const, diagnosticSha256: sha("d"), attemptEvidenceSha256: sha("e"), recordedAt: observedAt } },
      priorPair: { webRevision: git("a"), workerRevision: git("a"), manifestSha256: sha("f"), serverHealthEvidenceSha256: sha("d"), observedAt } };
  }
  const snapshot = async (cycleId: string) => ({
    cycle: (await admin`SELECT * FROM omni_self_improvement_cycles WHERE id=${cycleId}`)[0],
    phases: [...await admin`SELECT * FROM omni_self_improvement_phase_reservations WHERE cycle_id=${cycleId} ORDER BY phase_id`],
    reservations: [...await admin`SELECT * FROM omni_self_improvement_budget_reservations WHERE cycle_id=${cycleId}`],
    events: [...await admin`SELECT id,type,payload FROM omni_events WHERE payload->>'cycleId'=${cycleId} ORDER BY seq`],
  });
  it("serializes exact competing actions, preserves liabilities, and replays without new health evidence", async () => {
    const input = await fixture(), before = await snapshot(input.action.cycleId);
    expect(await scoped(actors[0], async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_self_improvement_cycles') AS active FROM pg_roles WHERE rolname=current_user`)[0]))
      .toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    await expect(reconcileSelfImprovementWebPredeploymentFailure({ ...input, action: { ...input.action, expectedRevision: input.action.expectedRevision - 1 } })).rejects.toThrow(/expired, exactly attested/);
    const results = await Promise.all([reconcileSelfImprovementWebPredeploymentFailure(input), reconcileSelfImprovementWebPredeploymentFailure(input)]);
    expect(results[0].cycle).toEqual(results[1].cycle); expect(results[0].cycle.stage).toBe("failed"); expect(results[0].cycle.revision).toBe(input.action.expectedRevision + 1);
    const after = await snapshot(input.action.cycleId);
    expect(after.phases).toEqual(before.phases); expect(after.reservations).toEqual(before.reservations);
    for (const key of ["runtime", "spend_usd", "usage_state", "reservation_usd", "controller_hold", "release_controller_id", "lease_token_sha256", "lease_expires_at"]) expect(after.cycle[key]).toEqual(before.cycle[key]);
    expect(after.events.filter(event => event.type === "self_improvement.release.operator_reconciled")).toHaveLength(1);
    expect((await reconcileSelfImprovementWebPredeploymentFailure({ ...input, priorPair: undefined })).cycle).toEqual(results[0].cycle);
    await expect(reconcileSelfImprovementWebPredeploymentFailure({ ...input, action: { ...input.action, attestation: { ...input.action.attestation, diagnosticSha256: sha("f") } } })).rejects.toThrow(/expired, exactly attested/);
    expect(await snapshot(input.action.cycleId)).toEqual(after);
  });
  it("requires exact owner RLS without exposing or changing the held cycle", async () => {
    const input = await fixture(), before = await snapshot(input.action.cycleId), other = { tenantId, ownerActorId: actors[1].ownerActorId };
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", other.ownerActorId);
    try {
      expect(await getSelfImprovementCycle(other, input.action.cycleId)).toBeNull();
      await expect(reconcileSelfImprovementWebPredeploymentFailure({ ...input, owner: other })).rejects.toThrow(/not found/);
    } finally { vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId); }
    expect(await snapshot(input.action.cycleId)).toEqual(before);
  });
  it.each(["started", "unknown"] as const)("preserves %s liability despite zero release cost", async mode => {
    const input = await fixture(mode), before = await snapshot(input.action.cycleId);
    await expect(reconcileSelfImprovementWebPredeploymentFailure(input)).rejects.toThrow(/pre-dispatch|known usage/);
    expect(await snapshot(input.action.cycleId)).toEqual(before);
  });
  it("performs independent health outside the runtime's one-connection transaction", async () => {
    const input = await fixture();
    const fetchMock = vi.fn(async (url: string) => {
      // If health were awaited while the action held the sole pool lease, this
      // real independent reservation could not complete.
      await scoped(actors[0], () => getSql()`SELECT 1 AS alive`);
      return Response.json(url.includes("fly.dev") ? { status: "healthy", service: "asael-openai-egress", revision: git("a") } :
        { status: "healthy", revision: git("a"), releaseManifest: "synthetic-prior-manifest" });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await executeSelfImprovementControllerAction(context(actors[0]), input.action)).toMatchObject({ stage: "failed", automaticRetry: false });
    expect(fetchMock).toHaveBeenCalledTimes(2); vi.unstubAllGlobals();
  });
});
