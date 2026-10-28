/** Opt-in real PostgreSQL/RLS native validation lifecycle; synthetic accounts, no provider calls. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createStudioProject } from "@/lib/studio/projects";
import { studioProjectProfileDefaults } from "@/lib/studio/contracts";
import { withAvailabilityOwner } from "@/lib/availability-watches/store";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";
import { decideServerNotification, notificationDispositionCoordinates, selfImprovementNotificationCandidate } from "@/lib/mobile/notification-delivery-policy";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import { admitSelfImprovementNotificationWithSql } from "@/lib/self-improvement/notifications";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema, improvementPreparationPassed } from "@/lib/self-improvement/runtime";
import { nativeValidationFixture } from "@/lib/self-improvement/native-test-fixtures";
import { nativeValidationReceiptSchema, nativeValidationRequestSchema, selfImprovementNativeSha, type NativeValidationRequest, type NativeValidationReceipt } from "@/lib/self-improvement/native-contracts";
import { sealSelfImprovementCandidate, sealSelfImprovementValidation, sealSelfImprovementApproval, sealSelfImprovementReleaseBinding } from "@/lib/self-improvement/contracts";
import { executeSelfImprovementControllerAction } from "@/lib/self-improvement/release-service";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { withSyntheticCriterionReview } from "@/lib/self-improvement/review-release-test-fixtures";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle, pauseSelfImprovement, releaseSelfImprovementExecutionLease,
  renewSelfImprovementCycleLease, transitionSelfImprovementCycle, updateSelfImprovementCycleRuntime, reserveSelfImprovementPhaseBudget, settleSelfImprovementPhaseBudget,
  claimSelfImprovementNativeValidation, readSelfImprovementNativeLease, finishSelfImprovementNativeValidation, holdExpiredSelfImprovementNativeValidation,
  stopSelfImprovementNativeCheck, canStopSelfImprovementNativeCheck } from "@/lib/self-improvement/store";
import { claimSelfImprovementReleaseCycle, recoverSelfImprovementNativeReleaseCompletion, readSelfImprovementReleaseLease } from "@/lib/self-improvement/store";
const setup = vi.hoisted(() => ({ serving: false }));
vi.mock("@/lib/db/client", async original => { const actual = await original<typeof import("@/lib/db/client")>(); return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() }; });
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `native-candidate-${randomUUID()}`, role = `native_candidate_${randomBytes(6).toString("hex")}`;
const sha = "a".repeat(64), sample = nativeValidationFixture();
type Actor = { userId: string; email: string; ownerActorId: string };
const scoped = <T>(actor: Actor, work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.ownerActorId, actor.email], work);

candidate("native self-improvement PostgreSQL claims and reconciliation", () => {
  let admin: ReturnType<typeof postgres>;
  const evidence: Record<string, unknown> = { syntheticReceipts: true, actualNativeBuilds: 0, actualProviderCalls: 0, productionWrites: false };
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("The disposable candidate URL is required.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the isolated loopback candidate is allowed.");
    await closeDatabaseClient(); admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(266);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects,omni_personal_notifications,omni_notification_dispositions,omni_mobile_push_deliveries TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships,omni_today_preferences TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts,omni_mobile_push_registrations,omni_mobile_sessions,omni_auth_sessions TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Synthetic native validation',${tenantId})`;
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4");
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); setup.serving = true;
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    if (process.env.ASAEL_NATIVE_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_NATIVE_CANDIDATE_EVIDENCE_FILE, JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
    vi.unstubAllEnvs();
  });
  async function fixture(options: { notify?: boolean; quiet?: boolean; transports?: boolean; notificationsEnabled?: boolean; agoSeconds?: number } = {}) {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` }, owner = { tenantId, ownerActorId: `actor:${userId}` };
    const at = Date.now() - (options.agoSeconds ?? 300) * 1_000, time = (seconds = 0) => new Date(at + seconds * 1_000).toISOString();
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,notifications_enabled,quiet_hours_enabled,timezone,quiet_hours_start,quiet_hours_end) VALUES(${tenantId},${owner.ownerActorId},${options.notificationsEnabled ?? true},${options.quiet ?? false},'UTC','00:00','23:59')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const project = await scoped(actor, () => createStudioProject({ tenantId, actorId: actor.email, source: "session", role: "operator", auth: { userId, email: actor.email, sessionId: "synthetic-no-login", tenantName: "Native candidate" } }, { title: "Synthetic Mac repair", profile: studioProjectProfileDefaults("ai-tech", "Native lifecycle regression") }, randomUUID()));
    const repositoryId = String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16));
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId, repository: { owner: "isolated", name: `native-${repositoryId}`, defaultBranch: "main" }, policy: createSelfImprovementPolicy({ notifyOutcomes: options.notify ?? false }), now: time() });
    let stored = (await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, baseRevision: sample.request.snapshot.baseRevision, idempotencyKey: "native", now: time() })).cycle!;
    const token = stored.leaseToken!;
    const signal = sealEngineeringSignal({ version: 1, scope: stored.cycle.scope, kind: "owner_correction", summary: "Synthetic title regression", symptomSha256: sha, observations: [{ sourceKind: "owner_feedback", sourceId: "synthetic", sourceSha256: sha, observedAt: time(), outcome: "needs_work" }] });
    stored = await transitionSelfImprovementCycle({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: token, nextStage: "planned", patch: { signal }, now: time() });
    if (options.transports) {
      const sessionId = randomUUID();
      await admin`INSERT INTO omni_auth_sessions(id,user_id,tenant_id,token_hash,expires_at) VALUES(${sessionId},${userId},${tenantId},${randomBytes(32).toString('hex')},NOW()+interval '1 hour')`;
      await admin`INSERT INTO omni_web_push_registrations(id,tenant_id,actor_id,user_id,session_id,endpoint_sha256,subscription,state) VALUES(${`web_registration_${randomBytes(24).toString('hex')}`},${tenantId},${owner.ownerActorId},${userId},${sessionId},${randomBytes(32).toString('hex')},'{}'::jsonb,'active')`;
      for (const version of [61,62]) {
        const mobileSession = randomUUID(), deviceId = `synthetic-${version}-${randomUUID()}`;
        await admin`INSERT INTO omni_mobile_sessions(id,family_id,user_id,tenant_id,device_id,device_name,platform,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at,app_version,app_build_number,client_contract_version,client_attested_at) VALUES(${mobileSession},${randomUUID()},${userId},${tenantId},${deviceId},'Synthetic Android','android',${randomBytes(32).toString('hex')},${randomBytes(32).toString('hex')},NOW()+interval '1 hour',NOW()+interval '1 day','1.39.2',115,${version},NOW())`;
        await admin`INSERT INTO omni_mobile_push_registrations(id,tenant_id,owner_actor_id,user_id,mobile_session_id,device_id,platform,provider,environment,token_sha256,token_bundle,preview_policy,last_registered_at) VALUES(${randomUUID()},${tenantId},${actor.email},${userId},${mobileSession},${deviceId},'android','fcm','production',${randomBytes(32).toString('hex')},'{}'::jsonb,'hidden',NOW())`;
      }
    }
    return { actor, owner, configuration, stored, token, time };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const fence = (f: Fixture, seconds = 0) => ({ owner: f.owner, cycleId: f.stored.cycle.id, expectedRevision: f.stored.cycle.revision, leaseToken: f.token, now: f.time(seconds) });
  async function queue(f: Fixture, purpose: "baseline" | "candidate", seconds = 0) {
    const runtime = Object.keys(f.stored.runtime).length ? selfImprovementRuntimeSchema.parse(f.stored.runtime) : initialSelfImprovementRuntime();
    const attempt = f.stored.cycle.correctionsUsed, checkpointId = `checkpoint-${purpose}-${attempt}`;
    const { snapshotSha256: _oldSnapshot, ...snapshotBody } = { ...sample.request.snapshot, cycleId: f.stored.cycle.id, projectId: f.configuration.projectId, checkpointId,
      ...(purpose === 'baseline' ? { files: sample.request.snapshot.files.filter(file => sample.request.focusedTestPaths.includes(file.path)),
        workspaceSha256: attempt === 0 ? sample.request.snapshot.workspaceSha256 : 'd'.repeat(64) } : {}) };
    const { requestSha256: _oldRequest, ...requestBody } = { ...sample.request, cycleId: f.stored.cycle.id, tenantId, ownerActorId: f.owner.ownerActorId, projectId: f.configuration.projectId, checkpointId,
      requestId: `self_native_${selfImprovementNativeSha('native-test-id', { cycleId: f.stored.cycle.id, purpose, attempt })}`, purpose, policySha256: f.configuration.policy.policySha256,
      snapshot: { ...snapshotBody, snapshotSha256: selfImprovementNativeSha('native_source_snapshot', snapshotBody) }, createdAt: f.time(seconds), expiresAt: f.time(seconds + 3_600) };
    const request = nativeValidationRequestSchema.parse({ ...requestBody, requestSha256: selfImprovementNativeSha('native_validation_request', requestBody) });
    runtime.phase = purpose === "baseline" ? "baseline_check" : "verify";
    runtime.plan = { releaseTarget: "macos_app", summary: "Fix title", sourcePaths: request.analyzePaths.filter(path => path.includes('/lib/')), newSourcePaths: [], focusedTestPaths: request.focusedTestPaths, adjacentTestPaths: request.adjacentTestPaths, acceptanceCriteria: ["Title visible"] };
    runtime.native = runtime.native ?? { version: 1, requests: [], activeRequestId: null, baselineCheckpointId: null, waitedMs: 0, waitStartedAt: null };
    if (purpose === 'baseline') {
      runtime.native.baselineCheckpointId = checkpointId;
      runtime.preparations = [...(runtime.preparations || []), { attempt, workspaceSha256: request.snapshot.workspaceSha256,
        testHashes: Object.fromEntries(request.snapshot.files.map(file => [file.path, file.afterSha256!])), checks: [], accepted: false }];
    }
    runtime.native.requests.push({ request, status: "queued", controllerId: null, receipt: null, holdCategory: null, claimedAt: null }); runtime.native.activeRequestId = request.requestId; runtime.native.waitStartedAt = f.time(seconds);
    f.stored = await updateSelfImprovementCycleRuntime({ ...fence(f, seconds), runtime, patch: { builderSessionId: request.sessionId, checkpointId } });
    f.stored = await releaseSelfImprovementExecutionLease(fence(f, seconds));
    return request;
  }
  function receipt(f: Fixture, request: NativeValidationRequest, controllerId: string, seconds: number): NativeValidationReceipt {
    const checks = (request.purpose === 'baseline' ? sample.receipt.checks.slice(0,2) : sample.receipt.checks).map(check => ({ ...check, startedAt: f.time(seconds - 1), completedAt: f.time(seconds),
      workspaceBeforeSha256: request.snapshot.workspaceSha256, workspaceAfterSha256: request.snapshot.workspaceSha256,
      ...(request.purpose === 'baseline' && check.command === 'macos_test_focused' ? { exitCode: 1, testSummary: { ...check.testSummary!, passedTests: 1, failedTests: 1 } } : {}) }));
    const { receiptSha256: _oldReceipt, ...body } = { ...sample.receipt, requestId: request.requestId, requestSha256: request.requestSha256, snapshotSha256: request.snapshot.snapshotSha256,
      workspaceSha256: request.snapshot.workspaceSha256, controllerId, checks, artifact: request.purpose === 'baseline' ? null : sample.receipt.artifact, completedAt: f.time(seconds) };
    return nativeValidationReceiptSchema.parse({ ...body, receiptSha256: selfImprovementNativeSha('native_validation_receipt', body) });
  }
  const claim = (f: Fixture, request: NativeValidationRequest, controllerId = 'publisher', seconds = 10) => claimSelfImprovementNativeValidation({ owner: f.owner, cycleId: f.stored.cycle.id, requestId: request.requestId, requestSha256: request.requestSha256, controllerId, now: f.time(seconds) });
  const lease = (f: Fixture, request: NativeValidationRequest, token: string, seconds = 30, controllerId = 'publisher') => ({ owner: f.owner, cycleId: f.stored.cycle.id, requestId: request.requestId, controllerId, leaseToken: token, now: f.time(seconds) });
  async function resume(f: Fixture, seconds: number) { f.stored = (await getSelfImprovementCycle(f.owner, f.stored.cycle.id))!; f.stored = await renewSelfImprovementCycleLease({ owner: f.owner, cycleId: f.stored.cycle.id, expectedRevision: f.stored.cycle.revision, now: f.time(seconds) }); f.token = f.stored.leaseToken!; }
  async function recordPreparation(f: Fixture, request: NativeValidationRequest, completed: NativeValidationReceipt, seconds: number, accepted: boolean) {
    const runtime = selfImprovementRuntimeSchema.parse(f.stored.runtime), preparation = runtime.preparations!.at(-1)!;
    expect(runtime.native!.baselineCheckpointId).toBe(request.checkpointId);
    preparation.checks = completed.checks.map((check,index) => ({ output: check.outputTail || '', reportComplete: check.command !== 'macos_test_focused' || !!check.testSummary && !check.testReportFailure,
      evidence: { executionId: `${request.requestId}:${index}`, command: check.command, paths: check.paths, exitCode: check.exitCode,
        outputSha256: check.outputSha256, workspaceSha256: completed.workspaceSha256, completedAt: check.completedAt,
        totalTests: check.testSummary?.totalTests || 0, passedTests: check.testSummary?.passedTests || 0, failedTests: check.testSummary?.failedTests || 0,
        pendingTests: check.testSummary?.pendingTests || 0, executedPaths: check.testSummary?.executedPaths || [] } }));
    expect(improvementPreparationPassed(preparation,runtime.plan!)).toBe(accepted);
    preparation.accepted = accepted;
    runtime.baseline = accepted ? preparation.checks[1].evidence : null;
    runtime.sourceHashes = accepted ? preparation.testHashes : {};
    runtime.phase = accepted ? 'implement' : 'reproduce';
    if (!accepted) { runtime.correctionKind = 'test_preparation'; runtime.native!.activeRequestId = null; runtime.native!.baselineCheckpointId = null; }
    f.stored = await updateSelfImprovementCycleRuntime({...fence(f,seconds),runtime});
  }
  const counts = async (f: Fixture) => scoped(f.actor, async () => ({
    inbox: Number((await getSql()`SELECT count(*) AS n FROM omni_personal_notifications WHERE tenant_id=${tenantId} AND actor_id=${f.owner.ownerActorId} AND source_id=${f.stored.cycle.id}`)[0].n),
    browser: Number((await getSql()`SELECT count(*) AS n FROM omni_web_push_deliveries WHERE tenant_id=${tenantId} AND actor_id=${f.owner.ownerActorId}`)[0].n),
    mobile: Number((await getSql()`SELECT count(*) AS n FROM omni_mobile_push_deliveries WHERE tenant_id=${tenantId} AND owner_actor_id=${f.actor.email}`)[0].n),
    dispositions: Number((await getSql()`SELECT count(*) AS n FROM omni_notification_dispositions WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND source_id=${f.stored.cycle.id}`)[0].n),
  }));

  async function publication(native = true, prepared = true, criterionProof = true) {
    const f = await fixture({ agoSeconds: 1_200 });
    const candidate = sealSelfImprovementCandidate({ ...(native ? { releaseTarget: "macos_app" as const } : {}), revision: "b".repeat(40), workspaceSha256: sample.request.snapshot.workspaceSha256, diffSha256: sha,
      changedFiles: native ? sample.request.snapshot.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })) : [{ path: "src/lib/studio/display.ts", beforeSha256: sha, afterSha256: "f".repeat(64) }], changedLines: 12, architectureImpact: "minor" });
    const binding = { requestId: sample.request.requestId, requestSha256: sample.request.requestSha256, snapshotSha256: sample.request.snapshot.snapshotSha256,
      receiptSha256: sample.receipt.receiptSha256, artifact: sample.receipt.artifact!, installedBaseline: sample.receipt.installedBaseline, pairedBaseline: { ...sample.receipt.pairedBaseline, manifestSha256: canonicalJsonSha256("synthetic-reconciled-manifest") } };
    let validation = sealSelfImprovementValidation({ scope: f.stored.cycle.scope, policySha256: f.stored.cycle.policy.policySha256, signalSha256: f.stored.cycle.signal!.signalSha256, candidateSha256: candidate.candidateSha256,
      candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, ...(native ? { native: binding } : {}),
      checks: (["focused_regression", "adjacent_regression", "typecheck", "build", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: "synthetic-recorded-check", candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, evidenceSha256: sha, declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: f.time(70) })) });
    // New synthetic criterion proof is explicit. The negative retains the old
    // readable aggregate-only review and must fail at the real claim boundary.
    const reviewed = withSyntheticCriterionReview({ ...f.stored, cycle: { ...f.stored.cycle, candidate, validation } });
    if (criterionProof) validation = reviewed.cycle.validation!;
    const approval = sealSelfImprovementApproval({ approvalId: "synthetic-exact-owner-review", ...f.owner, candidateSha256: candidate.candidateSha256, validationSha256: validation.validationSha256, policySha256: f.stored.cycle.policy.policySha256,
      ...(native ? { nativeArtifactSha256: binding.artifact.artifactSha256, nativeBaselineSha256: binding.installedBaseline.baselineSha256 } : {}), decision: "approved", approvedAt: f.time(90), expiresAt: f.time(3_600) });
    f.stored = await transitionSelfImprovementCycle({ ...fence(f, 40), nextStage: "implementing" });
    f.stored = await transitionSelfImprovementCycle({ ...fence(f, 60), nextStage: "validating" });
    f.stored = await updateSelfImprovementCycleRuntime({ ...fence(f, 80), runtime: criterionProof ? reviewed.runtime : { ...initialSelfImprovementRuntime(), phase: "release_wait" },
      patch: { builderSessionId: reviewed.cycle.builderSessionId, checkpointId: reviewed.cycle.checkpointId, verificationId: reviewed.cycle.verificationId } });
    f.stored = await transitionSelfImprovementCycle({ ...fence(f, 90), nextStage: "review_required", patch: { candidate, validation, pullRequestUrl: "https://github.com/isolated/native/pull/1" } });
    f.stored = await transitionSelfImprovementCycle({ ...fence(f, 100), nextStage: "ready_for_release", patch: { approval } });
    f.stored = await releaseSelfImprovementExecutionLease(fence(f, 110));
    const claimed = await claimSelfImprovementReleaseCycle({ owner: f.owner, cycleId: f.stored.cycle.id, candidateRevision: candidate.revision, controllerId: "publisher", now: f.time(120) });
    f.stored = claimed; f.token = claimed.leaseToken!;
    const release = sealSelfImprovementReleaseBinding({ releaseId: "synthetic-native-publication", scope: f.stored.cycle.scope, previousRevision: f.stored.cycle.scope.baseRevision,
      sourceCandidateRevision: candidate.revision, candidateRevision: "c".repeat(40), sourceTree: "d".repeat(40), mergedTree: "d".repeat(40), pullRequestUrl: f.stored.cycle.pullRequestUrl!, candidateSha256: candidate.candidateSha256,
      validationSha256: validation.validationSha256, policySha256: f.stored.cycle.policy.policySha256, ...(native ? { releaseTarget: "macos_app" as const, native: { ...binding, approvalSha256: approval.receiptSha256 }, runner: "asael_macos_publisher" as const } : { runner: "asael_paired_production" as const }) });
    if (prepared) f.stored = await transitionSelfImprovementCycle({ ...fence(f, 130), nextStage: "releasing", patch: { release } });
    return { ...f, release };
  }

  it("keeps historical native review rows readable but refuses a new claim without criterion proof", async () => {
    await expect(publication(true, true, false)).rejects.toThrow(/per-criterion review receipt/);
  });

  it("recovers native settlement authority only with the latest expired token and never for another target or phase", async () => {
    for (const [native, prepared] of [[false, true], [true, false]] as const) {
      const f = await publication(native, prepared);
      await expect(recoverSelfImprovementNativeReleaseCompletion({ owner: f.owner, cycleId: f.stored.cycle.id, leaseToken: f.token, controllerId: "publisher", releaseBindingSha256: f.release.releaseBindingSha256, now: f.time(1_000) })).rejects.toThrow(/exact prepared native/);
    }
    const f = await publication(), original = f.stored;
    const input = { owner: f.owner, cycleId: f.stored.cycle.id, leaseToken: f.token, controllerId: "publisher", releaseBindingSha256: f.release.releaseBindingSha256, now: f.time(1_000) };
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, now: f.time(200) })).rejects.toThrow(/live lease/);
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, leaseToken: "wrong" })).rejects.toThrow(/latest controller token/);
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, controllerId: "other" })).rejects.toThrow(/latest controller token/);
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, releaseBindingSha256: "f".repeat(64) })).rejects.toThrow(/exact prepared native/);
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, owner: { ...f.owner, tenantId: "other" } })).rejects.toThrow();
    await pauseSelfImprovement({ owner: f.owner, configurationId: f.configuration.id, expectedGeneration: f.configuration.generation, paused: true, now: f.time(800) });
    const attempts = await Promise.allSettled([recoverSelfImprovementNativeReleaseCompletion(input), recoverSelfImprovementNativeReleaseCompletion(input)]);
    expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const accepted = attempts.find(value => value.status === "fulfilled")!; if (accepted.status !== "fulfilled") throw new Error("missing recovery");
    const recovered = accepted.value;
    expect(recovered.runtime.releaseRecoveryOnly).toEqual({ version: 1, releaseBindingSha256: f.release.releaseBindingSha256, controllerId: "publisher", recoveredAt: input.now });
    expect(recovered.cycle.release).toEqual(original.cycle.release); expect(recovered.cycle.candidate).toEqual(original.cycle.candidate); expect(recovered.spendUsd).toBe(original.spendUsd);
    await expect(readSelfImprovementReleaseLease({ ...input, now: f.time(1_010) })).rejects.toThrow(/stale/);
    await expect(recoverSelfImprovementNativeReleaseCompletion({ ...input, now: f.time(1_400) })).rejects.toThrow(/latest controller token/);
    const events = await scoped(f.actor, () => getSql()`SELECT payload FROM omni_events WHERE tenant_id=${tenantId} AND type='self_improvement.release.completion_recovered' AND payload->>'cycleId'=${f.stored.cycle.id}`);
    expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain(recovered.leaseToken!);
  });

  it("reconciles exact native completion once after recovery, acknowledges replay and forbids prepare", async () => {
    const f = await publication(), recovered = await recoverSelfImprovementNativeReleaseCompletion({ owner: f.owner, cycleId: f.stored.cycle.id, leaseToken: f.token, controllerId: "publisher", releaseBindingSha256: f.release.releaseBindingSha256, now: f.time(1_000) });
    const auth = { tenantId, actorId: f.actor.email, role: "admin" as const, source: "session" as const, auth: { userId: f.actor.userId, email: f.actor.email, sessionId: "synthetic", tenantName: "Native" } };
    const shared = { cycleId: f.stored.cycle.id, controllerId: "publisher", leaseToken: recovered.leaseToken! };
    await expect(executeSelfImprovementControllerAction(auth, { action: "prepare", ...shared, mergedRevision: f.release.candidateRevision, sourceTree: f.release.sourceTree, mergedTree: f.release.mergedTree })).rejects.toThrow(/completion and hold only/);
    const native = f.release.native!, baseline = native.installedBaseline;
    const nativeReceipt = { releaseBindingSha256: f.release.releaseBindingSha256, outcome: "rolled_back" as const, ...native.pairedBaseline, healthEvidenceSha256: sha, behaviorEvidenceSha256: f.release.validationSha256, evidenceSha256: sha, recordedAt: new Date().toISOString(),
      nativeInstall: { artifactSha256: native.artifact.artifactSha256, baselineSha256: baseline.baselineSha256, unsignedBundleSha256: native.artifact.unsignedBundleSha256, installedBundleSha256: baseline.bundleSha256,
        version: baseline.version, buildNumber: baseline.buildNumber, signingIdentitySha256: baseline.signingIdentitySha256, designatedRequirementSha256: baseline.designatedRequirementSha256, codeSignatureSha256: sha, startupEvidenceSha256: sha, installationReceiptSha256: sha } };
    const manifest = "synthetic-reconciled-manifest";
    const input = { action: "complete", ...shared, releaseUsage: { phaseId: "release:publisher", actualUsd: 0, evidenceSha256: sha }, receipt: nativeReceipt };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("fly.dev") ? { status: "healthy", service: "asael-openai-egress", revision: native.pairedBaseline.workerRevision } : { status: "healthy", revision: native.pairedBaseline.webRevision, releaseManifest: manifest })));
    try {
      const completed = await executeSelfImprovementControllerAction(auth, input);
      expect(completed).toMatchObject({ cycleId: f.stored.cycle.id, stage: "rolled_back" });
      const state = await getSelfImprovementCycle(f.owner, f.stored.cycle.id), revision = state!.cycle.revision;
      expect(await executeSelfImprovementControllerAction(auth, input)).toEqual(completed);
      expect((await getSelfImprovementCycle(f.owner, f.stored.cycle.id))!.cycle.revision).toBe(revision);
      expect((await readSelfImprovementReleaseLease({ owner: f.owner, ...shared, allowCompletedNative: true, now: f.time(1_400) })).cycle.releaseReceipt).toEqual(state!.cycle.releaseReceipt);
      await expect(readSelfImprovementReleaseLease({ owner: f.owner, ...shared, now: f.time(1_400) })).rejects.toThrow(/stale/);
      await expect(readSelfImprovementReleaseLease({ owner: f.owner, ...shared, leaseToken: f.token, allowCompletedNative: true, now: f.time(1_400) })).rejects.toThrow(/stale/);
      await expect(executeSelfImprovementControllerAction(auth, { ...input, receipt: { ...nativeReceipt, evidenceSha256: "f".repeat(64) } })).rejects.toThrow(/immutable/);
      await expect(recoverSelfImprovementNativeReleaseCompletion({ owner: f.owner, ...shared, releaseBindingSha256: f.release.releaseBindingSha256, now: f.time(1_400) })).rejects.toThrow(/exact prepared native/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("serializes claims and fences exact owner, request, controller and token without leaking source", async () => {
    const f = await fixture(), request = await queue(f,'baseline');
    expect(await scoped(f.actor, async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_self_improvement_cycles') AS active FROM pg_roles WHERE rolname=current_user`)[0])).toMatchObject({ rolsuper:false,rolbypassrls:false,active:true });
    await expect(claimSelfImprovementNativeValidation({ owner: f.owner, cycleId:f.stored.cycle.id,requestId:request.requestId,requestSha256:'f'.repeat(64),controllerId:'publisher',now:f.time(10) })).rejects.toThrow(/changed/);
    const attempts = await Promise.allSettled([claim(f,request),claim(f,request)]);
    expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    const accepted = attempts.find(item=>item.status==='fulfilled')!; if(accepted.status!=='fulfilled') throw new Error('missing claim');
    f.stored=accepted.value.cycle; const token=f.stored.leaseToken!;
    await expect(readSelfImprovementNativeLease({...lease(f,request,'wrong')})).rejects.toThrow(/stale/);
    await expect(readSelfImprovementNativeLease({...lease(f,request,token),controllerId:'other'})).rejects.toThrow(/another publisher/);
    expect(await getSelfImprovementCycle({tenantId:'foreign-tenant',ownerActorId:f.owner.ownerActorId},f.stored.cycle.id)).toBeNull();
    const foreignUser=randomUUID(), foreignActor=`actor:${foreignUser}`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${foreignUser},${`${foreignUser}@example.test`},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${foreignUser},'admin')`;
    expect(await getSelfImprovementCycle({tenantId,ownerActorId:foreignActor},f.stored.cycle.id)).toBeNull();
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,request,token),receipt:receipt(f,request,'publisher',20)});
    await expect(finishSelfImprovementNativeValidation({...lease(f,request,token),receipt:receipt(f,request,'publisher',20)})).rejects.toThrow(/stale/);
    expect(selfImprovementRuntimeSchema.parse(f.stored.runtime).native!.requests[0].status).toBe('completed');
    expect(await counts(f)).toEqual({inbox:0,browser:0,mobile:0,dispositions:0});
  });
  it("binds candidate completion to the same recorded baseline toolchain, installed app and server pair", async () => {
    const f=await fixture(), baseline=await queue(f,'baseline'), accepted=await claim(f,baseline);
    const baselineReceipt=receipt(f,baseline,'publisher',20);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,baseline,accepted.cycle.leaseToken!),receipt:baselineReceipt});
    await resume(f,40); await recordPreparation(f,baseline,baselineReceipt,40,true);
    f.stored=await transitionSelfImprovementCycle({...fence(f,40),nextStage:'implementing'}); f.stored=await transitionSelfImprovementCycle({...fence(f,40),nextStage:'validating'});
    const request=await queue(f,'candidate',40), held=await claim(f,request,'publisher',50), good=receipt(f,request,'publisher',70);
    for(const mutate of [
      (r:NativeValidationReceipt)=>{r.toolchainSha256='f'.repeat(64); r.artifact=null;},
      (r:NativeValidationReceipt)=>{const {baselineSha256:_hash,...body}={...r.installedBaseline,bundleSha256:'e'.repeat(64)};r.installedBaseline={...body,baselineSha256:selfImprovementNativeSha('native_installed_baseline',body)};},
      (r:NativeValidationReceipt)=>{r.pairedBaseline={...r.pairedBaseline,webRevision:'f'.repeat(40),workerRevision:'f'.repeat(40)};},
    ]) {const changed=structuredClone(good);mutate(changed);const {receiptSha256:_hash,...body}=changed;await expect(finishSelfImprovementNativeValidation({...lease(f,request,held.cycle.leaseToken!,80),receipt:{...body,receiptSha256:selfImprovementNativeSha('native_validation_receipt',body)}})).rejects.toThrow(/baseline app, toolchain or server pair/);}
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,request,held.cycle.leaseToken!,80),receipt:good});
    const saved=selfImprovementRuntimeSchema.parse(f.stored.runtime).native!;
    expect(saved.requests.map(item=>item.status)).toEqual(['completed','completed']);expect(saved.requests[0].receipt).toEqual(receipt(f,baseline,'publisher',20));expect(saved.requests[1].receipt).toEqual(good);
  });
  it("claims only the exact corrected preparation and binds the candidate to its accepted second baseline", async () => {
    const f=await fixture(), first=await queue(f,'baseline'), firstClaim=await claim(f,first);
    const reseal=(value:NativeValidationReceipt) => {const {receiptSha256:_old,...body}=value;return nativeValidationReceiptSchema.parse({...body,receiptSha256:selfImprovementNativeSha('native_validation_receipt',body)});};
    const failed=receipt(f,first,'publisher',20);failed.checks[0].exitCode=1;failed.toolchainSha256='f'.repeat(64);
    const failedReceipt=reseal(failed);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,first,firstClaim.cycle.leaseToken!),receipt:failedReceipt});
    await resume(f,40);await recordPreparation(f,first,failedReceipt,40,false);
    f.stored=await transitionSelfImprovementCycle({...fence(f,40),nextStage:'correcting',patch:{correctionsUsed:1}});
    const second=await queue(f,'baseline',50), saved=selfImprovementRuntimeSchema.parse(f.stored.runtime);
    expect(second.requestId).not.toBe(first.requestId);expect(second.checkpointId).not.toBe(first.checkpointId);
    const mutations=[
      (runtime:typeof saved)=>{runtime.correctionKind='source';},
      (runtime:typeof saved)=>{runtime.phase='implement';},
      (runtime:typeof saved)=>{runtime.preparations![1].attempt=0;},
      (runtime:typeof saved)=>{runtime.native!.baselineCheckpointId=first.checkpointId;},
      (runtime:typeof saved)=>{runtime.preparations![1].workspaceSha256='e'.repeat(64);},
      (runtime:typeof saved)=>{
        const entry=runtime.native!.requests[1],{requestSha256:_old,...body}={...entry.request,ownerActorId:'foreign-owner'};
        entry.request=nativeValidationRequestSchema.parse({...body,requestSha256:selfImprovementNativeSha('native_validation_request',body)});
      },
    ];
    let seconds=51;
    for(const mutate of mutations) {
      await resume(f,seconds);const changed=structuredClone(saved);mutate(changed);
      f.stored=await updateSelfImprovementCycleRuntime({...fence(f,seconds),runtime:changed});
      f.stored=await releaseSelfImprovementExecutionLease(fence(f,seconds));
      await expect(claim(f,changed.native!.requests[1].request,'publisher',seconds+1)).rejects.toThrow(/not active/);
      seconds+=2;
    }
    await resume(f,70);f.stored=await updateSelfImprovementCycleRuntime({...fence(f,70),runtime:saved});
    f.stored=await releaseSelfImprovementExecutionLease(fence(f,70));
    const secondClaim=await claim(f,second,'publisher',80), secondToken=secondClaim.cycle.leaseToken!;
    expect((await readSelfImprovementNativeLease(lease(f,second,secondToken,85))).entry.request).toEqual(second);
    const heartbeat=await renewSelfImprovementCycleLease({owner:f.owner,cycleId:f.stored.cycle.id,expectedRevision:secondClaim.cycle.cycle.revision,leaseToken:secondToken,now:f.time(90)});
    await expect(readSelfImprovementNativeLease(lease(f,second,secondToken,95))).rejects.toThrow(/stale/);
    expect((await readSelfImprovementNativeLease(lease(f,second,heartbeat.leaseToken!,95))).entry.request.requestId).toBe(second.requestId);
    const secondReceipt=receipt(f,second,'publisher',100);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,second,heartbeat.leaseToken!,110),receipt:secondReceipt});
    await resume(f,120);await recordPreparation(f,second,secondReceipt,120,true);
    f.stored=await transitionSelfImprovementCycle({...fence(f,120),nextStage:'implementing'});
    f.stored=await transitionSelfImprovementCycle({...fence(f,120),nextStage:'validating'});
    const candidateRequest=await queue(f,'candidate',120), candidateClaim=await claim(f,candidateRequest,'publisher',130);
    const candidateReceipt=receipt(f,candidateRequest,'publisher',140), wrong=structuredClone(candidateReceipt);
    wrong.toolchainSha256=failedReceipt.toolchainSha256;wrong.artifact=null;
    await expect(finishSelfImprovementNativeValidation({...lease(f,candidateRequest,candidateClaim.cycle.leaseToken!,150),receipt:reseal(wrong)})).rejects.toThrow(/baseline app, toolchain or server pair/);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,candidateRequest,candidateClaim.cycle.leaseToken!,150),receipt:candidateReceipt});
    const final=selfImprovementRuntimeSchema.parse(f.stored.runtime);
    expect(final.native!.requests.map(entry=>entry.status)).toEqual(['completed','completed','completed']);
    expect(final.native!.requests[0].receipt).toEqual(failedReceipt);
    expect(final.native!.requests[1].receipt).toEqual(secondReceipt);
    expect(final.native!.baselineCheckpointId).toBe(second.checkpointId);
    expect(final.baseline?.executionId).toBe(`${second.requestId}:1`);
    expect(final.preparations!.map(item=>item.accepted)).toEqual([false,true]);
    expect(f.stored).toMatchObject({spendUsd:0,usageState:'known',cycle:{correctionsUsed:1}});
    await expect(finishSelfImprovementNativeValidation({...lease(f,candidateRequest,candidateClaim.cycle.leaseToken!,151),receipt:candidateReceipt})).rejects.toThrow(/stale/);
    evidence.correctedPreparation = { cycle: f.stored.cycle, runtime: final, spendUsd: f.stored.spendUsd, usageState: f.stored.usageState,
      refusedAdmissionVariants: mutations.length, staleHeartbeatTokenRefused: true, staleCompletionRefused: true,
      firstReceiptPreserved: true, acceptedRequestId: second.requestId, rejectedToolchainSha256: failedReceipt.toolchainSha256 };
  });
  it("recovers only after both expiry fences, holds exactly once while paused, and stops without losing receipts",async()=>{
    const f=await fixture(),request=await queue(f,'baseline'),accepted=await claim(f,request);const token=accepted.cycle.leaseToken!;
    const recover=(seconds:number)=>holdExpiredSelfImprovementNativeValidation({owner:f.owner,cycleId:f.stored.cycle.id,requestId:request.requestId,requestSha256:request.requestSha256,now:f.time(seconds)});
    expect((await recover(400)).outcome).toBe('unchanged');
    let held=await getSelfImprovementCycle(f.owner,f.stored.cycle.id);
    const renewed=await renewSelfImprovementCycleLease({owner:f.owner,cycleId:f.stored.cycle.id,expectedRevision:held!.cycle.revision,leaseToken:token,now:f.time(3_590)});
    expect((await recover(3_601)).outcome).toBe('unchanged');
    await pauseSelfImprovement({owner:f.owner,configurationId:f.configuration.id,expectedGeneration:f.configuration.generation,paused:true,now:f.time(3_600)});
    const results=await Promise.all([recover(3_900),recover(3_900)]);expect(results.map(item=>item.outcome).sort()).toEqual(['held','unchanged']);
    held=(await getSelfImprovementCycle(f.owner,f.stored.cycle.id))!;expect(canStopSelfImprovementNativeCheck(held,f.time(3_901))).toBe(true);
    await expect(finishSelfImprovementNativeValidation({...lease(f,request,renewed.leaseToken!,3_901),holdCategory:'late'})).rejects.toThrow(/stale/);
    const stop={owner:f.owner,cycleId:held.cycle.id,expectedRevision:held.cycle.revision,requestId:request.requestId,requestSha256:request.requestSha256,now:f.time(3_901)};
    await expect(stopSelfImprovementNativeCheck({...stop,requestSha256:'f'.repeat(64)})).rejects.toThrow(/exact held/);
    const attempts=await Promise.allSettled([stopSelfImprovementNativeCheck(stop),stopSelfImprovementNativeCheck(stop)]);expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    const done=(await getSelfImprovementCycle(f.owner,held.cycle.id))!;expect(done.cycle.stage).toBe('cancelled');expect(done.runtime).toEqual(held.runtime);expect(done.spendUsd).toBe(held.spendUsd);
    expect(await scoped(f.actor,()=>getSql()`SELECT id FROM omni_events WHERE tenant_id=${tenantId} AND actor_id=${f.owner.ownerActorId} AND type='self_improvement.native_validation.stopped' AND payload->>'cycleId'=${held!.cycle.id}`)).toHaveLength(1);
  });
  it("refuses Stop with real unsettled paid rows and enables it only after exact measured settlement",async()=>{
    const f=await fixture();f.stored=(await reserveSelfImprovementPhaseBudget({...fence(f),phaseId:'retained-phase',reservedUsd:1})).cycle;
    const request=await queue(f,'baseline'),accepted=await claim(f,request);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,request,accepted.cycle.leaseToken!),holdCategory:'native_test_no_executed_cases'});
    let saved=(await getSelfImprovementCycle(f.owner,f.stored.cycle.id))!;expect(saved.unsettledPaidUsage).toBe(true);expect(canStopSelfImprovementNativeCheck(saved,f.time(40))).toBe(false);
    const stop=()=>({owner:f.owner,cycleId:saved.cycle.id,expectedRevision:saved.cycle.revision,requestId:request.requestId,requestSha256:request.requestSha256,now:f.time(60)});
    await expect(stopSelfImprovementNativeCheck(stop())).rejects.toThrow(/Unsettled paid usage/);
    await resume(f,40);f.stored=await settleSelfImprovementPhaseBudget({...fence(f,40),phaseId:'retained-phase',actualUsd:0.01,evidenceSha256:sha});f.stored=await releaseSelfImprovementExecutionLease(fence(f,40));
    saved=(await getSelfImprovementCycle(f.owner,f.stored.cycle.id))!;expect(saved.unsettledPaidUsage).toBe(false);expect(canStopSelfImprovementNativeCheck(saved,f.time(60))).toBe(true);
    expect((await stopSelfImprovementNativeCheck(stop())).cycle.stage).toBe('cancelled');
    const phases=await scoped(f.actor,()=>getSql()`SELECT state,actual_usd FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND cycle_id=${saved.cycle.id}`);
    expect(phases).toHaveLength(1); expect(phases[0].state).toBe('settled'); expect(Number(phases[0].actual_usd)).toBe(0.01);
  });
  it("co-commits one held Inbox/browser/native62 notification and deduplicates exact replay",async()=>{
    const f=await fixture({notify:true,transports:true}),request=await queue(f,'baseline'),accepted=await claim(f,request);
    f.stored=await finishSelfImprovementNativeValidation({...lease(f,request,accepted.cycle.leaseToken!),holdCategory:'native_test_no_executed_cases'});
    expect(await counts(f)).toEqual({inbox:1,browser:1,mobile:1,dispositions:1});
    const admission={tenantId,actorId:f.owner.ownerActorId,cycleId:f.stored.cycle.id,eventId:`${f.stored.cycle.id}:${f.stored.cycle.revision}:native`,eventType:'self_improvement.native_validation.held' as const,stage:f.stored.cycle.stage,requestId:request.requestId,requestSha256:request.requestSha256,category:'native_test_no_executed_cases',occurredAt:f.stored.cycle.updatedAt};
    await withAvailabilityOwner({tenantId,actorId:f.owner.ownerActorId},sql=>admitSelfImprovementNotificationWithSql(sql,admission));expect(await counts(f)).toEqual({inbox:1,browser:1,mobile:1,dispositions:1});
    expect(await withAvailabilityOwner({tenantId,actorId:f.owner.ownerActorId},sql=>admitSelfImprovementNotificationWithSql(sql,{...admission,requestSha256:'f'.repeat(64)}))).toMatchObject({state:'superseded'});
    expect(await scoped(f.actor,()=>getSql()`SELECT session.client_contract_version FROM omni_mobile_push_deliveries delivery JOIN omni_mobile_push_registrations registration ON registration.id=delivery.registration_id JOIN omni_mobile_sessions session ON session.id=registration.mobile_session_id WHERE delivery.tenant_id=${tenantId} AND delivery.owner_actor_id=${f.actor.email}`)).toMatchObject([{client_contract_version:62}]);
  });
  it("keeps quiet-hour holds pending and policy-disabled trials out of every delivery ledger",async()=>{
    const quiet=await fixture({notify:true,quiet:true}),request=await queue(quiet,'baseline'),accepted=await claim(quiet,request);
    quiet.stored=await finishSelfImprovementNativeValidation({...lease(quiet,request,accepted.cycle.leaseToken!),holdCategory:'native_test_no_executed_cases'});
    expect(await counts(quiet)).toEqual({inbox:0,browser:0,mobile:0,dispositions:1});
    await admin`UPDATE omni_today_preferences SET quiet_hours_enabled=FALSE WHERE tenant_id=${tenantId} AND actor_id=${quiet.owner.ownerActorId}`;
    const admission={tenantId,actorId:quiet.owner.ownerActorId,cycleId:quiet.stored.cycle.id,eventId:`${quiet.stored.cycle.id}:${quiet.stored.cycle.revision}:native`,eventType:'self_improvement.native_validation.held' as const,stage:quiet.stored.cycle.stage,requestId:request.requestId,requestSha256:request.requestSha256,category:'native_test_no_executed_cases',occurredAt:quiet.stored.cycle.updatedAt};
    await withAvailabilityOwner({tenantId,actorId:quiet.owner.ownerActorId},sql=>admitSelfImprovementNotificationWithSql(sql,admission));expect(await counts(quiet)).toEqual({inbox:0,browser:0,mobile:0,dispositions:1});
    // Seed a separate synthetic historical pending occurrence through the real
    // disposition API; no clocks, existing receipts or due times are rewritten.
    const due=await fixture({notify:true,notificationsEnabled:false}),dueRequest=await queue(due,'baseline'),dueClaim=await claim(due,dueRequest);
    due.stored=await finishSelfImprovementNativeValidation({...lease(due,dueRequest,dueClaim.cycle.leaseToken!),holdCategory:'native_test_no_executed_cases'});
    const occurrenceKey=`${due.stored.cycle.id}:${due.stored.cycle.revision}:native`, coordinates={tenantId,actorId:due.owner.ownerActorId,sourceKind:'self_improvement' as const,sourceId:due.stored.cycle.id,occurrenceKey};
    const past=new Date(Date.now()-20*60_000).toISOString();
    const decision=decideServerNotification({candidate:selfImprovementNotificationCandidate(coordinates),policy:{evaluatedAt:past,quietHoursActive:true,cooldownActive:false,digestEnabled:false}});
    await withAvailabilityOwner({tenantId,actorId:due.owner.ownerActorId},sql=>applyNotificationDispositionDecision({sql,now:new Date(past),decision,
      coordinates:notificationDispositionCoordinates({...coordinates,ownerActorId:due.owner.ownerActorId,decision}),
      executionScope:notificationDecisionExecutionScope({tenantId,actorId:due.owner.ownerActorId,sourceId:due.stored.cycle.id,producerId:'self-improvement-alert',decision})}));
    await admin`UPDATE omni_today_preferences SET notifications_enabled=TRUE WHERE tenant_id=${tenantId} AND actor_id=${due.owner.ownerActorId}`;
    const dueAdmission={...admission,actorId:due.owner.ownerActorId,cycleId:due.stored.cycle.id,eventId:occurrenceKey,requestId:dueRequest.requestId,requestSha256:dueRequest.requestSha256,occurredAt:due.stored.cycle.updatedAt};
    await withAvailabilityOwner({tenantId,actorId:due.owner.ownerActorId},sql=>admitSelfImprovementNotificationWithSql(sql,dueAdmission));
    await withAvailabilityOwner({tenantId,actorId:due.owner.ownerActorId},sql=>admitSelfImprovementNotificationWithSql(sql,dueAdmission));
    expect(await counts(due)).toEqual({inbox:1,browser:0,mobile:0,dispositions:1});
    const silent=await fixture({notify:false,transports:true}),silentRequest=await queue(silent,'baseline'),silentClaim=await claim(silent,silentRequest);
    silent.stored=await finishSelfImprovementNativeValidation({...lease(silent,silentRequest,silentClaim.cycle.leaseToken!),holdCategory:'native_test_no_executed_cases'});
    expect(await counts(silent)).toEqual({inbox:0,browser:0,mobile:0,dispositions:0});
  });
});
