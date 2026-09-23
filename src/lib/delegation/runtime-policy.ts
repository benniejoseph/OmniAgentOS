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

type DynamicDelegationReadToolId =
  (typeof DYNAMIC_DELEGATION_READ_TOOL_IDS)[number];

const dynamicDelegationReadToolAliases = Object.freeze({
  "memory.search": ["Search Memory"],
  "knowledge.search": ["Search Knowledge"],
  "web.search": ["Live Web Search", "Search Web", "Web Search"],
  "runs.list": ["List Runs"],
} satisfies Record<DynamicDelegationReadToolId, readonly string[]>);

/**
 * Delegation is an explicit authority boundary. Ordinary mentions of Agents or
 * coordination do not opt a run into child creation; the request must name the
 * delegation operation, a child/sub-agent, or coordination of a built-in Agent.
 */
export function hasExplicitDynamicDelegationIntent(message: string) {
  const text = message.replace(/\s+/g, " ").trim();
  const canonicalIndexes = explicitPhraseIndexes(text, "app.agents.delegate");
  if (canonicalIndexes.some((index) =>
    !isNegatedDelegationPhrase(text, index)
  )) return true;
  return [
    /\b(?:delegate|delegates|delegated|delegating)\b/gi,
    /\b(?:create|spawn|launch|start|run|assign|use)\b[^.!?\n]{0,56}\b(?:sub[- ]?agents?|child agents?)\b/gi,
    /\b(?:create|spawn|launch|start|run|assign)\b[^.!?\n]{0,32}\ban?\s+agent\b/gi,
    /\b(?:perform|run|start|use|create|enable)\b[^.!?\n]{0,32}\bdelegation\b/gi,
    /\b(?:atlas[- ]style\s+)?coordination\b[^.!?\n]{0,120}\b(?:atlas|scout|meridian|forge|sentinel|mnemosyne)\b/gi,
    /\bcoordinate\b[^.!?\n]{0,120}\b(?:atlas|scout|meridian|forge|sentinel|mnemosyne)\b/gi,
  ].some((pattern) => hasNonNegatedMatch(text, pattern));
}

/**
 * Converts only explicit, safe child-tool names into canonical grant IDs.
 * This is discovery guidance, never grant authority; the delegation contract
 * still validates the exact IDs against the parent's governed read tools.
 */
export function extractExplicitDynamicDelegationReadToolIds(
  message: string,
): readonly DynamicDelegationReadToolId[] {
  const matches: Array<{
    id: DynamicDelegationReadToolId;
    index: number;
  }> = [];
  for (const id of DYNAMIC_DELEGATION_READ_TOOL_IDS) {
    for (const phrase of [id, ...dynamicDelegationReadToolAliases[id]]) {
      for (const index of explicitPhraseIndexes(message, phrase)) {
        if (!isNegatedExplicitToolPhrase(message, index)) {
          matches.push({ id, index });
        }
      }
    }
  }
  matches.sort((left, right) =>
    left.index - right.index ||
    DYNAMIC_DELEGATION_READ_TOOL_IDS.indexOf(left.id) -
      DYNAMIC_DELEGATION_READ_TOOL_IDS.indexOf(right.id)
  );
  return Object.freeze([...new Set(matches.map((match) => match.id))]);
}

export function dynamicDelegationCapabilityQueryPrefix(message: string) {
  if (!hasExplicitDynamicDelegationIntent(message)) return "";
  return [
    "app.agents.delegate",
    ...extractExplicitDynamicDelegationReadToolIds(message),
  ].join(" ");
}

function explicitPhraseIndexes(message: string, phrase: string) {
  const indexes: number[] = [];
  const haystack = message.toLowerCase();
  const needle = phrase.toLowerCase();
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index < 0) break;
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    const embeddedBefore = isCanonicalIdentifierCharacter(before) && !(
      before === "." &&
      !isCanonicalIdentifierCharacter(haystack[index - 2])
    );
    const embeddedAfter = isCanonicalIdentifierCharacter(after) && !(
      after === "." &&
      !isCanonicalIdentifierCharacter(haystack[index + needle.length + 1])
    );
    if (!embeddedBefore && !embeddedAfter) {
      indexes.push(index);
    }
    fromIndex = index + needle.length;
  }
  return indexes;
}

function isCanonicalIdentifierCharacter(value: string | undefined) {
  return Boolean(value && /[a-z0-9._:@/+~-]/i.test(value));
}

function isNegatedExplicitToolPhrase(message: string, index: number) {
  const prefix = message.slice(Math.max(0, index - 160), index);
  const clause = prefix
    .split(/(?:[.!?;\n]|\bbut\b|\bhowever\b|\binstead\b)/i)
    .at(-1) || "";
  return /(?:\bdo\s+not|\bdon't|\bnot|\bnever|\bwithout|\bexclude|\bom(?:it|itting)|\bno)\b/i
    .test(clause);
}

function hasNonNegatedMatch(message: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(message); match; match = pattern.exec(message)) {
    if (!isNegatedDelegationPhrase(message, match.index)) return true;
  }
  return false;
}

function isNegatedDelegationPhrase(message: string, index: number) {
  const prefix = message.slice(Math.max(0, index - 56), index);
  return /(?:\bdo\s+not|\bdon't|\bnot|\bnever|\bwithout|\bno)\s+(?:(?:use|create|creating|start|starting|allow|perform|spawn|spawning|run)\s+)?(?:an?\s+)?(?:further\s+)?$/i
    .test(prefix);
}

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
