import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import type { StoredSelfImprovementCycle } from "./store";
import { assertSelfImprovementCycleTransition, createSelfImprovementPolicy } from "./policy";
import { nativeValidationFixture } from "./native-test-fixtures";
import { selfImprovementNativeSha, nativeValidationRequestSchema, nativeValidationReceiptSchema } from "./native-contracts";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema } from "./runtime";
import { selfImprovementSha256 } from "./contracts";
import type { SelfImprovementExecutionAuthority } from "./authority";
import { syntheticPassingReview } from "./review-test-fixtures";

const mocks = vi.hoisted(() => ({
  stored: null as unknown as StoredSelfImprovementCycle, paused: false, generation: 1, noChange: false,
  incomplete: false, missingRead: false, unknownUsage: false, modelFailure: false, failBaseline: true, failChecks: 0, comparisonMismatch: false, missingBrief: false,
  native: false, prepareNative: vi.fn(), expireNative: vi.fn(), models: [] as string[], tools: [] as string[], commandCount: 0,
  reserve: vi.fn(), settle: vi.fn(), sessionId: `app_build_${"1".repeat(48)}`,
  fileHashes: {} as Record<string, string>, prompts: [] as string[], idempotencyKeys: [] as string[],
  preparationFailure: undefined as undefined | "captured" | "repeated" | "report", multipleTests: false, badEffectChain: false,
  staticExit: undefined as undefined | { phase: "baseline_check" | "verify"; exitCode: number }, passingControls: 1,
  forgeInputs: [] as SelfImprovementExecutionAuthority[], modelInputs: [] as SelfImprovementExecutionAuthority[], noForgeWrite: false, effectMismatch: false, reproductionChanges: undefined as undefined | "empty" | "deleted" | "outside" | "unattributed",
  reviewUnproven: false,
}));
vi.mock("./store", () => ({
  holdExpiredSelfImprovementNativeValidation: mocks.expireNative,
  assertConfiguredSelfImprovementOwner: vi.fn(),
  assertSelfImprovementOwnerAuthority: vi.fn(),
  getSelfImprovementCycle: async () => mocks.stored,
  getSelfImprovementConfiguration: async () => ({ id: mocks.stored.configurationId, tenantId: mocks.stored.cycle.scope.tenantId,
    ownerActorId: mocks.stored.cycle.scope.ownerActorId, projectId: mocks.stored.projectId, repositoryId: mocks.stored.repositoryId,
    repository: mocks.stored.cycle.scope.repository, policy: mocks.stored.cycle.policy, paused: mocks.paused, generation: mocks.generation }),
  listSelfImprovementCycles: async () => [],
  withSelfImprovementEvidenceOwner: async (owner: { ownerActorId: string }, _projectId: string, read: (actorIds: readonly string[]) => Promise<unknown>) => read([owner.ownerActorId, "verified@example.test"]),
  getSelfImprovementProjectBrief: async () => {
    if (mocks.missingBrief) throw new Error("The self-improvement project brief is unavailable for its current owner.");
    return { title: "Engineering", objective: "Maintain the application." };
  },
  renewSelfImprovementCycleLease: async () => {
    mocks.stored = { ...mocks.stored, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() }; return mocks.stored;
  },
  releaseSelfImprovementExecutionLease: async () => { mocks.stored = { ...mocks.stored, leaseExpiresAt: new Date(0).toISOString() }; return mocks.stored; },
  updateSelfImprovementCycleRuntime: async (input: { runtime: Record<string, unknown>; patch?: object }) => {
    mocks.stored = { ...mocks.stored, runtime: input.runtime, cycle: { ...mocks.stored.cycle, ...input.patch, revision: mocks.stored.cycle.revision + 1 } }; return mocks.stored;
  },
  transitionSelfImprovementCycle: async (input: { nextStage: StoredSelfImprovementCycle["cycle"]["stage"]; patch?: object }) => {
    const cycle = { ...mocks.stored.cycle, ...input.patch, revision: mocks.stored.cycle.revision + 1, stage: input.nextStage };
    assertSelfImprovementCycleTransition(mocks.stored.cycle, cycle);
    mocks.stored = { ...mocks.stored, cycle }; return mocks.stored;
  },
  reserveSelfImprovementPhaseBudget: mocks.reserve,
  settleSelfImprovementPhaseBudget: mocks.settle,
}));
vi.mock("@/lib/runs/store", () => ({ listAgentRuns: async () => [] }));
vi.mock("@/lib/tools/audit-store", () => ({ listToolExecutions: async () => [] }));
vi.mock("@/lib/tools/execution-scope", () => ({ getToolExecutionScopeBinding: vi.fn() }));
vi.mock("@/lib/app-builder/store", () => ({
  getProjectBuilderSession: async () => ({ id: mocks.sessionId, sandboxName: "sandbox", revision: 1, status: "ready" }),
  getBuilderCheckpoint: async () => ({ id: "checkpoint", workspaceSha256: "c".repeat(64) }),
  getBuilderVerification: async () => ({ id: "verification", status: "passed", checkpointId: "checkpoint", workspaceSha256: "c".repeat(64),
    checks: selfImprovementRuntimeSchema.parse(mocks.stored.runtime).checks.map(check => ({ command: check.command, paths: check.paths, outputSha256: check.outputSha256, exitCode: check.exitCode })) }),
}));
vi.mock("@/lib/app-builder/delivery-store", () => ({
  getBuilderRepositoryBinding: async () => ({ id: "binding", revision: 1, baseSha: "a".repeat(40) }),
  listBuilderDeliveries: async () => [{ id: "delivery", checkpointId: "checkpoint", verificationId: "verification", status: "pull_request_open", commitSha: "b".repeat(40), pullRequestUrl: "https://github.com/asael/app/pull/1" }],
}));
vi.mock("@/lib/app-builder/github", () => ({
  readBuilderGithubCandidateComparison: async () => ({ changedLines: 12, files: (mocks.comparisonMismatch ? ["src/unexpected.ts"] : (mocks.native ? ["apps/flutter/test/features/inbox/example_test.dart", "apps/flutter/lib/features/inbox/example.dart"] : ["src/feature.test.ts", "src/feature.ts"])).map(path => ({ path })) }),
}));
vi.mock("@/lib/app-builder/sandbox", () => ({
  getBuilderWorkspaceManifest: async () => ({ sha256: "c".repeat(64) }),
  readBuilderFile: async (_sandbox: string, path: string) => ({ path, sha256: mocks.fileHashes[path] || "d".repeat(64) }),
  readBuilderRepositoryChanges: async () => mocks.stored.runtime.phase === "reproduce" && mocks.reproductionChanges && mocks.models.length > 1
    ? mocks.reproductionChanges === "empty" ? [] : mocks.reproductionChanges === "deleted" ? [{ kind: "delete", path: "src/feature.test.ts", previousSha256: "d".repeat(64) }]
      : [{ kind: "upsert", previousSha256: null, file: { path: mocks.reproductionChanges === "outside" ? "src/outside.ts" : "src/feature.test.ts", sha256: "e".repeat(64), mode: "100644" } }]
    : Object.entries(mocks.fileHashes).map(([path, hash]) => ({ kind: "upsert", previousSha256: path.includes("test") ? null : "d".repeat(64),
      file: { path, sha256: hash, mode: "100644" } })),
}));
vi.mock("./native-service", () => ({ prepareSelfImprovementNativeValidation: mocks.prepareNative }));
vi.mock("./agent", () => ({
  executeImprovementTool: async (input: { toolId: string; parameters: { command?: string; paths?: string[] }; idempotencyKey: string }) => {
    mocks.idempotencyKeys.push(input.idempotencyKey);
    mocks.tools.push(input.toolId);
    let data: object = {};
    if (input.toolId.endsWith("builder.create")) data = { session: { id: mocks.sessionId, status: "ready" } };
    if (input.toolId.endsWith("repository.bind")) data = { repositoryBinding: { baseSha: "a".repeat(40) } };
    if (input.toolId.endsWith("checkpoint.create")) {
      const expected = [...selfImprovementRuntimeSchema.parse(mocks.stored.runtime).agentRuns].reverse().find(item => item.agentId === "forge" && item.phase === (mocks.stored.runtime.phase === "baseline_check" ? "reproduce" : "implement") && item.completed);
      expect(input.parameters).toMatchObject({ reason: "after_forge", sourceRunId: expected?.runId });
      expect(expected).toBeDefined();
      data = { checkpoint: { id: input.idempotencyKey.includes("native-baseline") ? `checkpoint-baseline-${mocks.stored.cycle.correctionsUsed}` : "checkpoint" } };
    }
    if (input.toolId.endsWith("verification.run")) data = { verification: { id: "verification", status: "passed" } };
    if (input.toolId.endsWith("sentinel.record")) data = { sentinel: { verdict: "passed" } };
    if (input.toolId.endsWith("command.run")) {
      mocks.commandCount++;
      const baseline = mocks.stored.runtime.phase === "baseline_check";
      const test = input.parameters.command === "test_focused";
      const invalidPreparation = baseline && mocks.preparationFailure && (mocks.preparationFailure === "repeated" || mocks.stored.cycle.correctionsUsed === 0);
      const fail = baseline ? (test ? mocks.failBaseline : invalidPreparation && input.parameters.command === "lint_focused") : mocks.failChecks-- > 0;
      const unproven = test && invalidPreparation && mocks.preparationFailure === "report";
      const configuredStaticExit = mocks.staticExit;
      const staticExit = input.parameters.command === "typecheck_direct" && configuredStaticExit !== undefined && configuredStaticExit.phase === mocks.stored.runtime.phase ? configuredStaticExit.exitCode : undefined;
      data = { result: { exitCode: staticExit ?? (fail ? 1 : 0),
        stdout: staticExit !== undefined ? staticExit === 2 ? "src/feature.test.ts(1,1): error TS2322: Type mismatch." : "Generating route types...\nTypes generated successfully\n" : invalidPreparation ? test ? "AssertionError: expected 9 to be +0 at full81EdgeFixture (src/feature.test.ts:36:43)" : "src/feature.test.ts 78:46 Unexpected any. @typescript-eslint/no-explicit-any" : fail ? "Expected observable behavior failed" : "passed", stderr: "",
        durationMs: staticExit === 137 ? 180_088 : 1,
        ...(unproven ? { testReportError: { reason: "invalid_or_unexecuted", actualExitCode: 1 } } : test ? { testSummary: {
          totalTests: invalidPreparation ? 3 : baseline && fail ? mocks.passingControls + 1 : 2, failedTests: invalidPreparation ? 3 : fail ? 1 : 0,
          passedTests: invalidPreparation ? 0 : baseline && fail ? mocks.passingControls : fail ? 1 : 2, pendingTests: 0, executedPaths: input.parameters.paths || [] } } : {}) } };
    }
    return { executionId: `execution:${mocks.tools.length}`, data };
  },
  runImprovementAgent: async (input: { agentId: string; prompt: string; authority: SelfImprovementExecutionAuthority; onRunStarted: (id: string) => Promise<void> }) => {
    mocks.modelInputs.push(input.authority);
    const runId = randomUUID(); await input.onRunStarted(runId); mocks.models.push(input.agentId); mocks.prompts.push(input.prompt);
    if (mocks.modelFailure) throw new Error("Provider stream interrupted.");
    if (input.agentId === "forge") mocks.forgeInputs.push(input.authority);
    const response = input.agentId === "atlas" ? JSON.stringify(mocks.noChange ? { decision: "no_change", summary: "No supported defect." } : {
      decision: "repair", plan: mocks.native ? { releaseTarget: "macos_app", summary: "Restore native title.", sourcePaths: ["apps/flutter/lib/features/inbox/example.dart"], focusedTestPaths: ["apps/flutter/test/features/inbox/example_test.dart"], adjacentTestPaths: ["apps/flutter/test/features/inbox/neighbor_test.dart"], acceptanceCriteria: ["Empty names return fallback."] } : { summary: "Handle empty feature name.", sourcePaths: ["src/feature.ts"], focusedTestPaths: mocks.multipleTests ? ["src/feature.test.ts", "src/second.test.ts"] : ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Empty names return the fallback."] },
    }) : input.agentId === "sentinel" ? "PASS\nArchitecture impact: minor\nThe original failing case and adjacent behavior now pass." : '{"summary":"Phase complete"}';
    const writePaths = input.authority.writePaths || [];
    const paths = mocks.multipleTests && input.authority.forgePlan?.phase === "reproduce" && mocks.forgeInputs.filter(item => item.forgePlan?.phase === "reproduce").length === 1 ? writePaths : writePaths.slice(0, 1);
    const effects = paths.map(path => {
      const previousSha256 = mocks.fileHashes[path] ?? (input.authority.forgePlan?.phase === "reproduce" ? null : "d".repeat(64));
      const fileSha256 = (previousSha256 === null ? "d" : previousSha256 === "d".repeat(64) ? "e" : "f").repeat(64);
      if (!mocks.noForgeWrite) mocks.fileHashes[path] = fileSha256;
      return { executionId: `effect-${runId}-${path}`, toolId: previousSha256 === null ? "app.projects.builder.file.update" as const : "app.projects.builder.file.edit" as const,
        path, previousSha256: mocks.badEffectChain && previousSha256 ? "a".repeat(64) : previousSha256,
        sha256: mocks.effectMismatch ? "a".repeat(64) : fileSha256, inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64) };
    });
    const handoff = input.agentId === "forge" ? { version: 1, origin: "forge_workflow", runId, sessionId: input.authority.sessionId,
      phase: input.authority.forgePlan!.phase, planSha256: selfImprovementSha256("forge_plan", input.authority.forgePlan), outcome: "completed", reason: "complete", reads: [], effects } : undefined;
    return { runId, inspectionResult: input.agentId === "atlas" && !mocks.incomplete ? JSON.parse(response) : undefined, response: mocks.incomplete ? response + "\n\nSome requested work is incomplete: 2 deferred action(s) did not run. Work depending on those actions remains unfinished." : response,
      completion: mocks.incomplete ? "requested_actions_unfinished" : "complete",
      ...(input.agentId === "sentinel" && input.authority.reviewManifest && !mocks.reviewUnproven ? { reviewReceipt: syntheticPassingReview(input.authority.reviewManifest, runId) } : {}),
      ...(input.agentId === "forge" && !mocks.noForgeWrite ? { forgeResult: { effects }, forgeReceipt: { ...handoff!, receiptSha256: selfImprovementSha256("forge_handoff", handoff) } } : {}),
      inspectedPaths: mocks.missingRead ? ["src/feature.ts"] : mocks.native ? ["apps/flutter/lib/features/inbox/example.dart", "apps/flutter/test/features/inbox/neighbor_test.dart"] : ["src/feature.ts", "src/adjacent.test.ts"], measuredCostUsd: mocks.unknownUsage ? null : 0.01 };
  },
}));

import { executeSelfImprovementJob } from "./worker";
const job = { tenantId: "tenant", payload: { actorId: "owner", cycleId: "cycle" } } as unknown as OperationJobRecord;
const step = () => executeSelfImprovementJob(job, new AbortController().signal);
async function advanceTo(phase: string) {
  for (let i = 0; i < 25 && mocks.stored.runtime.phase !== phase; i++) await step();
  expect(mocks.stored.runtime.phase).toBe(phase);
}
function completeNative(baseline: boolean, invalid = false, staticExit?: number) {
      const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime), entry = runtime.native!.requests.at(-1)!;
      const fixture = nativeValidationFixture(), request = entry.request;
      const { artifactSha256: _oldArtifact, ...artifactBody } = { ...fixture.receipt.artifact!, sourceManifestSha256: request.snapshot.workspaceSha256 };
      const checks = (baseline ? [fixture.receipt.checks[0], fixture.receipt.checks[1]] : fixture.receipt.checks).map(check => ({ ...check, workspaceBeforeSha256: request.snapshot.workspaceSha256, workspaceAfterSha256: request.snapshot.workspaceSha256,
        ...(baseline && check.command === "macos_test_focused" ? { exitCode: 1, testSummary: { ...check.testSummary!, totalTests: invalid ? 3 : 2, passedTests: invalid ? 0 : 1, failedTests: invalid ? 3 : 1 } } : {}),
        ...(invalid && check.command === "macos_analyze" ? { exitCode: 1, outputTail: "Generated test analysis error" } : {}),
        ...(staticExit !== undefined && check.command === "macos_analyze" ? { exitCode: staticExit, outputTail: "" } : {}) }));
      const { receiptSha256: _oldReceipt, ...body } = { ...fixture.receipt, requestId: request.requestId, requestSha256: request.requestSha256, snapshotSha256: request.snapshot.snapshotSha256, workspaceSha256: request.snapshot.workspaceSha256,
        checks, artifact: baseline ? null : { ...artifactBody, artifactSha256: selfImprovementNativeSha("native_artifact", artifactBody) } };
      entry.receipt = nativeValidationReceiptSchema.parse({ ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) }); entry.status = "completed";
      runtime.native!.waitStartedAt = null; mocks.stored = { ...mocks.stored, runtime };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T17:10:00.000Z"));
  mocks.native = mocks.incomplete = mocks.missingRead = false;
  mocks.reviewUnproven = false;
  mocks.multipleTests = mocks.badEffectChain = false; mocks.fileHashes = {}; mocks.prompts = []; mocks.idempotencyKeys = []; mocks.preparationFailure = undefined;
  mocks.staticExit = undefined; mocks.passingControls = 1;
  mocks.forgeInputs = []; mocks.modelInputs = []; mocks.noForgeWrite = mocks.effectMismatch = false; mocks.reproductionChanges = undefined;
  mocks.paused = mocks.noChange = mocks.unknownUsage = mocks.comparisonMismatch = mocks.modelFailure = mocks.missingBrief = false;
  mocks.failBaseline = true; mocks.failChecks = 0; mocks.commandCount = 0; mocks.models = []; mocks.tools = []; mocks.generation = 1;
  const now = new Date().toISOString();
  mocks.stored = { configurationId: "config", configurationGeneration: 1, projectId: "project", repositoryId: "1", day: now.slice(0, 10),
    leaseExpiresAt: new Date(0).toISOString(), runtime: initialSelfImprovementRuntime(), spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: "cycle", scope: { tenantId: "tenant", ownerActorId: "owner", repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) },
      policy: createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 }), stage: "observing", revision: 1, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now } };
  mocks.prepareNative.mockImplementation(async (_stored, _runtime, checkpointId, purpose) => {
    const fixture = nativeValidationFixture();
    const { snapshotSha256: _oldSnapshot, ...snapshotBody } = { ...fixture.request.snapshot, cycleId: "cycle", projectId: "project", sessionId: mocks.sessionId, checkpointId, workspaceSha256: "c".repeat(64) };
    const { requestSha256: _oldRequest, ...body } = { ...fixture.request, cycleId: "cycle", projectId: "project", sessionId: mocks.sessionId, checkpointId, purpose,
      requestId: `self_native_${purpose === "baseline" ? (mocks.stored.cycle.correctionsUsed ? "3" : "1").repeat(64) : "2".repeat(64)}`, snapshot: { ...snapshotBody, snapshotSha256: selfImprovementNativeSha("native_source_snapshot", snapshotBody) } };
    return nativeValidationRequestSchema.parse({ ...body, requestSha256: selfImprovementNativeSha("native_validation_request", body) });
  });
  mocks.expireNative.mockImplementation(async () => {
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime), entry = runtime.native!.requests.at(-1)!;
    entry.status = "held"; entry.holdCategory = "native_validation_expired";
    mocks.stored = { ...mocks.stored, runtime };
    return { outcome: "held", cycle: mocks.stored };
  });
  mocks.reserve.mockImplementation(async () => ({ outcome: "reserved", cycle: mocks.stored }));
  mocks.settle.mockImplementation(async () => mocks.stored);
});
afterEach(() => vi.useRealTimers());
describe("durable self-improvement worker", () => {
  it.each([undefined, 600_000])("passes only the immutable cycle token cap %s to every engineering phase", async maxEngineeringTokensPerRun => {
    const policy = createSelfImprovementPolicy({ maxCycleBudgetUsd: 100,
      ...(maxEngineeringTokensPerRun !== undefined ? { maxEngineeringTokensPerRun } : {}) });
    mocks.stored = { ...mocks.stored, cycle: { ...mocks.stored.cycle, policy } };
    await advanceTo("release_wait");
    expect(mocks.stored.cycle.stage).toBe("ready_for_release");
    expect(mocks.models).toEqual(["atlas", "forge", "forge", "sentinel"]);
    for (const input of mocks.modelInputs) {
      expect(input.maxEngineeringTokensPerRun).toBe(maxEngineeringTokensPerRun);
      expect(input.policySha256).toBe(policy.policySha256);
    }
    expect(mocks.stored.cycle.policy).toEqual(policy);
    expect(mocks.reserve).toHaveBeenCalledTimes(4); expect(mocks.settle).toHaveBeenCalledTimes(4);
  });
  it("settles Sentinel usage before refusing unproven prose approval", async () => {
    await advanceTo("review"); mocks.reviewUnproven = true;
    await expect(step()).rejects.toThrow("criterion completion receipt");
    expect(mocks.settle.mock.calls.at(-1)?.[0].actualUsd).toBe(0.01);
    expect(mocks.stored.runtime.phaseAttempt).toBeNull();
    expect(mocks.tools).not.toContain("app.projects.builder.sentinel.record");
    expect(mocks.tools).not.toContain("app.projects.builder.delivery.create");
  });
  it("keeps legacy review runtime readable but refuses delivery without its exact criterion proof", async () => {
    await advanceTo("deliver"); delete mocks.stored.runtime.reviewReceipt;
    expect(selfImprovementRuntimeSchema.safeParse(mocks.stored.runtime).success).toBe(true);
    await expect(step()).rejects.toThrow("per-criterion Sentinel review");
    expect(mocks.tools).not.toContain("app.projects.builder.delivery.create");
  });
  it("settles known usage and refuses a summary with no recorded Forge effect", async () => {
    await advanceTo("reproduce"); mocks.noForgeWrite = true;
    await expect(step()).rejects.toThrow("did not record a completed file change");
    expect(mocks.settle.mock.calls.at(-1)?.[0].actualUsd).toBe(0.01);
    expect(mocks.stored.runtime).toMatchObject({ phase: "reproduce", phaseAttempt: null, errorCode: "forge_no_changes" });
    expect(mocks.commandCount).toBe(0);
  });
  it("refuses a changed current effect after settling its known usage", async () => {
    await advanceTo("reproduce"); mocks.effectMismatch = true;
    await expect(step()).rejects.toThrow("no longer matches the current workspace bytes");
    expect(mocks.stored.runtime).toMatchObject({ errorCode: "forge_effect_changed", phaseAttempt: null });
    expect(mocks.settle.mock.calls.at(-1)?.[0].actualUsd).toBe(0.01);
  });
  it.each(["empty", "deleted", "outside", "unattributed"] as const)("distinguishes the %s reproduction diff", async kind => {
    await advanceTo("reproduce"); mocks.reproductionChanges = kind;
    await expect(step()).rejects.toThrow();
    expect(mocks.stored.runtime.errorCode).toBe(({ empty: "reproduction_no_changes", deleted: "reproduction_deleted_files", outside: "reproduction_outside_tests", unattributed: "reproduction_unattributed_change" })[kind]);
    expect(mocks.commandCount).toBe(0);
  });
  it("refuses missing original hashes before starting or reserving Forge", async () => {
    await advanceTo("reproduce"); mocks.stored.runtime.sourceHashes = {};
    const reservations = mocks.reserve.mock.calls.length;
    await expect(step()).rejects.toThrow("saved original source or fixed regression hash is missing");
    expect(mocks.reserve).toHaveBeenCalledTimes(reservations); expect(mocks.forgeInputs).toHaveLength(0);
  });
  it("pins original sources for reproduction and only fixed tests through an allowed correction", async () => {
    await advanceTo("verify"); mocks.failChecks = 1;
    await step(); expect(mocks.stored.runtime.phase).toBe("implement");
    await step();
    expect(mocks.forgeInputs).toHaveLength(3);
    expect(mocks.forgeInputs[0].forgePlan?.expectedHashes).toEqual({ "src/feature.ts": "d".repeat(64) });
    for (const input of mocks.forgeInputs.slice(1)) expect(input.forgePlan?.expectedHashes).toEqual({ "src/feature.test.ts": "d".repeat(64) });
    expect(mocks.stored.cycle.correctionsUsed).toBe(1);
  });
  it.each(["captured", "report"] as const)("collects all %s preparation failures before one test-only repair, then freezes the repaired baseline", async failure => {
    mocks.preparationFailure = failure;
    await advanceTo("baseline_check");
    const initialHash = mocks.fileHashes["src/feature.test.ts"];
    expect(mocks.stored.runtime.sourceHashes).not.toHaveProperty("src/feature.test.ts");
    await step();
    expect(mocks.stored.runtime.phase).toBe("baseline_check");
    expect(mocks.stored.cycle.correctionsUsed).toBe(0);
    await step(); await step();
    expect(mocks.stored.runtime.phase).toBe("reproduce");
    expect(mocks.stored.cycle).toMatchObject({ stage: "correcting", correctionsUsed: 1 });
    const failed = structuredClone(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).preparations![0]);
    expect(failed.accepted).toBe(false);
    expect(failed.checks.map(check => check.evidence.command)).toEqual(["lint_focused", "typecheck_direct", "test_focused"]);
    expect(failed.checks[0].output).toContain("no-explicit-any");
    expect(failed.checks[2]).toMatchObject(failure === "report" ? { reportComplete: false } : { evidence: { passedTests: 0, failedTests: 3 } });
    expect(mocks.fileHashes).not.toHaveProperty("src/feature.ts");
    await step();
    const correctionPrompt = mocks.prompts.at(-1)!;
    expect(correctionPrompt).toContain("Test-preparation correction (untrusted execution data)");
    expect(correctionPrompt).toContain("no-explicit-any");
    expect(correctionPrompt).toContain("full81EdgeFixture");
    expect(mocks.forgeInputs.at(-1)?.writePaths).toEqual(["src/feature.test.ts"]);
    for (let index = 0; index < 3; index++) await step();
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime);
    expect(runtime.phase).toBe("implement");
    expect(runtime.preparations![0]).toEqual(failed);
    expect(runtime.preparations![1]).toMatchObject({ attempt: 1, accepted: true });
    expect(runtime.sourceHashes["src/feature.test.ts"]).not.toBe(initialHash);
    expect(runtime.sourceHashes["src/feature.test.ts"]).toBe(mocks.fileHashes["src/feature.test.ts"]);
    expect(mocks.fileHashes).not.toHaveProperty("src/feature.ts");
    expect(mocks.idempotencyKeys.filter(key => /:prepare:[01]:[012]$/.test(key))).toEqual(
      [0, 1].flatMap(attempt => [0, 1, 2].map(index => `self-improvement:cycle:prepare:${attempt}:${index}`)));
    await step();
    expect(mocks.prompts.at(-1)).not.toContain("Source correction feedback");
    expect(mocks.forgeInputs.at(-1)?.writePaths).toEqual(["src/feature.ts"]);
    mocks.failChecks = 1;
    await expect(step()).rejects.toThrow("still fails");
    expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    expect(mocks.models).toEqual(["atlas", "forge", "forge", "forge"]);
    expect(mocks.reserve).toHaveBeenCalledTimes(4); expect(mocks.settle).toHaveBeenCalledTimes(4);
  });
  it("retains corrected three-control/one-regression evidence when static verification is incomplete", async () => {
    mocks.preparationFailure = "captured";
    await advanceTo("baseline_check");
    await step(); await step(); await step();
    expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    const original = structuredClone(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).preparations![0]);
    await step(); // The existing correction repairs the genuinely invalid fixture.
    mocks.passingControls = 3; mocks.staticExit = { phase: "baseline_check", exitCode: 137 };
    await step(); await step();
    const calls = { models: mocks.models.length, reserved: mocks.reserve.mock.calls.length, settled: mocks.settle.mock.calls.length };
    await expect(step()).rejects.toThrow("Static verification incomplete: typecheck_direct ended with exit 137");
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime);
    expect(runtime).toMatchObject({ phase: "baseline_check", errorCode: "static_check_incomplete", baseline: null, phaseAttempt: null });
    expect(runtime.summary).not.toContain("meaningful passing control");
    expect(runtime.preparations![0]).toEqual(original);
    expect(runtime.preparations![1]).toMatchObject({ attempt: 1, accepted: false, checks: [
      { evidence: { command: "lint_focused", exitCode: 0 } },
      { evidence: { command: "typecheck_direct", exitCode: 137 } },
      { evidence: { command: "test_focused", passedTests: 3, failedTests: 1, pendingTests: 0 } },
    ] });
    expect(mocks.stored.cycle).toMatchObject({ stage: "failed", correctionsUsed: 1 });
    expect(mocks.models).toEqual(["atlas", "forge", "forge"]);
    expect(mocks.fileHashes).not.toHaveProperty("src/feature.ts");
    expect(mocks.settle.mock.calls.every(([input]) => input.actualUsd === 0.01)).toBe(true);
    await step(); // Terminal jobs cannot replay the checks or paid phase.
    expect({ models: mocks.models.length, reserved: mocks.reserve.mock.calls.length, settled: mocks.settle.mock.calls.length }).toEqual(calls);
  });
  it("does not spend the test correction for an incomplete static check on an otherwise valid baseline", async () => {
    await advanceTo("baseline_check"); mocks.staticExit = { phase: "baseline_check", exitCode: 137 };
    await step(); await step();
    await expect(step()).rejects.toThrow("Static verification incomplete");
    expect(mocks.stored.cycle).toMatchObject({ stage: "failed", correctionsUsed: 0 });
    expect(mocks.models).toEqual(["atlas", "forge"]);
    expect(mocks.reserve).toHaveBeenCalledTimes(2); expect(mocks.settle).toHaveBeenCalledTimes(2);
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).preparations?.[0].checks).toHaveLength(3);
    expect(mocks.fileHashes).not.toHaveProperty("src/feature.ts");
  });
  it("retains the one test correction for completed TypeScript diagnostics", async () => {
    await advanceTo("baseline_check"); mocks.staticExit = { phase: "baseline_check", exitCode: 2 };
    await step(); await step(); await step();
    expect(mocks.stored.cycle).toMatchObject({ stage: "correcting", correctionsUsed: 1 });
    expect(mocks.stored.runtime).toMatchObject({ phase: "reproduce", correctionKind: "test_preparation" });
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).preparations?.[0].checks[1].evidence.exitCode).toBe(2);
  });
  it("retains an incomplete candidate static check without spending a source correction", async () => {
    await advanceTo("verify"); mocks.staticExit = { phase: "verify", exitCode: 137 };
    await step();
    await expect(step()).rejects.toThrow("Static verification incomplete: typecheck_direct");
    expect(mocks.stored.cycle).toMatchObject({ stage: "failed", correctionsUsed: 0 });
    expect(mocks.stored.runtime).toMatchObject({ errorCode: "static_check_incomplete", phase: "verify", phaseAttempt: null });
    expect(mocks.stored.runtime.checks).toMatchObject([{ command: "lint_focused", exitCode: 0 }, { command: "typecheck_direct", exitCode: 137 }]);
    expect(mocks.models).toEqual(["atlas", "forge", "forge"]);
    expect(mocks.reserve).toHaveBeenCalledTimes(3); expect(mocks.settle).toHaveBeenCalledTimes(3);
    expect(mocks.tools).not.toContain("app.projects.builder.delivery.create");
  });
  it("allows an unchanged selected test only through its earlier same-cycle effect", async () => {
    mocks.multipleTests = true; mocks.preparationFailure = "captured";
    await advanceTo("baseline_check");
    for (let index = 0; index < 3; index++) await step();
    await step();
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime);
    expect(runtime.forgeReceipts!.map(receipt => receipt.effects.length)).toEqual([2, 1]);
    expect(runtime.preparations![1].testHashes).toEqual({ "src/feature.test.ts": "e".repeat(64), "src/second.test.ts": "d".repeat(64) });
    for (let index = 0; index < 3; index++) await step();
    expect(mocks.stored.runtime.phase).toBe("implement");
  });
  it("rejects a preparation effect that breaks the earlier saved hash chain", async () => {
    mocks.preparationFailure = "captured";
    await advanceTo("baseline_check");
    for (let index = 0; index < 3; index++) await step();
    mocks.badEffectChain = true;
    await expect(step()).rejects.toThrow("effect chain is incomplete");
    expect(mocks.stored.runtime.errorCode).toBe("reproduction_unattributed_change");
    expect(mocks.fileHashes).not.toHaveProperty("src/feature.ts");
  });
  it("rejects source drift during preparation before reserving another model", async () => {
    await advanceTo("baseline_check");
    const count = mocks.reserve.mock.calls.length;
    mocks.fileHashes["src/feature.ts"] = "e".repeat(64);
    await expect(step()).rejects.toThrow("retain the original application source");
    expect(mocks.reserve).toHaveBeenCalledTimes(count); expect(mocks.commandCount).toBe(0);
  });
  it("retains a readable legacy baseline but denies new implementation without preparation", async () => {
    await advanceTo("implement");
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime);
    delete runtime.preparations;
    runtime.baseline = { ...runtime.baseline!, passedTests: 0, failedTests: 3, totalTests: 3 };
    mocks.stored = { ...mocks.stored, runtime };
    const count = mocks.reserve.mock.calls.length;
    await expect(step()).rejects.toThrow("legacy failing baseline alone is insufficient");
    expect(mocks.reserve).toHaveBeenCalledTimes(count); expect(mocks.models).toEqual(["atlas", "forge"]);
    expect(mocks.stored.runtime.baseline).toMatchObject({ failedTests: 3, passedTests: 0 });
  });

  it("queues native baseline and candidate checks, resumes recorded evidence, and always asks for one install review", async () => {
    mocks.native = true;
    await advanceTo("baseline_check"); await step();
    expect(mocks.stored.cycle.stage).toBe("planned");
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native?.activeRequestId).toBeTruthy();
    const paid = mocks.models.length;
    await step(); expect(mocks.models.length).toBe(paid); expect(mocks.commandCount).toBe(0);
    completeNative(true); await step(); await advanceTo("verify"); await step();
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native!.requests).toHaveLength(2);
    completeNative(false); await advanceTo("release_wait");
    expect(mocks.stored.cycle.stage).toBe("review_required");
    expect(mocks.stored.cycle.candidate?.releaseTarget).toBe("macos_app");
    expect(mocks.stored.cycle.validation?.native?.artifact).toBeDefined();
    expect(mocks.stored.cycle.validation?.checks.map(check => check.kind)).toEqual(["typecheck", "focused_regression", "adjacent_regression", "build", "independent_review"]);
    expect(mocks.models).toEqual(["atlas", "forge", "forge", "sentinel"]); expect(mocks.commandCount).toBe(0);
  });
  it.each(["preparation", "candidate"])("retains interrupted native %s analysis without a paid correction", async phase => {
    mocks.native = true; await advanceTo("baseline_check"); await step();
    if (phase === "candidate") { completeNative(true); await step(); await advanceTo("verify"); await step(); }
    completeNative(phase === "preparation", false, -9);
    const counts = [mocks.models.length, mocks.reserve.mock.calls.length, mocks.settle.mock.calls.length];
    await expect(step()).rejects.toThrow("Static verification incomplete: macos_analyze ended with exit -9");
    expect(mocks.stored.cycle).toMatchObject({ stage: "failed", correctionsUsed: 0 });
    expect(mocks.stored.runtime.errorCode).toBe("static_check_incomplete");
    expect([mocks.models.length, mocks.reserve.mock.calls.length, mocks.settle.mock.calls.length]).toEqual(counts);
    expect(mocks.tools).not.toContain("app.projects.builder.verification.run");
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native?.requests.at(-1)?.receipt?.checks[0].exitCode).toBe(-9);
  });
  it("retains a failed native preparation and uses a fresh checkpoint and request for its test-only correction", async () => {
    mocks.native = true;
    await advanceTo("baseline_check"); await step();
    completeNative(true, true);
    const first = structuredClone(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native!.requests[0]);
    await step();
    expect(mocks.stored.runtime).toMatchObject({ phase: "reproduce", correctionKind: "test_preparation" });
    expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native?.activeRequestId).toBeNull();
    await step(); await step();
    const queued = selfImprovementRuntimeSchema.parse(mocks.stored.runtime).native!;
    expect(queued.requests).toHaveLength(2); expect(queued.requests[0]).toEqual(first);
    expect(queued.requests[1].request.checkpointId).not.toBe(first.request.checkpointId);
    expect(queued.requests[1].request.requestId).not.toBe(first.request.requestId);
    expect(mocks.idempotencyKeys.filter(key => key.includes("native-baseline-checkpoint"))).toEqual([
      "self-improvement:cycle:prepare:0:native-baseline-checkpoint", "self-improvement:cycle:prepare:1:native-baseline-checkpoint",
    ]);
    completeNative(true); await step();
    expect(mocks.stored.runtime.phase).toBe("implement");
    expect(selfImprovementRuntimeSchema.parse(mocks.stored.runtime).preparations?.map(item => item.accepted)).toEqual([false, true]);
    expect(mocks.models).toEqual(["atlas", "forge", "forge"]); expect(mocks.commandCount).toBe(0);
  });
  it("reconciles an expired native claim while paused without restarting it or charging again", async () => {
    mocks.native = true; await advanceTo("baseline_check"); await step();
    const runtime = selfImprovementRuntimeSchema.parse(mocks.stored.runtime), entry = runtime.native!.requests[0];
    entry.status = "claimed"; entry.controllerId = "publisher"; entry.claimedAt = entry.request.createdAt;
    mocks.stored = { ...mocks.stored, runtime }; mocks.paused = true;
    vi.setSystemTime(new Date("2026-10-26T19:00:00.000Z"));
    const counts = [mocks.models.length, mocks.tools.length, mocks.reserve.mock.calls.length];
    expect(await step()).toMatchObject({ __deferOperation: true, delaySeconds: 60 });
    expect(mocks.expireNative).toHaveBeenCalledOnce();
    expect(mocks.expireNative).toHaveBeenCalledWith(expect.objectContaining({ requestId: entry.request.requestId, requestSha256: entry.request.requestSha256 }));
    await step(); expect(mocks.expireNative).toHaveBeenCalledOnce();
    expect([mocks.models.length, mocks.tools.length, mocks.reserve.mock.calls.length]).toEqual(counts);
  });
  it("fences a direct phase request against a newer revision before any execution", async () => {
    await expect(executeSelfImprovementJob(job, new AbortController().signal, mocks.stored.cycle.revision - 1)).rejects.toThrow(/revision changed/);
    expect(mocks.tools).toEqual([]); expect(mocks.models).toEqual([]); expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("reproduces, repairs, checks once, independently reviews, and delivers an exact candidate across resumed jobs", async () => {
    await advanceTo("release_wait");
    expect(mocks.models).toEqual(["atlas", "forge", "forge", "sentinel"]);
    expect(mocks.commandCount).toBe(7); // three preparation checks, four candidate checks
    expect(mocks.prompts.at(-1)).toContain("Expected observable behavior failed");
    expect(mocks.stored.cycle.stage).toBe("ready_for_release");
    expect(mocks.stored.cycle.validation?.baselineReproduction?.failedCases).toBe(1);
    expect(mocks.stored.cycle.validation?.checks.filter(item => item.kind.endsWith("regression")).map(item => item.executedCases)).toEqual([2, 2]);
    expect(mocks.reserve).toHaveBeenCalledTimes(4); expect(mocks.settle).toHaveBeenCalledTimes(4);
    const counts = [mocks.models.length, mocks.tools.length]; await step();
    expect([mocks.models.length, mocks.tools.length]).toEqual(counts);
  });
  it("stays quiet when Atlas finds no supported change", async () => {
    mocks.noChange = true; await advanceTo("done");
    expect(mocks.stored.cycle.stage).toBe("no_change"); expect(mocks.models).toEqual(["atlas"]); expect(mocks.commandCount).toBe(0);
  });
  it("records an unavailable project brief as failed before any paid inspection", async () => {
    await advanceTo("inspect"); mocks.missingBrief = true;
    await expect(step()).rejects.toThrow(/project brief is unavailable/);
    expect(mocks.stored.cycle.stage).toBe("failed");
    expect(mocks.stored.runtime).toMatchObject({ phase: "inspect", errorCode: "phase_failed", summary: "The self-improvement project brief is unavailable for its current owner." });
    expect(mocks.models).toEqual([]); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("requires a genuine executed failing baseline before source edits", async () => {
    mocks.failBaseline = false; await advanceTo("baseline_check");
    for (let i = 0; i < 3; i++) await step();
    expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    await step(); await step(); await step();
    await expect(step()).rejects.toThrow(/corrected tests still lack/);
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.models).toEqual(["atlas", "forge", "forge"]);
  });
  it("limits correction to one and preserves the original reproduction", async () => {
    await advanceTo("verify"); mocks.failChecks = 2;
    await step(); expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    const originalBaseline = selfImprovementRuntimeSchema.parse(mocks.stored.runtime).baseline;
    await step(); await expect(step()).rejects.toThrow(/still fails/);
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.stored.runtime.baseline).toEqual(originalBaseline);
  });
  it("does not replay an interrupted paid phase or act after pause", async () => {
    mocks.stored = { ...mocks.stored, runtime: { ...initialSelfImprovementRuntime(), phase: "inspect", phaseAttempt: { key: "inspect:0", phase: "inspect", startedAt: new Date().toISOString(), costCeilingUsd: 10 } } };
    await expect(step()).rejects.toThrow(/interrupted paid phase/); expect(mocks.models).toEqual([]);
  });
  it("settles known usage before refusing a completed but incomplete inspection", async () => {
    await advanceTo("inspect"); mocks.incomplete = true;
    await expect(step()).rejects.toThrow("phase is incomplete (requested_actions_unfinished)");
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: 0.01 }));
    expect(mocks.models).toEqual(["atlas"]); expect(mocks.stored.cycle.stage).toBe("failed");
    expect(mocks.stored.runtime.phaseAttempt).toBeNull();
    expect(mocks.stored.cycle.candidate).toBeNull();
  });
  it("refuses a proposed adjacent test the inspector did not actually read", async () => {
    await advanceTo("inspect"); mocks.missingRead = true;
    await expect(step()).rejects.toThrow("lacks recorded source or adjacent-test reads");
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: 0.01 }));
    expect(mocks.models).toEqual(["atlas"]);
  });
  it("records unknown metering and stops before another paid phase", async () => {
    mocks.unknownUsage = true; await advanceTo("inspect"); await expect(step()).rejects.toThrow(/usage could not/);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: null })); expect(mocks.models).toEqual(["atlas"]);
  });
  it("refuses a committed diff that differs from the validated workspace", async () => {
    await advanceTo("deliver"); mocks.comparisonMismatch = true; await expect(step()).rejects.toThrow(/committed diff/);
    expect(mocks.stored.cycle.stage).toBe("failed");
  });
  it("settles an interrupted provider attempt as unknown instead of reporting zero spend", async () => {
    await advanceTo("inspect"); mocks.modelFailure = true; await expect(step()).rejects.toThrow(/Provider stream/);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: null }));
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.models).toEqual(["atlas"]);
    expect(mocks.stored.runtime.phaseAttempt).toBeTruthy();
  });
  it("defers a paused scheduled delivery without failing or spending the saved candidate", async () => {
    const before = structuredClone(mocks.stored);
    mocks.paused = true; await expect(step()).resolves.toMatchObject({ __deferOperation: true, delaySeconds: 60 });
    expect(mocks.stored).toEqual(before); expect(mocks.tools).toEqual([]); expect(mocks.models).toEqual([]);
    mocks.paused = false; mocks.generation = 3; await step();
    expect(mocks.stored.cycle.stage).toBe("observing"); expect(mocks.stored.runtime.setupStep).toBe("bind");
  });
  it("continues an unchanged admitted policy after pause and resume increment configuration generation", async () => {
    mocks.generation = 3;
    await step();
    expect(mocks.stored.cycle.stage).toBe("observing"); expect(mocks.stored.runtime.setupStep).toBe("bind");
    expect(mocks.tools).toEqual(["app.projects.builder.create"]);
  });
});
