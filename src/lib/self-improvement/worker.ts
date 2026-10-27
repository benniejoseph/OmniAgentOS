import { createHash } from "node:crypto";
import { getProjectBuilderSession, getBuilderCheckpoint, getBuilderVerification } from "@/lib/app-builder/store";
import { getBuilderRepositoryBinding, listBuilderDeliveries } from "@/lib/app-builder/delivery-store";
import { readBuilderGithubCandidateComparison } from "@/lib/app-builder/github";
import { getBuilderWorkspaceManifest, readBuilderRepositoryChanges, readBuilderFile } from "@/lib/app-builder/sandbox";
import { listAgentRuns } from "@/lib/runs/store";
import { listToolExecutions } from "@/lib/tools/audit-store";
import { getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
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
  reserveImprovementPhase, selfImprovementExecutionElapsedMs, type SelfImprovementRuntime } from "./runtime";
import { initialSelfImprovementNativeRuntime, nativeCandidateValidationPassed, type NativeValidationReceipt, type NativeValidationRequest } from "./native-contracts";
import { prepareSelfImprovementNativeValidation } from "./native-service";
import { improvementInspectionPrompt, improvementReproductionPrompt, improvementImplementationPrompt, improvementReviewPrompt } from "./prompts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
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
  });
  const tool = (toolId: string, parameters: Record<string, unknown>, suffix: string) => executeImprovementTool({ authority: authority(), toolId,
    parameters, idempotencyKey: `self-improvement:${cycleId}:${suffix}`, abortSignal });
  const session = async () => {
    const found = await getProjectBuilderSession(current!.projectId, { tenantId: owner.tenantId, actorId });
    if (!found || found.id !== current!.cycle.builderSessionId) throw new Error("The improvement Builder session changed.");
    return found;
  };
  const run = async (agentId: "atlas" | "forge" | "sentinel", prompt: string, readOnly: boolean, writePaths?: string[]) => {
    const next = reserveImprovementPhase(runtime, current!.cycle.dailyReservationUsd, runtime.phase, new Date().toISOString());
    const attempt = next.phaseAttempt!;
    const reserved = await reserveSelfImprovementPhaseBudget({ ...fence(), phaseId: attempt.key, reservedUsd: attempt.costCeilingUsd });
    current = reserved.cycle;
    if (reserved.outcome !== "reserved") throw new Error("The model phase already has a reservation; automatic replay is held.");
    await persist(next);
    let result: Awaited<ReturnType<typeof runImprovementAgent>>;
    try {
      result = await runImprovementAgent({ authority: authority({ readOnly, sessionId: current!.cycle.builderSessionId!, writePaths, allowedToolIds: readOnly ? SELF_IMPROVEMENT_READ_TOOLS : writingTools }),
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
    await persist({ ...runtime, phaseAttempt: null, agentRuns: runtime.agentRuns.map((item) => item.runId === result.runId ? { ...item, completed: true } : item) });
    if (result.measuredCostUsd === null) throw new Error("Model usage could not be fully reconciled; further autonomous work is held.");
    if (result.completion !== "complete") throw new Error(`Self-improvement ${agentId} phase is incomplete (${result.completion}); its actual usage and run evidence are retained.`);
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
      totalTests: check.testSummary?.totalTests || 0, passedTests: check.testSummary?.passedTests || 0, failedTests: check.testSummary?.failedTests || 0, completedAt: check.completedAt };
  };
  try {
    await authority().assertCurrent();
    if (runtime.phaseAttempt) throw new Error("An interrupted paid phase is retained for reconciliation and will not be replayed automatically.");
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
      await run("forge", improvementReproductionPrompt({ projectId: current.projectId, sessionId: s.id, plan: runtime.plan }), false, runtime.plan.focusedTestPaths);
      const changes = await readBuilderRepositoryChanges({ sandboxName: s.sandboxName, repositoryId: current.repositoryId, baseSha: current.cycle.scope.baseRevision });
      if (!changes.length || changes.some((change) => change.kind !== "upsert" || !runtime.plan!.focusedTestPaths.includes(change.file.path))) throw new Error("Reproduction altered files outside the selected tests.");
      const tests = await Promise.all(runtime.plan.focusedTestPaths.map((path) => readBuilderFile(s.sandboxName, path, { startLine: 1, lineCount: 1 })));
      await persist({ ...runtime, phase: "baseline_check", sourceHashes: { ...runtime.sourceHashes, ...Object.fromEntries(tests.map((file) => [file.path, file.sha256])) } });
    } else if (runtime.phase === "baseline_check") {
      if (!runtime.plan) throw new Error("The reproduction plan is missing.");
      let evidence: NonNullable<SelfImprovementRuntime["baseline"]>, output: string;
      if (runtime.plan.releaseTarget === "macos_app") {
        if (!runtime.native?.baselineCheckpointId) {
          const s = await session();
          const checkpoint = await tool("app.projects.builder.checkpoint.create", { sessionId: s.id, expectedSessionRevision: s.revision,
            reason: "after_forge", sourceRunId: completedForgeRun(runtime, "reproduce"), label: "Native baseline reproduction" }, "native-baseline-checkpoint");
          const id = (checkpoint.data.checkpoint as { id?: string })?.id;
          if (!id) throw new Error("Native baseline checkpoint was not recorded.");
          await persist({ ...runtime, native: { ...(runtime.native || initialSelfImprovementNativeRuntime()), baselineCheckpointId: id } });
        }
        const checked = await nativeCheck("baseline", runtime.native!.baselineCheckpointId!);
        if (!checked) return { ...deferred(cycleId, "Native baseline validation is queued on the Mac."), delaySeconds: 60 };
        evidence = nativeEvidence(checked.request, checked.receipt, 0);
        output = (checked.receipt.checks[0].outputTail || "") + `\nNative baseline receipt ${checked.receipt.receiptSha256}: ${evidence.failedTests} executed failures; output ${evidence.outputSha256}.`;
      } else {
        const result = await check("test_focused", runtime.plan.focusedTestPaths, "baseline"); evidence = result.evidence; output = `${result.output.stdout}\n${result.output.stderr}`;
      }
      if (evidence.exitCode === 0 || evidence.failedTests < 1 || evidence.totalTests < 1) throw new Error("The baseline did not reproduce an executed failing test; no repair will be invented.");
      await persist({ ...runtime, phase: "implement", baseline: evidence, baselineOutput: output.slice(-12_000) });
      await move("implementing");
    } else if (runtime.phase === "implement") {
      if (!runtime.plan || !runtime.baseline) throw new Error("Implementation requires the saved failing reproduction.");
      const s = await session();
      await run("forge", improvementImplementationPrompt({ projectId: current.projectId, sessionId: s.id, plan: runtime.plan,
        failure: { receipt: runtime.baseline, output: runtime.baselineOutput }, correction: current.cycle.correctionsUsed ? runtime.summary : undefined }), false, [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths]);
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
        if (!nativeCandidateValidationPassed(checked.receipt)) {
          if (current.cycle.correctionsUsed >= 1) throw new Error("The corrected native candidate failed its exact Mac checks.");
          await persist({ ...runtime, phase: "implement", summary: `Native check receipt ${checked.receipt.receiptSha256} failed: ${checked.receipt.checks.filter(item => item.exitCode !== 0).map(item => `${item.command}:${item.outputSha256}`).join(", ")}` });
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
        if (result.evidence.exitCode !== 0) {
          if (current.cycle.correctionsUsed >= 1) throw new Error("The repaired candidate still fails its focused verification.");
          await persist({ ...runtime, phase: "implement", summary: `${result.output.stdout}\n${result.output.stderr}`.slice(-2_000) });
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
      if (!runtime.plan || !current.cycle.checkpointId || !current.cycle.verificationId) throw new Error("The reviewed candidate evidence is missing.");
      const s = await session();
      const review = await run("sentinel", improvementReviewPrompt({ projectId: current.projectId, sessionId: s.id,
        checkpointId: current.cycle.checkpointId, verificationId: current.cycle.verificationId, plan: runtime.plan,
        evidence: { baseline: runtime.baseline, checks: runtime.checks } }), true);
      const recorded = await tool("app.projects.builder.sentinel.record", { sessionId: s.id, verificationId: current.cycle.verificationId, sourceRunId: review.runId }, `review:${current.cycle.correctionsUsed}`);
      if ((recorded.data.sentinel as { verdict?: string })?.verdict !== "passed") {
        if (current.cycle.correctionsUsed >= 1) throw new Error("Sentinel blocked the corrected candidate; further work requires review.");
        await persist({ ...runtime, phase: "implement", summary: review.response.slice(0, 2_000) });
        await move("correcting", { correctionsUsed: 1 });
      } else {
        const impact = /^Architecture impact:\s*(none|minor|major)\s*$/im.exec(review.response)?.[1];
        await persist({ ...runtime, phase: "deliver", reviewRunId: review.runId, architectureImpact: impact === "none" || impact === "minor" ? impact : "major", summary: review.response.slice(0, 2_000) });
      }
    } else if (runtime.phase === "deliver") {
      if (!runtime.plan || !runtime.baseline || !runtime.reviewRunId || !current.cycle.checkpointId || !current.cycle.verificationId || !current.cycle.signal) throw new Error("The complete reviewed candidate is missing.");
      const s = await session(), builderOwner = { tenantId: owner.tenantId, actorId };
      const [binding, checkpoint, verification] = await Promise.all([
        getBuilderRepositoryBinding(s.id, builderOwner), getBuilderCheckpoint(current.cycle.checkpointId, s.id, builderOwner),
        getBuilderVerification(current.cycle.verificationId, s.id, builderOwner),
      ]);
      if (!binding || !checkpoint || !verification || verification.status !== "passed") throw new Error("Canonical Builder evidence is not ready for delivery.");
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
          evidenceSha256: sha(runtime.summary), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: new Date().toISOString() }],
      });
      const classification = classifySelfImprovementChange({ candidate, policy: current.cycle.policy });
      await persist({ ...runtime, phase: "release_wait", baselineOutput: "" }, { deliveryId: delivery.id, pullRequestUrl: delivery.pullRequestUrl });
      await move(classification.disposition === "routine" ? "ready_for_release" : "review_required", { candidate, validation });
    }
  } catch (error) {
    await persist({ ...runtime, errorCode: "phase_failed", summary: error instanceof Error ? error.message.slice(0, 2_000) : "Improvement phase failed." }).catch(() => undefined);
    await move("failed").catch(() => undefined);
    throw error;
  } finally {
    if (current && !isSelfImprovementTerminalStage(current.cycle.stage)) await releaseSelfImprovementExecutionLease(fence()).catch(() => undefined);
  }
  return isSelfImprovementTerminalStage(current.cycle.stage) || ["review_required", "ready_for_release"].includes(current.cycle.stage)
    ? { resourceId: cycleId, stage: current.cycle.stage } : deferred(cycleId);
}

function completedForgeRun(runtime: SelfImprovementRuntime, phase: "reproduce" | "implement"): string {
  const run = [...runtime.agentRuns].reverse().find(item => item.agentId === "forge" && item.phase === phase && item.completed);
  if (!run) throw new Error("The exact completed Forge phase is required before sealing its checkpoint.");
  return run.runId;
}
