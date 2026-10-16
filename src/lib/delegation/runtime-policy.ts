import {
  RUN_BUDGET_DIMENSIONS,
  createRunBudgetState,
  reserveRunBudget,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

/**
 * A dynamic child receives a deliberately small, non-redelegating budget.
 * The parent reserves the complete slice before the governed delegation tool
 * is allowed to dispatch, so a crash cannot silently create free authority.
 */
export const DYNAMIC_DELEGATION_CHILD_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    // Two granted read tools may be selected across separate model rounds.
    // Keep exactly one additional tool round for provider tool-call repair and
    // still reserve the last turn for the child's bounded final synthesis.
    modelTurns: 4,
    // A turn is charged its input and the most output it may produce, and it
    // may call tools only while one more turn after a full round of results
    // still fits. This leaves room for the tool rounds above when results are
    // of typical size.
    tokens: 48_000,
    costMicrousd: 400_000,
    wallTimeMs: 90_000,
    toolCalls: 8,
    browserActions: 0,
    agents: 1,
    fanOut: 0,
    // Permit one provider-level retry for malformed structured output while
    // keeping the delegated tool authority and model-turn ceiling unchanged.
    retries: 1,
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

export const LEGACY_DYNAMIC_DELEGATION_LIFECYCLE_BUDGET = Object.freeze(
  composeLifecycleBudget(
    DYNAMIC_DELEGATION_CHILD_BUDGET,
    DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  ),
);

/** New contracts reserve both independent reviews before any child starts. */
export const DYNAMIC_DELEGATION_REVIEW_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    ...DYNAMIC_DELEGATION_VERIFIER_BUDGET,
    tokens: 16_000,
  }),
);

/** One tool-free repair by the same child; it cannot consume read authority. */
export const DYNAMIC_DELEGATION_CORRECTION_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    ...DYNAMIC_DELEGATION_VERIFIER_BUDGET,
    tokens: 24_000,
    agents: 0,
  }),
);

export const DYNAMIC_DELEGATION_REVIEW_POLICY_ID =
  "sentinel-agent-and-deterministic:v3" as const;

export const DYNAMIC_DELEGATION_LIFECYCLE_BUDGET = Object.freeze(
  reviewedCorrectionLifecycleBudget(DYNAMIC_DELEGATION_CHILD_BUDGET),
);

export const DYNAMIC_DELEGATION_REVIEW_POLICY_SHA256 = canonicalJsonSha256({
  method: "agent_then_deterministic",
  acceptanceThreshold: 0.8,
  childBudget: DYNAMIC_DELEGATION_CHILD_BUDGET,
  reviewBudget: DYNAMIC_DELEGATION_REVIEW_BUDGET,
  correctionBudget: DYNAMIC_DELEGATION_CORRECTION_BUDGET,
  lifecycleBudget: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
  maxReviews: 2,
  maxCorrections: 1,
  maxOutputTokens: DYNAMIC_DELEGATION_VERIFIER_MAX_OUTPUT_TOKENS,
  recovery: "fail_closed_on_ambiguous_stage",
});

export const DYNAMIC_DELEGATION_READ_TOOL_IDS = Object.freeze([
  "memory.search",
  "knowledge.search",
  "web.search",
  "web.read",
  "runs.list",
] as const);

type DynamicDelegationReadToolId =
  (typeof DYNAMIC_DELEGATION_READ_TOOL_IDS)[number];

const dynamicDelegationReadToolAliases = Object.freeze({
  "memory.search": ["Search Memory"],
  "knowledge.search": ["Search Knowledge"],
  "web.search": ["Live Web Search", "Search Web", "Web Search"],
  "web.read": ["Read Web Source"],
  "runs.list": ["List Runs"],
} satisfies Record<DynamicDelegationReadToolId, readonly string[]>);

/** An explicit user restriction applies even when Atlas normally coordinates. */
export function hasExplicitNoDelegationIntent(message: string) {
  const text = message.replace(/\s+/g, " ").trim();
  return /\b(?:do\s+not|don't|never|avoid|stop)\s+(?:(?:create|creating|spawn|spawning|use|using|start|starting|assign|assigning)\s+)?(?:any\s+|an?\s+|further\s+)?(?:delegat\w*|sub[- ]?agents?|child\s+agents?)\b/i.test(text) ||
    /\b(?:without|no)\s+(?:any\s+|further\s+)?(?:delegat\w*|sub[- ]?agents?|child\s+agents?)\b/i.test(text) ||
    /\b(?:work\s+alone|(?:handle|do|complete)\s+(?:this|it|the\s+task)\s+(?:entirely\s+)?yourself)\b/i.test(text);
}

export const ATLAS_DELEGATION_INSTRUCTIONS = [
  "You are the accountable coordinator. Keep the user's outcome, outstanding dependencies, and result ownership with Atlas even when specialists help.",
  "When independent research, a draft, evidence comparison, or a second opinion would materially improve the outcome, create the smallest useful task-scoped specialist with app.agents.delegate. You do not need the user to say 'delegate'. Do simple work directly; do not create a team merely to answer a greeting or repeat your own work.",
  "Give each specialist a concrete objective, a useful personaBrief label and guidance, and observable acceptanceCriteria. Grant only exact read tools already available in this run, and list requiredGovernedToolIds when acceptance needs actual source reads. Fork mode is for intentionally sharing this conversation; isolated is the default.",
  "Children can read and propose findings or artifacts; they cannot make changes, purchase, send messages, control the computer, or create further children. Keep consequential actions in the governed parent or an authorized workflow. Existing approval holds and budgets remain in force.",
  "Delegation is asynchronous. The server returns each terminal result or blocker to this conversation once. The creation receipt means assigned, not finished. Tell the user what you assigned and what remains; continue independent work you can finish now. Never claim the overall request is complete from a queued child or a Sentinel review.",
  "If later actions depend on a specialist's findings, use the existing durable workflow path before dispatching the dependent work. A completed chat run is not automatically restarted by a child result; never promise a follow-on action unless its workflow has actually been accepted. Do not poll child status repeatedly in a model loop or ask the user to babysit it.",
  "Respect an explicit instruction to work without delegation. For monitoring, use the persistent availability watch tools for scheduled observation; a short-lived specialist can investigate a source but cannot itself watch continuously.",
].join("\n");

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
  if (hasImperativeNamedAgentDelegationIntent(text)) return true;
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
 * Treat a direct, imperative request to a named built-in Agent as delegation.
 * Clause anchoring keeps documentation, questions about delegation, and past
 * descriptions such as "the run asked Scout" from creating child authority.
 */
function hasImperativeNamedAgentDelegationIntent(message: string) {
  const clauses = message.split(
    /(?:[.!?;\n]+|\b(?:and\s+)?then\b)/i,
  );
  return clauses.some((clause) => {
    const text = clause.trim();
    const requestPrefix = "(?:(?:please|kindly),?\\s+|(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?";
    return new RegExp(
      `^${requestPrefix}(?:ask|tell)\\s+(?:atlas|scout|meridian|forge|sentinel|mnemosyne)\\s+to\\b`,
      "i",
    )
      .test(text) ||
      new RegExp(
        `^${requestPrefix}have\\s+(?:atlas|scout|meridian|forge|sentinel|mnemosyne)\\s+(?:perform|run|inspect|review|analy[sz]e|research|check|search|classify|summari[sz]e|investigate|compare|draft|write|read|find|handle|execute|process|evaluate|verify|build|create|work\\s+on|look\\s+at|take\\s+on)\\b`,
        "i",
      )
        .test(text);
  });
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
  return reviewedCorrectionLifecycleBudget(runBudgetCountersV1Schema.parse(child));
}

export function partitionDynamicDelegationLifecycleBudget(
  lifecycle: RunBudgetCountersV1,
) {
  const parsed = runBudgetCountersV1Schema.parse(lifecycle);
  if (sameBudget(parsed, LEGACY_DYNAMIC_DELEGATION_LIFECYCLE_BUDGET)) {
    return Object.freeze({
      policyVersion: "legacy" as const,
      child: DYNAMIC_DELEGATION_CHILD_BUDGET,
      verifier: DYNAMIC_DELEGATION_VERIFIER_BUDGET,
      correction: undefined,
      finalVerifier: undefined,
    });
  }
  if (sameBudget(parsed, DYNAMIC_DELEGATION_LIFECYCLE_BUDGET)) {
    return Object.freeze({
      policyVersion: "reviewed_correction" as const,
      child: DYNAMIC_DELEGATION_CHILD_BUDGET,
      verifier: DYNAMIC_DELEGATION_REVIEW_BUDGET,
      correction: DYNAMIC_DELEGATION_CORRECTION_BUDGET,
      finalVerifier: DYNAMIC_DELEGATION_REVIEW_BUDGET,
    });
  }
  throw new Error(
    "Dynamic delegation lifecycle budget does not match its immutable policy slices.",
  );
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
  if (partition.policyVersion !== "legacy") {
    throw new Error("Reviewed correction requires durable per-stage reservations.");
  }
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

function sameBudget(left: RunBudgetCountersV1, right: RunBudgetCountersV1) {
  return RUN_BUDGET_DIMENSIONS.every((dimension) =>
    left[dimension] === right[dimension]
  );
}

function reviewedCorrectionLifecycleBudget(child: RunBudgetCountersV1) {
  return runBudgetCountersV1Schema.parse(Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "agents"
        // The second review reuses the same pinned Sentinel identity.
        ? child.agents + DYNAMIC_DELEGATION_REVIEW_BUDGET.agents
        : child[dimension] + DYNAMIC_DELEGATION_CORRECTION_BUDGET[dimension] +
          DYNAMIC_DELEGATION_REVIEW_BUDGET[dimension] * 2,
    ]),
  ));
}
