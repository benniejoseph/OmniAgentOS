/**
 * What can let a gated tool action run. Each source is resolved here, in one
 * order, so a new source cannot slip in as another OR beside the others.
 */
export type ToolAuthoritySource =
  // The action's own approval, claimed from the approval store.
  | "persisted_approval"
  // The signed-in user running their own request.
  | "direct_user"
  // A single-use schedule policy lease bound to this exact reviewed effect.
  | "policy_lease"
  // A reviewed plan's approval grant, consumed for this exact action.
  | "plan_grant"
  // The owner's Moltbook autonomy charter, for one bounded public action.
  | "standing_mandate"
  // The user's bounded This Mac task, for one safe visual interaction.
  | "task_authority";

export type ToolAuthorityCandidate = Readonly<{
  source: ToolAuthoritySource;
  /** The approval, lease, grant or cycle the authority is bound to. */
  bindingId?: string;
  bindingSha256?: string;
  expiresAt?: string;
}>;

export type ToolAuthorityDecision =
  | Readonly<{
      approved: false;
      source?: undefined;
      reviewed: false;
      forcedReview: boolean;
    }>
  | (ToolAuthorityCandidate & Readonly<{
      approved: true;
      /** A person reviewed this action, or the plan or schedule it belongs to. */
      reviewed: boolean;
      forcedReview: boolean;
    }>);

const PRECEDENCE: readonly ToolAuthoritySource[] = [
  "persisted_approval",
  "direct_user",
  "policy_lease",
  "plan_grant",
  "standing_mandate",
  "task_authority",
];

const REVIEWED_SOURCES: ReadonlySet<ToolAuthoritySource> = new Set([
  "persisted_approval",
  "direct_user",
  "policy_lease",
  "plan_grant",
]);

/**
 * The first authority, in precedence order, that may let the action run. A
 * reviewed authority needs the caller's approval and, at risk 3, a quorum.
 * A standing authority never reaches risk 3.
 */
export function resolveToolAuthority(input: {
  /** The caller presents an approval for this action. */
  approved: boolean;
  /** No existing record, or one the approval store claimed for this call. */
  claimed: boolean;
  /** Voice, the Agent's approval policy or the record asks for review. */
  forcedReview: boolean;
  riskLevel: number;
  risk3Quorum: boolean;
  candidates: readonly ToolAuthorityCandidate[];
}): ToolAuthorityDecision {
  // An existing record runs only once the approval store has claimed it,
  // whatever else would let it run.
  if (input.claimed) {
    for (const source of PRECEDENCE) {
      const candidate = input.candidates.find((item) => item.source === source);
      if (!candidate || !admits(source, input)) continue;
      return Object.freeze({
        ...candidate,
        approved: true as const,
        reviewed: REVIEWED_SOURCES.has(source),
        forcedReview: input.forcedReview,
      });
    }
  }
  return Object.freeze({
    approved: false as const,
    reviewed: false as const,
    forcedReview: input.forcedReview,
  });
}

function admits(
  source: ToolAuthoritySource,
  input: Readonly<{
    approved: boolean;
    forcedReview: boolean;
    riskLevel: number;
    risk3Quorum: boolean;
  }>,
) {
  if (REVIEWED_SOURCES.has(source)) {
    return input.approved && (input.riskLevel < 3 || input.risk3Quorum);
  }
  if (input.riskLevel >= 3) return false;
  // Task authority never outranks a forced review. The owner's charter does:
  // the owner granted it for exactly these bounded public actions, and only
  // a service autonomy cycle carries it, never a voice or interactive request.
  return source !== "task_authority" || !input.forcedReview;
}

/** The approval reason to record for an action this decision let run. */
export function toolAuthorityApprovalReason(
  decision: ToolAuthorityDecision,
  approvalReason: string | undefined,
) {
  if (!decision.approved) return approvalReason;
  switch (decision.source) {
    case "task_authority":
      return "The initiating user explicitly authorized this bounded Computer Use task; this safe visual interaction is covered by that task authority.";
    case "standing_mandate":
      return "Owner-enabled Moltbook autonomy charter authorized this bounded public action.";
    case "policy_lease":
      return `Single-use schedule PolicyLease ${decision.bindingId} fenced this exact reviewed effect.`;
    default:
      return approvalReason;
  }
}

const DESCRIPTIONS: Readonly<Record<ToolAuthoritySource, string>> = {
  persisted_approval: "its reviewed approval",
  direct_user: "the signed-in user's own request",
  policy_lease: "a reviewed schedule's policy lease",
  plan_grant: "a reviewed plan's approval grant",
  standing_mandate: "the owner's Moltbook autonomy charter",
  task_authority: "the user's This Mac task authority",
};

/** Who let the action run, in words for an operator. */
export function toolAuthorityDescription(source: ToolAuthoritySource) {
  return DESCRIPTIONS[source];
}

/** The runtime event metadata that records who let a gated action run. */
export function toolAuthorityEventMetadata(decision: ToolAuthorityDecision) {
  if (!decision.approved) return undefined;
  return {
    source: decision.source,
    reviewed: decision.reviewed,
    forcedReview: decision.forcedReview,
    ...(decision.bindingId ? { bindingId: decision.bindingId } : {}),
    ...(decision.bindingSha256
      ? { bindingSha256: decision.bindingSha256 }
      : {}),
    ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
  };
}
