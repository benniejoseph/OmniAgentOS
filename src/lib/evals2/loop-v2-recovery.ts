import { z } from "zod";

import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  decideLoopV2InterruptionRecovery,
} from "@/lib/orchestration/loop-v2-recovery";
import {
  runLoopV2ReadOnlyCanary,
  type LoopV2RuntimeDependencies,
} from "@/lib/orchestration/loop-v2-runtime";
import type { LoopV2RecoveryFence } from "@/lib/orchestration/loop-v2-store";
import type { AgentEvent } from "@/lib/orchestration/types";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { GovernedToolExecutionResult } from "@/lib/tools/executor";

const benchmarkAt = "2026-09-06T00:00:00.000Z";
const activeStateSchema = z.enum([
  "understand",
  "plan",
  "act",
  "observe",
  "verify",
  "replan",
]);
const checkpointStateSchema = z.union([
  activeStateSchema,
  z.literal("clarify"),
]);
const faultSchema = z.enum([
  "none",
  "transient_read_once",
  "transient_read_twice",
  "cancel",
  "verification_mismatch",
  "stale_fence",
  "inactive_wait",
]);
const outcomeSchema = z.enum([
  "resumed",
  "canceled",
  "failed_closed",
  "deferred",
  "rejected",
]);

const caseSchema = z.object({
  id: z.string().min(1).max(120),
  capability: z.enum(["read_only", "model_text"]),
  checkpointState: checkpointStateSchema,
  fault: faultSchema,
  leaseGeneration: z.number().int().min(1).max(1_000_000),
  expectedOutcome: outcomeSchema,
}).strict();

export const loopV2RecoveryEvaluationSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  suiteId: z.literal("p6.1-loop-v2-interruption-recovery-v1"),
  cases: z.array(caseSchema).min(15).max(40),
}).strict().superRefine((suite, context) => {
  const ids = new Set(suite.cases.map((testCase) => testCase.id));
  if (ids.size !== suite.cases.length) {
    context.addIssue({ code: "custom", message: "Case IDs must be unique." });
  }
  for (const state of activeStateSchema.options) {
    if (!suite.cases.some((testCase) => testCase.checkpointState === state)) {
      context.addIssue({
        code: "custom",
        message: `Recovery suite is missing ${state} coverage.`,
      });
    }
  }
  for (const fault of faultSchema.options) {
    if (!suite.cases.some((testCase) => testCase.fault === fault)) {
      context.addIssue({
        code: "custom",
        message: `Recovery suite is missing ${fault} fault coverage.`,
      });
    }
  }
  if (!suite.cases.some((testCase) => testCase.capability === "model_text")) {
    context.addIssue({
      code: "custom",
      message: "Recovery suite must cover a non-replayable model boundary.",
    });
  }
  if (!suite.cases.some((testCase) => testCase.leaseGeneration > 3)) {
    context.addIssue({
      code: "custom",
      message: "Recovery suite must cover exhausted claims.",
    });
  }
});

type RecoveryEvaluationCase = z.infer<typeof caseSchema>;
type RecoveryOutcome = z.infer<typeof outcomeSchema>;

export type LoopV2RecoveryObservation = Readonly<{
  caseId: string;
  expectedOutcome: RecoveryOutcome;
  observedOutcome: RecoveryOutcome;
  checkpointState: z.infer<typeof checkpointStateSchema>;
  toolAttempts: number;
  uniqueLogicalActionKeys: number;
  duplicateEffectCount: number;
  falseSuccessCount: number;
  unfencedWriteCount: number;
  genericFailureMutationCount: number;
  traceComplete: boolean;
  firstProgressVisible: boolean;
  passed: boolean;
}>;

export async function runLoopV2RecoveryEvaluation(input: {
  suite: unknown;
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const suite = loopV2RecoveryEvaluationSuiteSchema.parse(input.suite);
  const observations: LoopV2RecoveryObservation[] = [];
  for (const [index, testCase] of suite.cases.entries()) {
    observations.push(await runRecoveryCase(testCase, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      correlationId: `${input.correlationId}:${index}`,
    }));
  }
  const recoveryEligible = observations.filter(
    (observation) => observation.expectedOutcome === "resumed",
  ).length;
  const recovered = observations.filter(
    (observation) =>
      observation.expectedOutcome === "resumed" &&
      observation.observedOutcome === "resumed",
  ).length;
  const recoveryRateBasisPoints = recoveryEligible
    ? Math.floor((recovered * 10_000) / recoveryEligible)
    : 0;
  const report = {
    schemaVersion: 1 as const,
    suiteId: suite.suiteId,
    suiteSha256: sourceContractSha256(suite),
    caseCount: observations.length,
    passedCaseCount: observations.filter((observation) => observation.passed)
      .length,
    recoveryEligible,
    recovered,
    recoveryRateBasisPoints,
    duplicateEffectCount: sum(observations, "duplicateEffectCount"),
    falseSuccessCount: sum(observations, "falseSuccessCount"),
    unfencedWriteCount: sum(observations, "unfencedWriteCount"),
    genericFailureMutationCount: sum(
      observations,
      "genericFailureMutationCount",
    ),
    traceIncompleteCount: observations.filter(
      (observation) => !observation.traceComplete,
    ).length,
    missingFirstProgressCount: observations.filter(
      (observation) => !observation.firstProgressVisible,
    ).length,
    failedCaseIds: observations
      .filter((observation) => !observation.passed)
      .map((observation) => observation.caseId),
  };
  return {
    report: {
      ...report,
      passed:
        report.passedCaseCount === report.caseCount &&
        report.recoveryRateBasisPoints >= 9_900 &&
        report.duplicateEffectCount === 0 &&
        report.falseSuccessCount === 0 &&
        report.unfencedWriteCount === 0 &&
        report.genericFailureMutationCount === 0 &&
        report.traceIncompleteCount === 0 &&
        report.missingFirstProgressCount === 0,
    },
    observations,
  };
}

async function runRecoveryCase(
  testCase: RecoveryEvaluationCase,
  identity: { tenantId: string; actorId: string; correlationId: string },
): Promise<LoopV2RecoveryObservation> {
  const scope = recoveryScope(testCase.capability, identity);
  const checkpoint = checkpointAt(testCase, identity, scope);
  let outcome: RecoveryOutcome;
  let runtime: ReturnType<typeof runtimeHarness> | undefined;
  try {
    const decision = decideLoopV2InterruptionRecovery(
      checkpoint,
      testCase.leaseGeneration,
    );
    if (decision.action === "fail_closed") {
      outcome = "failed_closed";
    } else {
      runtime = runtimeHarness(testCase, checkpoint);
      outcome = await exerciseReadOnlyRuntime({
        checkpoint,
        scope,
        identity,
        runtime,
      });
    }
  } catch {
    outcome = testCase.fault === "stale_fence" ? "deferred" : "rejected";
  }

  const duplicateEffectCount = runtime
    ? Math.max(runtime.logicalActionKeys.size - 1, 0) +
      runtime.unexpectedToolCallCount
    : 0;
  const falseSuccessCount =
    outcome === "resumed" && testCase.expectedOutcome !== "resumed" ? 1 : 0;
  const traceComplete = runtime
    ? runtimeTraceIsComplete(testCase, outcome, runtime)
    : true;
  const firstProgressVisible = runtime
    ? runtime.events[0]?.type === "run" && runtime.events[1]?.type === "status"
    : true;
  const observation = {
    caseId: testCase.id,
    expectedOutcome: testCase.expectedOutcome,
    observedOutcome: outcome,
    checkpointState: testCase.checkpointState,
    toolAttempts: runtime?.toolAttempts || 0,
    uniqueLogicalActionKeys: runtime?.logicalActionKeys.size || 0,
    duplicateEffectCount,
    falseSuccessCount,
    unfencedWriteCount: runtime?.unfencedWriteCount || 0,
    genericFailureMutationCount: runtime?.genericFailureMutationCount || 0,
    traceComplete,
    firstProgressVisible,
  };
  return Object.freeze({
    ...observation,
    passed:
      observation.observedOutcome === observation.expectedOutcome &&
      observation.toolAttempts <= 3 &&
      observation.duplicateEffectCount === 0 &&
      observation.falseSuccessCount === 0 &&
      observation.unfencedWriteCount === 0 &&
      observation.genericFailureMutationCount === 0 &&
      observation.traceComplete &&
      observation.firstProgressVisible,
  });
}

async function exerciseReadOnlyRuntime(input: {
  checkpoint: LoopV2Checkpoint;
  scope: ReturnType<typeof recoveryScope>;
  identity: { tenantId: string; actorId: string; correlationId: string };
  runtime: ReturnType<typeof runtimeHarness>;
}): Promise<RecoveryOutcome> {
  try {
    for await (const event of runLoopV2ReadOnlyCanary({
      message: "Show my recent runs",
      messages: [{ role: "user", content: "Show my recent runs" }],
      mode: "orchestrate",
      threadId: "evaluation-thread",
      agentId: "atlas",
      securityContext: {
        tenantId: input.identity.tenantId,
        actorId: input.identity.actorId,
        role: "viewer",
        source: "service",
      },
      executionScope: input.scope,
      enrollment: { enginePin: input.checkpoint.enginePin },
      recovery: {
        runId: input.checkpoint.runId,
        checkpoint: input.checkpoint,
        fence: input.runtime.fence,
      },
    }, input.runtime.controller.signal, input.runtime.dependencies)) {
      input.runtime.events.push(event);
    }
  } catch {
    return "deferred";
  }
  const terminal = input.runtime.terminalCheckpoint;
  if (terminal?.terminalDisposition === "canceled") return "canceled";
  if (terminal?.terminalDisposition === "failed") return "failed_closed";
  return input.runtime.events.at(-1)?.type === "done"
    ? "resumed"
    : "failed_closed";
}

function runtimeHarness(
  testCase: RecoveryEvaluationCase,
  checkpoint: LoopV2Checkpoint,
) {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const persisted: LoopV2Checkpoint[] = [];
  const logicalActionKeys = new Set<string>();
  let toolAttempts = 0;
  let unexpectedToolCallCount = 0;
  let unfencedWriteCount = 0;
  let genericFailureMutationCount = 0;
  let terminalCheckpoint: LoopV2Checkpoint | undefined;
  const fence: LoopV2RecoveryFence = Object.freeze({
    tenantId: checkpoint.tenantId,
    runId: checkpoint.runId,
    claimedCheckpointSha256: checkpoint.checkpointSha256,
    leaseGeneration: testCase.leaseGeneration,
    claimToken: "00000000-0000-4000-8000-000000000001",
    leaseExpiresAt: "2030-01-01T00:00:00.000Z",
  });
  const assertFence = (candidate?: LoopV2RecoveryFence) => {
    if (candidate !== fence) unfencedWriteCount += 1;
    if (testCase.fault === "stale_fence") {
      throw new Error("Synthetic stale recovery fence.");
    }
  };
  const dependencies = {
    createRun: async () => {
      throw new Error("Recovery created a replacement run.");
    },
    bindRunScope: async () => {
      throw new Error("Recovery rebound its execution scope.");
    },
    appendEvent: async () => undefined as never,
    appendAssistantTurn: async () => undefined as never,
    executeTool: async (request) => {
      toolAttempts += 1;
      logicalActionKeys.add(String(request.idempotencyKey || ""));
      if (request.toolId !== "runs.list") unexpectedToolCallCount += 1;
      const transientFailures = testCase.fault === "transient_read_twice"
        ? 2
        : testCase.fault === "transient_read_once"
          ? 1
          : 0;
      if (toolAttempts <= transientFailures) {
        throw new Error("Synthetic transient read failure.");
      }
      if (testCase.fault === "cancel") {
        controller.abort();
        throw new Error("Synthetic cancellation.");
      }
      return governedReadResult(
        testCase.fault === "verification_mismatch",
      );
    },
    persistCheckpoint: async (next, _scope, candidateFence) => {
      assertFence(candidateFence);
      persisted.push(next);
      return undefined as never;
    },
    waitForClarification: async () => {
      throw new Error("Recovery unexpectedly requested clarification.");
    },
    resumeClarification: async () => {
      throw new Error("Recovery unexpectedly resumed clarification.");
    },
    finalizeRun: async (terminal, _scope, _result, candidateFence) => {
      assertFence(candidateFence);
      terminalCheckpoint = terminal;
      persisted.push(terminal);
      return undefined as never;
    },
    failUncheckpointedRun: async () => {
      genericFailureMutationCount += 1;
      return true;
    },
  } satisfies LoopV2RuntimeDependencies;
  return {
    controller,
    dependencies,
    events,
    fence,
    logicalActionKeys,
    persisted,
    get genericFailureMutationCount() {
      return genericFailureMutationCount;
    },
    get terminalCheckpoint() {
      return terminalCheckpoint;
    },
    get toolAttempts() {
      return toolAttempts;
    },
    get unexpectedToolCallCount() {
      return unexpectedToolCallCount;
    },
    get unfencedWriteCount() {
      return unfencedWriteCount;
    },
  };
}

function governedReadResult(
  verificationMismatch: boolean,
): GovernedToolExecutionResult {
  return {
    record: {
      id: "synthetic-execution",
      tenantId: "synthetic",
      actorId: "synthetic",
      toolId: "runs.list",
      toolName: "List Runs",
      riskLevel: 0,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input: { limit: 6 },
      output: {},
      ...(verificationMismatch
        ? { effectReceipt: { schemaVersion: 1, synthetic: true } }
        : {}),
      createdAt: benchmarkAt,
      completedAt: benchmarkAt,
    },
    result: {
      runs: [{
        id: "synthetic-prior-run",
        status: "completed",
        prompt: "Synthetic prior run",
        agentId: "atlas",
        startedAt: benchmarkAt,
        completedAt: benchmarkAt,
      }],
    },
  } as unknown as GovernedToolExecutionResult;
}

function runtimeTraceIsComplete(
  testCase: RecoveryEvaluationCase,
  outcome: RecoveryOutcome,
  runtime: ReturnType<typeof runtimeHarness>,
) {
  if (outcome === "deferred") return runtime.terminalCheckpoint === undefined;
  if (outcome === "resumed") {
    const states = ["understand", "plan", "act", "observe", "verify"];
    const retries = testCase.fault === "transient_read_twice"
      ? ["act", "act"]
      : testCase.fault === "transient_read_once"
        ? ["act"]
        : [];
    const expected = [
      ...retries,
      ...states.slice(states.indexOf(testCase.checkpointState) + 1),
      "finish",
    ];
    return runtime.terminalCheckpoint?.terminalDisposition === "succeeded" &&
      JSON.stringify(runtime.persisted.map((item) => item.toState)) ===
        JSON.stringify(expected);
  }
  return runtime.terminalCheckpoint?.toState === "finish";
}

function checkpointAt(
  testCase: RecoveryEvaluationCase,
  identity: { tenantId: string; actorId: string; correlationId: string },
  scope: ReturnType<typeof recoveryScope>,
) {
  let current = createInitialLoopV2Checkpoint({
    tenantId: identity.tenantId,
    runId: `evaluation-run-${sourceContractSha256(testCase.id).slice(0, 24)}`,
    ownerActorId: identity.actorId,
    executionScope: scope,
    enginePin: buildLoopV2EnginePin(evaluationRollout(
      testCase.capability,
      identity,
    )),
    transitionedAt: benchmarkAt,
  });
  if (testCase.checkpointState === "clarify") {
    return advance(current, scope, "ambiguity_detected");
  }
  for (const [state, trigger] of [
    ["plan", "plan_bound"],
    ["act", "action_started"],
    ["observe", "action_succeeded"],
    ["verify", "observation_recorded"],
  ] as const) {
    if (current.toState === testCase.checkpointState) return current;
    current = advance(current, scope, trigger);
    if (state === testCase.checkpointState) return current;
  }
  if (testCase.checkpointState === "replan") {
    return advance(current, scope, "verification_failed");
  }
  return current;
}

function advance(
  current: LoopV2Checkpoint,
  scope: ReturnType<typeof recoveryScope>,
  trigger: Parameters<typeof advanceLoopV2Checkpoint>[0]["trigger"],
) {
  return advanceLoopV2Checkpoint({
    current,
    executionScope: scope,
    trigger,
    outputReceiptSha256: sourceContractSha256({ trigger, synthetic: true }),
    transitionedAt: new Date(
      Date.parse(benchmarkAt) + current.sequence * 1_000,
    ).toISOString(),
  });
}

function recoveryScope(
  capability: RecoveryEvaluationCase["capability"],
  identity: { tenantId: string; actorId: string; correlationId: string },
) {
  return createExecutionScope({
    tenantId: identity.tenantId,
    initiatingActorId: identity.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: identity.correlationId,
    purpose: capability === "read_only"
      ? "agent.loop.v2.read_only_canary"
      : "agent.loop.v2.model_text_canary",
  });
}

function evaluationRollout(
  capability: RecoveryEvaluationCase["capability"],
  identity: { tenantId: string; actorId: string },
): TenantCapabilityRollout {
  const readOnly = capability === "read_only";
  return {
    schemaVersion: 1,
    tenantId: identity.tenantId,
    capabilityId: readOnly
      ? LOOP_V2_CAPABILITY_ID
      : LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: readOnly
      ? LOOP_V2_ENGINE_VERSION_ID
      : LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: readOnly
      ? LOOP_V2_CONFIGURATION_SHA256
      : LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: identity.actorId,
    activatedByActorId: identity.actorId,
    activatedAt: benchmarkAt,
    createdAt: benchmarkAt,
    updatedAt: benchmarkAt,
  };
}

function sum(
  observations: readonly LoopV2RecoveryObservation[],
  key:
    | "duplicateEffectCount"
    | "falseSuccessCount"
    | "unfencedWriteCount"
    | "genericFailureMutationCount",
) {
  return observations.reduce(
    (total, observation) => total + observation[key],
    0,
  );
}
