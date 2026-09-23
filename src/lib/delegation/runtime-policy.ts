import {
  RUN_BUDGET_DIMENSIONS,
  createRunBudgetState,
  reserveRunBudget,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";

/**
 * A dynamic child receives a deliberately small, non-redelegating budget.
 * The parent reserves the complete slice before the governed delegation tool
 * is allowed to dispatch, so a crash cannot silently create free authority.
 */
export const DYNAMIC_DELEGATION_CHILD_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    // Two granted read tools may be selected across separate model rounds;
    // reserve one final turn so the child can return its bounded result.
    modelTurns: 3,
    tokens: 12_000,
    costMicrousd: 400_000,
    wallTimeMs: 90_000,
    toolCalls: 8,
    browserActions: 0,
    agents: 1,
    fanOut: 0,
    retries: 0,
    replans: 0,
  }),
);

/**
 * Sentinel is a separate, pinned Agent boundary. Its authority is reserved
 * alongside the child but is never passed into the child run.
 */
export const DYNAMIC_DELEGATION_VERIFIER_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    modelTurns: 1,
    tokens: 6_000,
    costMicrousd: 200_000,
    wallTimeMs: 30_000,
    toolCalls: 0,
    browserActions: 0,
    agents: 1,
    fanOut: 0,
    retries: 0,
    replans: 0,
  }),
);

export const DYNAMIC_DELEGATION_VERIFIER_MAX_OUTPUT_TOKENS = 600;

export const DYNAMIC_DELEGATION_LIFECYCLE_BUDGET = Object.freeze(
  composeLifecycleBudget(
    DYNAMIC_DELEGATION_CHILD_BUDGET,
    DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  ),
);

export const DYNAMIC_DELEGATION_READ_TOOL_IDS = Object.freeze([
  "memory.search",
  "knowledge.search",
  "web.search",
  "runs.list",
] as const);

export function assertDynamicDelegationApprovalPolicy(input: {
  toolId: string;
  forceApproval: boolean;
}) {
  if (
    input.toolId === "app.agents.delegate" &&
    input.forceApproval
  ) {
    throw new Error(
      "Dynamic delegation cannot be parked for later approval because its live parent budget reservation is request-bound. Use a policy that permits risk-one internal delegation, or start a new run after changing that policy.",
    );
  }
}

export function dynamicDelegationRootReservation(
  child: RunBudgetCountersV1 = DYNAMIC_DELEGATION_CHILD_BUDGET,
) {
  const parsed = dynamicDelegationLifecycleBudget(child);
  return runBudgetCountersV1Schema.parse({
    ...parsed,
    agents: Math.max(1, parsed.agents),
    fanOut: 1,
  });
}

export function dynamicDelegationLifecycleBudget(
  child: RunBudgetCountersV1 = DYNAMIC_DELEGATION_CHILD_BUDGET,
) {
  return composeLifecycleBudget(
    runBudgetCountersV1Schema.parse(child),
    DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  );
}

export function partitionDynamicDelegationLifecycleBudget(
  lifecycle: RunBudgetCountersV1,
) {
  const parsed = runBudgetCountersV1Schema.parse(lifecycle);
  if (RUN_BUDGET_DIMENSIONS.some((dimension) =>
    parsed[dimension] !== DYNAMIC_DELEGATION_LIFECYCLE_BUDGET[dimension]
  )) {
    throw new Error(
      "Dynamic delegation lifecycle budget does not match its child and Sentinel slices.",
    );
  }
  return Object.freeze({
    child: DYNAMIC_DELEGATION_CHILD_BUDGET,
    verifier: DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  });
}

/**
 * The durable root ledger already holds the aggregate lifecycle authority.
 * Immediately before verification, materialize its exact partition and
 * reserve the Sentinel slice so verifier work cannot become free authority.
 */
export function reserveDynamicDelegationVerifierSlice(input: {
  lifecycle: RunBudgetCountersV1;
  startedAt: string;
}) {
  const partition = partitionDynamicDelegationLifecycleBudget(input.lifecycle);
  const lifecycle = runBudgetCountersV1Schema.parse(input.lifecycle);
  const reserved = reserveRunBudget(
    createRunBudgetState(lifecycle, {
      startedAt: input.startedAt,
      used: {
        ...partition.child,
        wallTimeMs:
          lifecycle.wallTimeMs - partition.verifier.wallTimeMs,
      },
    }),
    partition.verifier,
    Date.parse(input.startedAt),
  );
  if (RUN_BUDGET_DIMENSIONS.some((dimension) =>
    reserved.used[dimension] !== lifecycle[dimension]
  )) {
    throw new Error("Sentinel lifecycle budget reservation is incomplete.");
  }
  return Object.freeze({ partition, reserved });
}

/**
 * Preserve one contracted model turn for the child's final answer. Tool calls
 * may still run in parallel within each bounded tool round.
 */
export function dynamicDelegationMaxToolSteps(
  child: RunBudgetCountersV1 = DYNAMIC_DELEGATION_CHILD_BUDGET,
) {
  const parsed = runBudgetCountersV1Schema.parse(child);
  return Math.max(
    1,
    Math.min(parsed.toolCalls, Math.max(1, parsed.modelTurns - 1)),
  );
}

/**
 * The parent pays both for scheduling the governed app tool and for the full
 * non-refundable child slice. Keeping this calculation shared prevents the
 * in-process harness and durable root ledger from describing different work.
 */
export function dynamicDelegationParentToolReservation(
  child: RunBudgetCountersV1 = DYNAMIC_DELEGATION_CHILD_BUDGET,
) {
  const rootReservation = dynamicDelegationRootReservation(child);
  return runBudgetCountersV1Schema.parse(Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      rootReservation[dimension] + (dimension === "toolCalls" ? 1 : 0),
    ]),
  ));
}

function composeLifecycleBudget(
  left: RunBudgetCountersV1,
  right: RunBudgetCountersV1,
) {
  return runBudgetCountersV1Schema.parse(Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "wallTimeMs"
        ? Math.max(left[dimension], right[dimension])
        : left[dimension] + right[dimension],
    ]),
  ));
}
