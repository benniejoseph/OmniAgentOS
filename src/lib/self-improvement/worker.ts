import { createHash } from "node:crypto";
import { getProjectBuilderSession, getBuilderCheckpoint, getBuilderVerification } from "@/lib/app-builder/store";
import { getBuilderRepositoryBinding, listBuilderDeliveries } from "@/lib/app-builder/delivery-store";
import { readBuilderGithubCandidateComparison } from "@/lib/app-builder/github";
import { getBuilderWorkspaceManifest, readBuilderRepositoryChanges, readBuilderFile } from "@/lib/app-builder/sandbox";
import { listAgentRuns } from "@/lib/runs/store";
import { listToolExecutions } from "@/lib/tools/audit-store";
import { getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import { redactSensitive } from "@/lib/security/context";
import type { AppBuilderCommandKind, AppBuilderCommandResult } from "@/lib/app-builder/contracts";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import { collectEngineeringSignalsFromRuns, sealEngineeringSignal, selectEngineeringSignal } from "./evidence";
import { sealSelfImprovementCandidate, sealSelfImprovementValidation, selfImprovementSha256, type SelfImprovementStage } from "./contracts";
import { assertCurrentSelfImprovementConfiguration, classifySelfImprovementChange, isSelfImprovementTerminalStage } from "./policy";
import { getSelfImprovementCycle, getSelfImprovementConfiguration, getSelfImprovementProjectBrief, listSelfImprovementCycles, withSelfImprovementEvidenceOwner,
  holdExpiredSelfImprovementNativeValidation, renewSelfImprovementCycleLease, releaseSelfImprovementExecutionLease, updateSelfImprovementCycleRuntime,
  transitionSelfImprovementCycle, reserveSelfImprovementPhaseBudget, settleSelfImprovementPhaseBudget } from "./store";
import { assertConfiguredSelfImprovementOwner, assertSelfImprovementOwnerAuthority } from "./store";
import { SELF_IMPROVEMENT_READ_TOOLS, type SelfImprovementExecutionAuthority } from "./authority";
import { executeImprovementTool, runImprovementAgent } from "./agent";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema,
  reserveImprovementPhase, selfImprovementExecutionElapsedMs, improvementPreparationPassed, ImprovementPhaseFailure,
  type ImprovementPreparationCheck, type SelfImprovementRuntime } from "./runtime";
import { initialSelfImprovementNativeRuntime, nativeCandidateValidationPassed, type NativeValidationReceipt, type NativeValidationRequest } from "./native-contracts";
import { prepareSelfImprovementNativeValidation } from "./native-service";
import { improvementInspectionPrompt, improvementReproductionPrompt, improvementImplementationPrompt, improvementReviewPrompt } from "./prompts";
import { assertReviewCompletionBinding, reviewManifestSchema, type ReviewManifest } from "./review-contracts";
import { assessImprovementPreparation, incompleteStaticCheck } from "./validation-outcome";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const diagnostic = (text: string) => {
  const safe = String(redactSensitive(text));
  return safe.length <= 4_000 ? safe : `${safe.slice(0, 1_950)}\n[diagnostic shortened; full output remains in its execution receipt]\n${safe.slice(-1_950)}`;
};
const writingTools = [...SELF_IMPROVEMENT_READ_TOOLS, "app.projects.builder.file.update", "app.projects.builder.file.edit", "app.projects.builder.file.delete"];
const deferred = (cycleId: string, reason = "Next bounded improvement phase is queued.") => ({ __deferOperation: true as const, delaySeconds: 2, resourceId: cycleId, reason });

/** One durable delivery runs one bounded phase. It never deploys from the coding worker. */
export async function executeSelfImprovementJob(job: Pick<OperationJobRecord, "tenantId" | "payload">, abortSignal: AbortSignal, expectedRevision?: number) {
  const actorId = String(job.payload.actorId || ""), cycleId = String(job.payload.cycleId || "");
  const owner = { tenantId: job.tenantId, ownerActorId: actorId };
  let current = await getSelfImprovementCycle(owner, cycleId);
  if (!current) throw new Error("The owner-scoped improvement cycle was not found.");
  if (expectedRevision !== undefined && current.cycle.revision !== expectedRevision) throw new Error("The improvement phase revision changed; read its current state before advancing.");
  if (isSelfImprovementTerminalStage(current.cycle.stage) || ["review_required", "ready_for_release", "releasing"].includes(current.cycle.stage)) return { resourceId: cycleId, stage: current.cycle.stage };
  const priorRuntime = Object.keys(current.runtime).length ? selfImprovementRuntimeSchema.parse(current.runtime) : initialSelfImprovementRuntime();
  const pendingNative = priorRuntime.native?.requests.find(item => item.request.requestId === priorRuntime.native?.activeRequestId);
  if (pendingNative?.status === "claimed" && Date.parse(pendingNative.request.expiresAt) <= Date.now() && Date.parse(current.leaseExpiresAt) <= Date.now()) {
    const recovered = await holdExpiredSelfImprovementNativeValidation({ owner, cycleId, requestId: pendingNative.request.requestId, requestSha256: pendingNative.request.requestSha256 });
    return { ...deferred(cycleId, recovered.outcome === "held" ? "Expired Mac validation is held for the owner; no execution was repeated." : "Native validation state changed; its saved evidence is retained."), delaySeconds: 60 };
  }
  // A pause stops new work, while expired keyless claims above still become visible for reconciliation.
  const admittedConfiguration = await getSelfImprovementConfiguration(owner, current.configurationId);
  if (admittedConfiguration?.paused) return { ...deferred(cycleId, "Self-improvement is paused; the admitted phase is retained."), delaySeconds: 60 };
  if (pendingNative && ["queued", "claimed", "held"].includes(pendingNative.status) && (pendingNative.status !== "queued" || Date.parse(pendingNative.request.expiresAt) > Date.now())) return { ...deferred(cycleId, pendingNative.status === "held" ? "The Mac validation needs attention; its exact evidence is retained." : "Waiting for the Mac publisher's exact native validation."), delaySeconds: 60 };
  if (Date.parse(current.leaseExpiresAt) > Date.now()) return deferred(cycleId, "Another executor still owns the bounded phase.");
  current = await renewSelfImprovementCycleLease({ owner, cycleId, expectedRevision: current.cycle.revision });
  const token = current.leaseToken!;
  let runtime = Object.keys(current.runtime).length ? selfImprovementRuntimeSchema.parse(current.runtime) : initialSelfImprovementRuntime();
  const fence = () => ({ owner, cycleId, expectedRevision: current!.cycle.revision, leaseToken: token });
  const persist = async (next: SelfImprovementRuntime, patch?: Parameters<typeof updateSelfImprovementCycleRuntime>[0]["patch"]) => {
    current = await updateSelfImprovementCycleRuntime({ ...fence(), runtime: next, patch }); runtime = next;
  };
  const move = async (nextStage: SelfImprovementStage, patch?: Parameters<typeof transitionSelfImprovementCycle>[0]["patch"]) => {
    current = await transitionSelfImprovementCycle({ ...fence(), nextStage, patch });
  };
  const authority = (options: Partial<SelfImprovementExecutionAuthority> = {}): SelfImprovementExecutionAuthority => ({
    ...owner, projectId: current!.projectId, repositoryId: current!.repositoryId, cycleId,
    policySha256: current!.cycle.policy.policySha256, expiresAt: current!.leaseExpiresAt, readOnly: false,
    assertCurrent: async () => {
      abortSignal.throwIfAborted();
      assertConfiguredSelfImprovementOwner(owner);
      const [fresh, configuration] = await Promise.all([getSelfImprovementCycle(owner, cycleId), getSelfImprovementConfiguration(owner, current!.configurationId), assertSelfImprovementOwnerAuthority(owner, current!.projectId)]);
      if (!fresh || isSelfImprovementTerminalStage(fresh.cycle.stage) || Date.parse(fresh.leaseExpiresAt) <= Date.now() ||
          selfImprovementExecutionElapsedMs(fresh.cycle.createdAt, fresh.runtime) > fresh.cycle.policy.maxCycleDurationMs) throw new Error("Improvement authority was paused, changed or expired.");
      assertCurrentSelfImprovementConfiguration(configuration, fresh);
      if (options.sessionId) {
        const liveSession = await getProjectBuilderSession(current!.projectId, { tenantId: owner.tenantId, actorId });
        if (fresh.cycle.builderSessionId !== options.sessionId || liveSession?.id !== options.sessionId || liveSession.status !== "ready") throw new Error("The bound improvement workspace changed or is not ready.");
      }
    }, ...options,
    maxEngineeringTokensPerRun: current!.cycle.policy.maxEngineeringTokensPerRun,
  });
  const tool = (toolId: string, parameters: Record<string, unknown>, suffix: string, options: Partial<SelfImprovementExecutionAuthority> = {}) => executeImprovementTool({ authority: authority(options), toolId,
    parameters, idempotencyKey: `self-improvement:${cycleId}:${suffix}`, abortSignal });
  const session = async () => {
    const found = await getProjectBuilderSession(current!.projectId, { tenantId: owner.tenantId, actorId });
    if (!found || found.id !== current!.cycle.builderSessionId) throw new Error("The improvement Builder session changed.");
    return found;
  };
  const run = async (agentId: "atlas" | "forge" | "sentinel", prompt: string, readOnly: boolean, writePaths?: string[], reviewManifest?: ReviewManifest) => {
    const forgePlan: SelfImprovementExecutionAuthority["forgePlan"] = agentId === "forge" && runtime.plan && (runtime.phase === "reproduce" || runtime.phase === "implement")
      ? { phase: runtime.phase, plan: runtime.plan, expectedHashes: Object.fromEntries((runtime.phase === "reproduce" ? runtime.plan.sourcePaths : runtime.plan.focusedTestPaths)
        .map(path => [path, runtime.sourceHashes[path]])) } : undefined;
    if (forgePlan && Object.values(forgePlan.expectedHashes).some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new ImprovementPhaseFailure("forge_evidence_unavailable", "The saved original source or fixed regression hash is missing; Forge was not started.");
    }
    const pooled = runtime.engineeringAllocation === "settled_pool_v1";
    const next = pooled ? null : reserveImprovementPhase(runtime, current!.cycle.dailyReservationUsd, runtime.phase, new Date().toISOString());
    const reserved = await reserveSelfImprovementPhaseBudget(pooled
      ? { ...fence(), phaseId: `${runtime.phase}:${runtime.agentRuns.length}`, engineeringPhase: runtime.phase }
      : { ...fence(), phaseId: next!.phaseAttempt!.key, reservedUsd: next!.phaseAttempt!.costCeilingUsd });
    current = reserved.cycle;
    if (reserved.outcome !== "reserved") throw new Error("The model phase already has a reservation; automatic replay is held.");
    // New-cycle pool allocation and its attempt are committed together by the store.
    if (pooled) runtime = selfImprovementRuntimeSchema.parse(current.runtime);
    else await persist(next!);
    const attempt = runtime.phaseAttempt!;
    let result: Awaited<ReturnType<typeof runImprovementAgent>>;
    try {
      result = await runImprovementAgent({ authority: authority({ readOnly, sessionId: current!.cycle.builderSessionId!, writePaths, forgePlan, reviewManifest, allowedToolIds: readOnly ? SELF_IMPROVEMENT_READ_TOOLS : writingTools }),
        agentId, prompt, costCeilingUsd: attempt.costCeilingUsd, abortSignal,
        onRunStarted: async (runId) => persist({ ...runtime, agentRuns: [...runtime.agentRuns, { phase: runtime.phase, agentId, runId, costCeilingUsd: attempt.costCeilingUsd, completed: false }] }, { runId }),
      });
    } catch (error) {
      // A failed provider stream can still have incurred a charge.
      current = await settleSelfImprovementPhaseBudget({ ...fence(), phaseId: attempt.key, actualUsd: null,
        evidenceSha256: selfImprovementSha256("interrupted_agent_phase", { phaseId: attempt.key, runId: runtime.agentRuns.at(-1)?.runId ?? null }) });
      throw error;
    }
    current = await settleSelfImprovementPhaseBudget({ ...fence(), phaseId: attempt.key, actualUsd: result.measuredCostUsd,
      evidenceSha256: selfImprovementSha256("agent_phase", { runId: result.runId, responseSha256: sha(result.response) }) });
    await persist({ ...runtime, phaseAttempt: null, ...(result.reviewReceipt ? { reviewReceipt: result.reviewReceipt } : {}), ...(result.forgeReceipt ? { forgeReceipts: [...(runtime.forgeReceipts || []), result.forgeReceipt] } : {}),
      agentRuns: runtime.agentRuns.map((item) => item.runId === result.runId ? { ...item, completed: true } : item) });
    if (result.measuredCostUsd === null) throw new Error("Model usage could not be fully reconciled; further autonomous work is held.");
    if (result.completion !== "complete") throw new ImprovementPhaseFailure(result.forgeReceipt ? `forge_${result.forgeReceipt.reason}` : "phase_incomplete",
      `Self-improvement ${agentId} phase is incomplete (${result.forgeReceipt?.reason || result.completion}); its actual usage and run evidence are retained.`);
    if (agentId === "forge") {
      if (!result.forgeResult?.effects.length) throw new ImprovementPhaseFailure("forge_no_changes", "Forge did not record a completed file change; proposed text is not a saved effect.");
      const latest = new Map(result.forgeResult.effects.map(effect => [effect.path, effect]));
      const s = await session();
      for (const effect of latest.values()) {
        if (effect.sha256 === null) throw new ImprovementPhaseFailure("forge_deleted_file", "Forge deleted a selected file; this phase requires retained source and regression files.");
        const file = await readBuilderFile(s.sandboxName, effect.path, { startLine: 1, lineCount: 1 });
        if (file.sha256 !== effect.sha256) throw new ImprovementPhaseFailure("forge_effect_changed", "The recorded Forge effect no longer matches the current workspace bytes.");
      }
    }
    return result;
  };
  const check = async (command: AppBuilderCommandKind, paths: readonly string[], suffix: string) => {
    const s = await session();
    const result = await tool("app.projects.builder.command.run", { sessionId: s.id, command, ...(paths.length ? { paths } : {}) }, suffix);
    const output = result.data.result as AppBuilderCommandResult;
    if (!output || typeof output.exitCode !== "number") throw new Error("The check did not return execution evidence.");
    const workspace = await getBuilderWorkspaceManifest(s.sandboxName);
    return { output, evidence: { executionId: result.executionId, command, paths: [...paths],
      outputSha256: sha(`${output.stdout}\n${output.stderr}`), workspaceSha256: workspace.sha256,
      exitCode: output.exitCode, totalTests: output.testSummary?.totalTests || 0,
      passedTests: output.testSummary?.passedTests || 0, failedTests: output.testSummary?.failedTests || 0,
      pendingTests: output.testSummary?.pendingTests ?? 0, executedPaths: [...(output.testSummary?.executedPaths || [])],
      completedAt: new Date().toISOString() } };
  };
  const nativeCheck = async (purpose: "baseline" | "candidate", checkpointId: string): Promise<{ request: NativeValidationRequest; receipt: NativeValidationReceipt } | null> => {
    const native = runtime.native || initialSelfImprovementNativeRuntime();
    const active = native.requests.find(item => item.request.requestId === native.activeRequestId);
    if (active && active.request.purpose === purpose && active.request.checkpointId === checkpointId) {
      if (active.status === "completed" && active.receipt) return { request: active.request, receipt: active.receipt };
      if (Date.parse(active.request.expiresAt) <= Date.now()) throw new Error("The queued native validation expired without executed evidence.");
      return null;
    }
    const request = await prepareSelfImprovementNativeValidation(current!, runtime, checkpointId, purpose);
    await persist({ ...runtime, native: { ...native, activeRequestId: request.requestId, waitStartedAt: request.createdAt,
      requests: [...native.requests, { request, status: "queued", controllerId: null, receipt: null, holdCategory: null, claimedAt: null }] } });
    return null;
  };
  const nativeEvidence = (request: NativeValidationRequest, receipt: NativeValidationReceipt, index: number) => {
    const check = receipt.checks[index];
    return { executionId: `${request.requestId}:${index}`, command: check.command, paths: check.paths,
      outputSha256: check.outputSha256, workspaceSha256: receipt.workspaceSha256, exitCode: check.exitCode,
      totalTests: check.testSummary?.totalTests || 0, passedTests: check.testSummary?.passedTests || 0, failedTests: check.testSummary?.failedTests || 0,
      pendingTests: check.testSummary?.pendingTests ?? 0, executedPaths: [...(check.testSummary?.executedPaths || [])], completedAt: check.completedAt };
  };
  const assertOriginalSource = async () => {
    const s = await session();
    for (const path of runtime.plan!.sourcePaths) {
      if (!/^[a-f0-9]{64}$/.test(runtime.sourceHashes[path] || "")) throw new ImprovementPhaseFailure("forge_evidence_unavailable", "The saved original source or fixed regression hash is missing; Forge was not started.");
      const file = await readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 });
      if (file.sha256 !== runtime.sourceHashes[path]) throw new ImprovementPhaseFailure("preparation_source_changed", "Test preparation must retain the original application source.");
    }
    const changes = await readBuilderRepositoryChanges({ sandboxName: s.sandboxName, repositoryId: current!.repositoryId, baseSha: current!.cycle.scope.baseRevision });
    if (changes.some(change => change.kind !== "upsert" || !runtime.plan!.focusedTestPaths.includes(change.file.path))) {
      throw new ImprovementPhaseFailure("preparation_outside_tests", "Test preparation changed files outside the selected tests.");
    }
  };
  const requireAcceptedPreparation = () => {
    const preparation = runtime.preparations?.at(-1), baseline = preparation?.checks.at(-1)?.evidence;
    if (!runtime.plan || !preparation?.accepted || !improvementPreparationPassed(preparation, runtime.plan) ||
        !baseline || runtime.baseline?.executionId !== baseline.executionId || runtime.baseline.outputSha256 !== baseline.outputSha256 ||
        runtime.plan.focusedTestPaths.some(path => runtime.sourceHashes[path] !== preparation.testHashes[path])) {
      throw new ImprovementPhaseFailure("baseline_preparation_unproven", "Source work requires accepted test preparation; a legacy failing baseline alone is insufficient.");
    }
  };
  const finishPreparation = async () => {
    const preparation = runtime.preparations!.at(-1)!;
    await assertOriginalSource();
    const assessment = assessImprovementPreparation(preparation, runtime.plan!);
    if (assessment.outcome === "static_check_incomplete") throw incompleteCheckFailure(assessment.check);
    if (assessment.outcome === "accepted") {
      const accepted = { ...preparation, accepted: true }, baseline = accepted.checks.at(-1)!;
      await persist({ ...runtime, preparations: [...runtime.preparations!.slice(0, -1), accepted], phase: "implement",
        sourceHashes: { ...runtime.sourceHashes, ...accepted.testHashes }, baseline: baseline.evidence, baselineOutput: baseline.output });
      await move("implementing");
      return;
    }
    if (current!.cycle.correctionsUsed >= 1) throw new ImprovementPhaseFailure("test_preparation_invalid", "The corrected tests still lack passing preparation and a meaningful passing control alongside an executed failing regression.");
    await persist({ ...runtime, phase: "reproduce", correctionKind: "test_preparation", baseline: null, baselineOutput: "",
      summary: "Test preparation failed; the single correction is restricted to the selected tests before the baseline is accepted.",
      ...(runtime.native ? { native: { ...runtime.native, baselineCheckpointId: null, activeRequestId: null, waitStartedAt: null } } : {}) });
    await move("correcting", { correctionsUsed: 1 });
  };
  try {
    await authority().assertCurrent();
    if (runtime.phaseAttempt) throw new Error("An interrupted paid phase is retained for reconciliation and will not be replayed automatically.");
    if (["implement", "verify", "review", "deliver"].includes(runtime.phase)) requireAcceptedPreparation();
    if (runtime.phase === "setup") {
      if (runtime.setupStep === "create") {
        const created = await tool("app.projects.builder.create", { workspaceMode: "source_only" }, "workspace");
        const createdSession = created.data.session as { id: string; status?: string };
        if (!createdSession?.id || createdSession.status !== "ready") throw new Error("Builder did not return a ready workspace receipt.");
        await persist({ ...runtime, setupStep: "bind" }, { builderSessionId: createdSession.id });
      } else if (runtime.setupStep === "bind") {
        const s = await session();
        const bound = await tool("app.projects.builder.repository.bind", { sessionId: s.id, repositoryId: current.repositoryId }, "repository");
        const binding = bound.data.repositoryBinding as { baseSha: string };
        if (binding?.baseSha !== current.cycle.scope.baseRevision) throw new Error("The repository moved after cycle admission; start a new cycle from fresh evidence.");
        await persist({ ...runtime, setupStep: "checkout" });
      } else {
        const s = await session(), binding = await getBuilderRepositoryBinding(s.id, { tenantId: owner.tenantId, actorId });
        if (!binding || binding.baseSha !== current.cycle.scope.baseRevision) throw new Error("Repository baseline is no longer exact.");
        await tool("app.projects.builder.repository.checkout", { sessionId: s.id, repositoryBindingId: binding.id,
          expectedBindingRevision: binding.revision, expectedSessionRevision: s.revision }, "checkout");
        await persist({ ...runtime, phase: "inspect", setupStep: "complete" });
      }
    } else if (runtime.phase === "inspect") {
      const s = await session();
      // Missing owner context is a failed inspection, never evidence that no work is needed.
      const projectBrief = await getSelfImprovementProjectBrief(owner, current.projectId);
      const signals = await withSelfImprovementEvidenceOwner(owner, current.projectId, async (verifiedOwnerActorIds) => {
        const runs = (await listAgentRuns(100, { tenantId: owner.tenantId, ownerActorIds: verifiedOwnerActorIds })).filter((item) => !runtime.agentRuns.some((own) => own.runId === item.id));
        const receipts = (await listToolExecutions(100, { tenantId: owner.tenantId, actorIds: verifiedOwnerActorIds })).filter((item) => item.status === "failed").slice(0, 20);
        const receiptScopes = await Promise.all(receipts.map((item) => getToolExecutionScopeBinding(item.id, { tenantId: owner.tenantId })));
        return collectEngineeringSignalsFromRuns({ scope: current!.cycle.scope, verifiedOwnerActorIds, runs: runs.map((item) => ({ run: item, receipts: receipts.filter((_, index) => receiptScopes[index]?.executionScope.correlationId === item.id) })) });
      });
      const history = await listSelfImprovementCycles(owner, { configurationId: current.configurationId, limit: 50 });
      const resolved = history.filter((item) => item.cycle.id !== cycleId && item.cycle.stage === "succeeded");
      const selected = selectEngineeringSignal({ scope: current.cycle.scope, signals, now: new Date().toISOString(), previouslyHandledSymptomSha256: resolved.flatMap((item) => item.cycle.signal ? [item.cycle.signal.symptomSha256] : []) });
      const response = await run("atlas", improvementInspectionPrompt({ projectId: current.projectId, sessionId: s.id, baseRevision: current.cycle.scope.baseRevision, signal: selected.signal,
        projectBrief }), true);
      const decision = response.inspectionResult;
      if (!decision) throw new Error("Inspection lacks its accepted typed result receipt.");
      if (decision.decision === "no_change") {
        const isTest = (path: string) => /(?:[._](?:test|spec)\.[cm]?[jt]sx?|_test\.dart)$/.test(path);
        if (!response.inspectedPaths.some(isTest) || !response.inspectedPaths.some(path => !isTest(path))) throw new Error("Inspection did not record the required source and adjacent-test reads.");
        await persist({ ...runtime, phase: "done", summary: decision.summary }); await move("no_change");
      } else {
        if (!decision.plan.sourcePaths.every(path => response.inspectedPaths.includes(path)) || !decision.plan.adjacentTestPaths.some(path => response.inspectedPaths.includes(path))) throw new Error("The proposed repair lacks recorded source or adjacent-test reads.");
        const sources = await Promise.all(decision.plan.sourcePaths.map((path) => readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 })));
        const signal = selected.signal || sealEngineeringSignal({ version: 1, scope: current.cycle.scope, kind: "code_defect",
          summary: decision.plan.summary, symptomSha256: selfImprovementSha256("code_symptom", sources.map((source) => ({ path: source.path, sha256: source.sha256 })).sort((a, b) => a.path.localeCompare(b.path))),
          observations: sources.map((source) => ({ sourceKind: "source_file", sourceId: source.path, sourceSha256: source.sha256,
            path: source.path, sourceRevision: current!.cycle.scope.baseRevision, observedAt: new Date().toISOString(), outcome: "needs_work" })) });
        if (resolved.some((item) => item.cycle.signal?.symptomSha256 === signal.symptomSha256)) {
          await persist({ ...runtime, phase: "done", summary: "This unchanged source finding already has an improvement receipt; it was not retried." });
          await move("no_change");
        } else {
          await persist({ ...runtime, phase: "reproduce", plan: decision.plan, sourceHashes: Object.fromEntries(sources.map((source) => [source.path, source.sha256])), summary: decision.plan.summary });
          await move("planned", { signal });
        }
      }
    } else if (runtime.phase === "reproduce") {
      if (!runtime.plan) throw new Error("Atlas's saved plan is missing.");
      const s = await session();
      await assertOriginalSource();
      const failed = runtime.correctionKind === "test_preparation" ? runtime.preparations?.at(-1) : undefined;
      const reproduced = await run("forge", improvementReproductionPrompt({ projectId: current.projectId, sessionId: s.id, plan: runtime.plan,
        preparationFeedback: failed ? { attempt: failed.attempt, testHashes: failed.testHashes, checks: failed.checks } : undefined }), false, runtime.plan.focusedTestPaths);
      const changes = await readBuilderRepositoryChanges({ sandboxName: s.sandboxName, repositoryId: current.repositoryId, baseSha: current.cycle.scope.baseRevision });
      if (!changes.length) throw new ImprovementPhaseFailure("reproduction_no_changes", "Reproduction produced no workspace changes; no failing test was saved.");
      if (changes.some(change => change.kind === "delete")) throw new ImprovementPhaseFailure("reproduction_deleted_files", "Reproduction deleted a workspace file; only selected test additions or edits are permitted.");
      if (changes.some(change => change.kind === "upsert" && !runtime.plan!.focusedTestPaths.includes(change.file.path))) throw new ImprovementPhaseFailure("reproduction_outside_tests", "Reproduction changed a file outside the selected tests.");
      // A preparation repair may leave a different selected file untouched.
      // Retain its earlier proven effect, but require an unbroken same-cycle chain.
      const receipts = (runtime.forgeReceipts || []).filter(receipt => receipt.phase === "reproduce" && receipt.outcome === "completed");
      const effects = new Map<string, { first: string | null; last: string | null }>();
      const planSha256 = selfImprovementSha256("forge_plan", { phase: "reproduce", plan: runtime.plan,
        expectedHashes: Object.fromEntries(runtime.plan.sourcePaths.map(path => [path, runtime.sourceHashes[path]])) });
      if (!receipts.some(receipt => receipt.runId === reproduced.runId)) throw new ImprovementPhaseFailure("reproduction_unattributed_change", "The reproduction has no sealed same-run effect receipt.");
      for (const receipt of receipts) {
        if (receipt.sessionId !== s.id || receipt.planSha256 !== planSha256 || !runtime.agentRuns.some(run => run.runId === receipt.runId && run.phase === "reproduce" && run.completed)) throw new ImprovementPhaseFailure("reproduction_unattributed_change", "The preparation effect belongs to a different session, plan or run.");
        for (const effect of receipt.effects) {
          const previous = effects.get(effect.path);
          if (!runtime.plan.focusedTestPaths.includes(effect.path) || effect.sha256 === null || previous && previous.last !== effect.previousSha256) throw new ImprovementPhaseFailure("reproduction_unattributed_change", "The preparation effect chain is incomplete.");
          effects.set(effect.path, { first: previous ? previous.first : effect.previousSha256, last: effect.sha256 });
        }
      }
      if (changes.some(change => change.kind === "upsert" && (effects.get(change.file.path)?.last !== change.file.sha256 || effects.get(change.file.path)?.first !== (change.previousSha256 ?? null)))) {
        throw new ImprovementPhaseFailure("reproduction_unattributed_change", "The reproduction diff contains a change not established by this Forge run's recorded effects.");
      }
      const tests = await Promise.all(runtime.plan.focusedTestPaths.map((path) => readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 })));
      const workspace = await getBuilderWorkspaceManifest(s.sandboxName);
      await persist({ ...runtime, phase: "baseline_check", preparations: [...(runtime.preparations || []), {
        attempt: current.cycle.correctionsUsed, workspaceSha256: workspace.sha256,
        testHashes: Object.fromEntries(tests.map(file => [file.path, file.sha256])), checks: [], accepted: false,
      }] });
    } else if (runtime.phase === "baseline_check") {
      if (!runtime.plan) throw new Error("The reproduction plan is missing.");
      const preparation = runtime.preparations?.at(-1);
      if (!preparation || preparation.accepted) throw new ImprovementPhaseFailure("baseline_preparation_unproven", "The selected test preparation snapshot is missing.");
      await assertOriginalSource();
      const currentWorkspace = await getBuilderWorkspaceManifest((await session()).sandboxName);
      if (currentWorkspace.sha256 !== preparation.workspaceSha256) throw new ImprovementPhaseFailure("preparation_workspace_changed", "Test preparation changed after its governed write.");
      let collected: ImprovementPreparationCheck[];
      if (runtime.plan.releaseTarget === "macos_app") {
        if (!runtime.native?.baselineCheckpointId) {
          const s = await session();
          const checkpoint = await tool("app.projects.builder.checkpoint.create", { sessionId: s.id, expectedSessionRevision: s.revision,
            reason: "after_forge", sourceRunId: completedForgeRun(runtime, "reproduce"), label: "Native baseline preparation" }, `prepare:${preparation.attempt}:native-baseline-checkpoint`);
          const id = (checkpoint.data.checkpoint as { id?: string })?.id;
          if (!id) throw new Error("Native baseline checkpoint was not recorded.");
          await persist({ ...runtime, native: { ...(runtime.native || initialSelfImprovementNativeRuntime()), baselineCheckpointId: id } });
        }
        const checked = await nativeCheck("baseline", runtime.native!.baselineCheckpointId!);
        if (!checked) return { ...deferred(cycleId, "Native baseline preparation is queued on the Mac."), delaySeconds: 60 };
        if (checked.receipt.checks.length !== 2) throw new ImprovementPhaseFailure("baseline_preparation_unproven", "Native baseline preparation requires analysis and executed test-report evidence.");
        collected = checked.receipt.checks.map((check, index) => ({ evidence: nativeEvidence(checked.request, checked.receipt, index),
          output: diagnostic(check.outputTail || ""), reportComplete: check.command !== "macos_test_focused" || Boolean(check.testSummary) && !("testReportFailure" in check) }));
      } else {
        const commands = [
          { command: "lint_focused" as const, paths: runtime.plan.focusedTestPaths },
          { command: "typecheck_direct" as const, paths: [] },
          { command: "test_focused" as const, paths: runtime.plan.focusedTestPaths },
        ];
        const item = commands[preparation.checks.length];
        if (!item) throw new ImprovementPhaseFailure("preparation_receipt_changed", "Test preparation contains unexpected command evidence.");
        const result = await check(item.command, item.paths, `prepare:${preparation.attempt}:${preparation.checks.length}`);
        collected = [...preparation.checks, { evidence: result.evidence,
          output: diagnostic(`${result.output.stdout}\n${result.output.stderr}`),
          reportComplete: item.command !== "test_focused" || Boolean(result.output.testSummary) && !result.output.testReportError }];
      }
      if (collected.some(item => item.evidence.workspaceSha256 !== preparation.workspaceSha256)) throw new ImprovementPhaseFailure("preparation_workspace_changed", "A preparation check changed its workspace.");
      await persist({ ...runtime, preparations: [...runtime.preparations!.slice(0, -1), { ...preparation, checks: collected }] });
      // Collect each known static/test failure before using the one correction.
      if (collected.length === (runtime.plan.releaseTarget === "macos_app" ? 2 : 3)) await finishPreparation();
    } else if (runtime.phase === "implement") {
      if (!runtime.plan || !runtime.baseline) throw new Error("Implementation requires the saved failing reproduction.");
      const s = await session();
      await run("forge", improvementImplementationPrompt({ projectId: current.projectId, sessionId: s.id, plan: runtime.plan,
        failure: { receipt: runtime.baseline, output: runtime.baselineOutput }, correction: runtime.correctionKind === "source" ? { summary: runtime.summary, checks: runtime.correctionChecks || [] } : undefined }), false, [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths]);
      for (const path of runtime.plan.focusedTestPaths) {
        const file = await readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 });
        if (file.sha256 !== runtime.sourceHashes[path]) throw new Error("The failing regression test changed during implementation.");
      }
      await persist({ ...runtime, phase: "verify", checks: [] }, { checkpointId: null, verificationId: null });
      await move("validating");
    } else if (runtime.phase === "verify") {
      if (!runtime.plan) throw new Error("The verification plan is missing.");
      let s = await session();
      if (!current.cycle.checkpointId) {
        const checkpoint = await tool("app.projects.builder.checkpoint.create", { sessionId: s.id, expectedSessionRevision: s.revision,
          reason: "after_forge", sourceRunId: completedForgeRun(runtime, "implement"), label: "Self-improvement candidate" }, `checkpoint:${current.cycle.correctionsUsed}`);
        const sealed = checkpoint.data.checkpoint as { id: string };
        if (!sealed?.id) throw new Error("The candidate checkpoint is missing.");
        await persist(runtime, { checkpointId: sealed.id });
        s = await session();
      }
      if (runtime.plan.releaseTarget === "macos_app") {
        const checked = await nativeCheck("candidate", current.cycle.checkpointId!);
        if (!checked) return { ...deferred(cycleId, "Native candidate validation is queued on the Mac."), delaySeconds: 60 };
        const checks = checked.receipt.checks.map((_, index) => nativeEvidence(checked.request, checked.receipt, index));
        await persist({ ...runtime, checks });
        const incomplete = incompleteStaticCheck(checks);
        if (incomplete) throw incompleteCheckFailure(incomplete);
        if (!nativeCandidateValidationPassed(checked.receipt)) {
          if (current.cycle.correctionsUsed >= 1) throw new Error("The corrected native candidate failed its exact Mac checks.");
          await persist({ ...runtime, phase: "implement", correctionKind: "source", summary: `Native check receipt ${checked.receipt.receiptSha256} failed.`,
            correctionChecks: checked.receipt.checks.map((item, index) => ({ evidence: checks[index], output: diagnostic(item.outputTail || ""),
              reportComplete: item.command !== "macos_test_focused" || Boolean(item.testSummary) && !item.testReportFailure })) });
          await move("correcting", { correctionsUsed: 1 });
        } else {
          const verification = await tool("app.projects.builder.verification.run", { sessionId: s.id, checkpointId: current.cycle.checkpointId,
            expectedSessionRevision: s.revision, nativeValidationRequestId: checked.request.requestId, requireCompletedChecks: true }, `verification:${current.cycle.correctionsUsed}`);
          const recorded = verification.data.verification as { id: string; status: string };
          if (recorded?.status !== "passed") throw new Error("The exact native checkpoint verification did not pass.");
          await persist({ ...runtime, phase: "review" }, { verificationId: recorded.id });
        }
      } else {
      const lintPaths = [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths, ...runtime.plan.focusedTestPaths].filter((path) => /\.[cm]?[jt]sx?$/.test(path));
      const commands = [
        { command: "lint_focused" as const, paths: lintPaths }, { command: "typecheck_direct" as const, paths: [] },
        { command: "test_focused" as const, paths: runtime.plan.focusedTestPaths }, { command: "test_focused" as const, paths: runtime.plan.adjacentTestPaths },
      ];
      if (runtime.checks.length < commands.length) {
        const item = commands[runtime.checks.length];
        const result = await check(item.command, item.paths, `check:${current.cycle.correctionsUsed}:${runtime.checks.length}`);
        await persist({ ...runtime, checks: [...runtime.checks, result.evidence] });
        const incomplete = incompleteStaticCheck([result.evidence]);
        if (incomplete) throw incompleteCheckFailure(incomplete);
        if (result.evidence.exitCode !== 0) {
          if (current.cycle.correctionsUsed >= 1) throw new Error("The repaired candidate still fails its focused verification.");
          await persist({ ...runtime, phase: "implement", correctionKind: "source", summary: `Candidate ${item.command} failed.`,
            correctionChecks: [{ evidence: result.evidence, output: diagnostic(`${result.output.stdout}\n${result.output.stderr}`),
              reportComplete: item.command !== "test_focused" || Boolean(result.output.testSummary) && !result.output.testReportError }] });
          await move("correcting", { correctionsUsed: 1 });
        }
      } else {
        const verification = await tool("app.projects.builder.verification.run", { sessionId: s.id, checkpointId: current.cycle.checkpointId,
          expectedSessionRevision: s.revision, focusedTestPaths: runtime.plan.focusedTestPaths, adjacentTestPaths: runtime.plan.adjacentTestPaths,
          lintPaths, requireCompletedChecks: true }, `verification:${current.cycle.correctionsUsed}`);
        const recorded = verification.data.verification as { id: string; status: string };
        if (recorded?.status !== "passed") throw new Error("The assembled checkpoint verification did not pass.");
        await persist({ ...runtime, phase: "review" }, { verificationId: recorded.id });
      }
      }
    } else if (runtime.phase === "review") {
      if (!runtime.plan || !runtime.baseline || !current.cycle.checkpointId || !current.cycle.verificationId) throw new Error("The reviewed candidate evidence is missing.");
      const s = await session();
      const preparation = runtime.preparations?.at(-1);
      if (!preparation?.accepted || !improvementPreparationPassed(preparation, runtime.plan)) throw new Error("Sentinel requires accepted test preparation.");
      const builderOwner = { tenantId: owner.tenantId, actorId };
      const [checkpoint, verification, manifest] = await Promise.all([
        getBuilderCheckpoint(current.cycle.checkpointId, s.id, builderOwner), getBuilderVerification(current.cycle.verificationId, s.id, builderOwner), getBuilderWorkspaceManifest(s.sandboxName),
      ]);
      if (!checkpoint || !verification || verification.status !== "passed" || verification.checkpointId !== checkpoint.id || verification.workspaceSha256 !== checkpoint.workspaceSha256 || manifest.sha256 !== checkpoint.workspaceSha256) throw new Error("Sentinel's candidate checkpoint changed.");
      if (runtime.checks.length !== 4 || verification.checks.length !== 4 || runtime.checks.some((check, index) => check.workspaceSha256 !== checkpoint.workspaceSha256 ||
          check.command !== verification.checks[index].command || check.outputSha256 !== verification.checks[index].outputSha256 || check.exitCode !== verification.checks[index].exitCode ||
          JSON.stringify([...check.paths].sort()) !== JSON.stringify([...(verification.checks[index].paths || [])].sort()))) throw new Error("Sentinel's command evidence does not match the exact verification.");
      const paths = [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths, ...runtime.plan.focusedTestPaths, ...runtime.plan.adjacentTestPaths];
      // Supervisor metadata binds the checkpoint; it is never credited as a model read.
      const fileHashes: Record<string, string> = {};
      for (const path of paths) fileHashes[path] = (await readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 })).sha256;
      if (runtime.plan.focusedTestPaths.some(path => fileHashes[path] !== preparation.testHashes[path])) throw new Error("Frozen review tests changed.");
      const reviewManifest = reviewManifestSchema.parse({ ...owner, projectId: current.projectId, cycleId, policySha256: current.cycle.policy.policySha256,
        sessionId: s.id, checkpointId: checkpoint.id, verificationId: verification.id, workspaceSha256: checkpoint.workspaceSha256,
        planSha256: selfImprovementSha256("review_plan", runtime.plan), preparationSha256: selfImprovementSha256("review_preparation", preparation),
        checksSha256: selfImprovementSha256("review_checks", { baseline: runtime.baseline, checks: runtime.checks }),
        criteria: runtime.plan.acceptanceCriteria, sourcePaths: [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths], focusedTestPaths: runtime.plan.focusedTestPaths, fileHashes,
        checks: [runtime.baseline, ...runtime.checks].map((item, index) => ({ id: index === 0 ? "baseline" : `candidate:${index - 1}`, executionId: item.executionId,
          command: item.command, paths: item.executedPaths || item.paths, outputSha256: item.outputSha256, workspaceSha256: item.workspaceSha256,
          exitCode: item.exitCode, totalTests: item.totalTests, passedTests: item.passedTests, failedTests: item.failedTests })),
      });
      const review = await run("sentinel", improvementReviewPrompt({ projectId: current.projectId, sessionId: s.id,
        checkpointId: current.cycle.checkpointId, verificationId: current.cycle.verificationId, plan: runtime.plan,
        evidence: { preparation, baseline: runtime.baseline, baselineOutput: runtime.baselineOutput, checks: runtime.checks }, reviewManifest }), true, undefined, reviewManifest);
      if (!review.reviewReceipt) throw new Error("Sentinel has no criterion completion receipt.");
      const recorded = await tool("app.projects.builder.sentinel.record", { sessionId: s.id, verificationId: current.cycle.verificationId, sourceRunId: review.runId }, `review:${current.cycle.correctionsUsed}`, { reviewReceipt: review.reviewReceipt });
      if ((recorded.data.sentinel as { verdict?: string })?.verdict !== "passed") {
        if (current.cycle.correctionsUsed >= 1) throw new Error("Sentinel blocked the corrected candidate; further work requires review.");
        await persist({ ...runtime, phase: "implement", correctionKind: "source", correctionChecks: [], summary: review.response.slice(0, 2_000) });
        await move("correcting", { correctionsUsed: 1 });
      } else {
        const impact = review.reviewReceipt.result?.architectureImpact;
        await persist({ ...runtime, phase: "deliver", reviewRunId: review.runId, architectureImpact: impact === "none" || impact === "minor" ? impact : "major", summary: review.reviewReceipt.result?.summary || "" });
      }
    } else if (runtime.phase === "deliver") {
      if (!runtime.plan || !runtime.baseline || !runtime.reviewRunId || !current.cycle.checkpointId || !current.cycle.verificationId || !current.cycle.signal) throw new Error("The complete reviewed candidate is missing.");
      const s = await session(), builderOwner = { tenantId: owner.tenantId, actorId };
      const [binding, checkpoint, verification] = await Promise.all([
        getBuilderRepositoryBinding(s.id, builderOwner), getBuilderCheckpoint(current.cycle.checkpointId, s.id, builderOwner),
        getBuilderVerification(current.cycle.verificationId, s.id, builderOwner),
      ]);
      if (!binding || !checkpoint || !verification || verification.status !== "passed") throw new Error("Canonical Builder evidence is not ready for delivery.");
      const reviewReceipt = assertReviewCompletionBinding(runtime.reviewReceipt, { ...owner, projectId: current.projectId, cycleId, policySha256: current.cycle.policy.policySha256,
        sessionId: s.id, checkpointId: checkpoint.id, verificationId: verification.id, workspaceSha256: checkpoint.workspaceSha256, plan: runtime.plan, runId: runtime.reviewRunId,
        preparation: runtime.preparations?.at(-1), baseline: runtime.baseline, checks: runtime.checks });
      const changes = await readBuilderRepositoryChanges({ sandboxName: s.sandboxName, repositoryId: current.repositoryId, baseSha: current.cycle.scope.baseRevision });
      const allowedPaths = new Set([...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths, ...runtime.plan.focusedTestPaths]);
      if (changes.some((change) => !allowedPaths.has(change.kind === "upsert" ? change.file.path : change.path))) throw new Error("The candidate changed files outside Atlas's saved plan.");
      await tool("app.projects.builder.delivery.create", { sessionId: s.id, repositoryBindingId: binding.id,
        expectedBindingRevision: binding.revision, checkpointId: checkpoint.id, verificationId: verification.id,
        branchName: `codex/asael-improve-${cycleId.replace(/[^a-zA-Z0-9]/g, "").slice(-24)}`,
        title: runtime.plan.summary.slice(0, 170), body: `Asael improvement cycle ${cycleId}\n\n${runtime.plan.summary}\n\nValidation: failing baseline reproduction, passing focused and adjacent tests, typecheck and independent Sentinel review.`, draft: true }, "delivery");
      const delivery = (await listBuilderDeliveries(s.id, builderOwner)).find((item) => item.checkpointId === checkpoint.id && item.verificationId === verification.id && item.status === "pull_request_open");
      if (!delivery?.commitSha || !delivery.pullRequestUrl) throw new Error("GitHub delivery has no confirmed commit and pull-request receipt.");
      const comparison = await readBuilderGithubCandidateComparison({ repository: { repositoryId: current.repositoryId, ...current.cycle.scope.repository },
        baseSha: current.cycle.scope.baseRevision, headSha: delivery.commitSha });
      const expectedChangedPaths = changes.map((change) => change.kind === "upsert" ? change.file.path : change.path).sort();
      if (JSON.stringify(comparison.files.map((file) => file.path).sort()) !== JSON.stringify(expectedChangedPaths)) throw new Error("GitHub's committed diff does not match the verified workspace changes.");
      const changedFiles = changes.map((change) => change.kind === "delete" ? { path: change.path, beforeSha256: change.previousSha256, afterSha256: null }
        : { path: change.file.path, beforeSha256: change.previousSha256 ?? null, afterSha256: change.file.sha256 });
      const candidate = sealSelfImprovementCandidate({ ...(runtime.plan.releaseTarget ? { releaseTarget: runtime.plan.releaseTarget } : {}), revision: delivery.commitSha, workspaceSha256: checkpoint.workspaceSha256,
        diffSha256: selfImprovementSha256("repository_diff", changedFiles), changedFiles, changedLines: comparison.changedLines,
        architectureImpact: changes.some((change) => change.kind === "upsert" && change.previousMode && change.previousMode !== change.file.mode) ? "major" : runtime.architectureImpact });
      if (runtime.checks.length !== 4 || runtime.checks.some((item, index) => item.exitCode !== 0 || ((runtime.plan!.releaseTarget === "macos_app" ? index === 1 || index === 2 : index >= 2) && (item.totalTests < 1 || item.passedTests !== item.totalTests || item.failedTests !== 0)))) throw new Error("Candidate validation requires actual passing test counts and all four recorded checks.");
      const checks = runtime.checks.map((item, index) => ({ id: item.executionId,
        kind: runtime.plan!.releaseTarget === "macos_app" ? (["typecheck", "focused_regression", "adjacent_regression", "build"] as const)[index] : index === 0 ? "lint" as const : index === 1 ? "typecheck" as const : index === 2 ? "focused_regression" as const : "adjacent_regression" as const,
        outcome: "passed" as const, producerKind: "command" as const, producerId: item.executionId,
        candidateRevision: candidate.revision, workspaceSha256: item.workspaceSha256, evidenceSha256: item.outputSha256,
        declaredCases: item.command === "macos_test_focused" || item.command === "test_focused" ? item.totalTests : 1, executedCases: item.command === "macos_test_focused" || item.command === "test_focused" ? item.totalTests : 1, failedCases: 0, completedAt: item.completedAt }));
      const nativeCompleted = runtime.native?.requests.find(item => item.request.requestId === runtime.native?.activeRequestId);
      const nativeReceipt = nativeCompleted?.receipt;
      if (runtime.plan.releaseTarget === "macos_app" && (!nativeCompleted || !nativeReceipt?.artifact || !nativeCandidateValidationPassed(nativeReceipt))) throw new Error("Native publication requires its exact prepared artifact.");
      const validation = sealSelfImprovementValidation({ ...(nativeCompleted && nativeReceipt?.artifact ? { native: {
        requestId: nativeCompleted.request.requestId, requestSha256: nativeCompleted.request.requestSha256, snapshotSha256: nativeCompleted.request.snapshot.snapshotSha256,
        receiptSha256: nativeReceipt.receiptSha256, artifact: nativeReceipt.artifact, installedBaseline: nativeReceipt.installedBaseline, pairedBaseline: nativeReceipt.pairedBaseline,
      } } : {}), scope: current.cycle.scope, policySha256: current.cycle.policy.policySha256,
        signalSha256: current.cycle.signal.signalSha256, candidateSha256: candidate.candidateSha256, candidateRevision: candidate.revision,
        workspaceSha256: candidate.workspaceSha256, baselineReproduction: { revision: current.cycle.scope.baseRevision,
          producerId: runtime.baseline.executionId, evidenceSha256: runtime.baseline.outputSha256, executedCases: runtime.baseline.totalTests,
          failedCases: runtime.baseline.failedTests, completedAt: runtime.baseline.completedAt },
        checks: [...checks, { id: runtime.reviewRunId, kind: "independent_review", outcome: "passed", producerKind: "agent_review",
          producerId: runtime.reviewRunId, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256,
          evidenceSha256: reviewReceipt.receiptSha256, declaredCases: reviewReceipt.criterionCount, executedCases: reviewReceipt.criterionCount, failedCases: 0, completedAt: new Date().toISOString() }],
      });
      const classification = classifySelfImprovementChange({ candidate, policy: current.cycle.policy });
      await persist({ ...runtime, phase: "release_wait", baselineOutput: "" }, { deliveryId: delivery.id, pullRequestUrl: delivery.pullRequestUrl });
      await move(classification.disposition === "routine" ? "ready_for_release" : "review_required", { candidate, validation });
    }
  } catch (error) {
    await persist({ ...runtime, errorCode: error instanceof ImprovementPhaseFailure ? error.code : "phase_failed", summary: error instanceof Error ? error.message.slice(0, 2_000) : "Improvement phase failed." }).catch(() => undefined);
    await move("failed").catch(() => undefined);
    throw error;
  } finally {
    if (current && !isSelfImprovementTerminalStage(current.cycle.stage)) await releaseSelfImprovementExecutionLease(fence()).catch(() => undefined);
  }
  return isSelfImprovementTerminalStage(current.cycle.stage) || ["review_required", "ready_for_release"].includes(current.cycle.stage)
    ? { resourceId: cycleId, stage: current.cycle.stage } : deferred(cycleId);
}

function incompleteCheckFailure(check: { command: string; exitCode: number }): ImprovementPhaseFailure {
  return new ImprovementPhaseFailure("static_check_incomplete",
    `Static verification incomplete: ${check.command} ended with exit ${check.exitCode}. Its execution evidence is retained; source work remains blocked until the check completes.`);
}

function completedForgeRun(runtime: SelfImprovementRuntime, phase: "reproduce" | "implement"): string {
  const run = [...runtime.agentRuns].reverse().find(item => item.agentId === "forge" && item.phase === phase && item.completed);
  if (!run) throw new Error("The exact completed Forge phase is required before sealing its checkpoint.");
  return run.runId;
}
