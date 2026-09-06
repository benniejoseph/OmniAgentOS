export const CONTEXT_SCOPE_POLICY_VERSION = "context-scope-policy-v1" as const;

export const CONTEXT_SCOPE_IDS = [
  "none",
  "current_turn",
  "session",
  "agent_private",
  "mission",
  "project",
  "workspace",
  "personal",
  "explicit_selection",
] as const;

export type ContextScopeId = (typeof CONTEXT_SCOPE_IDS)[number];

export type ContextScopePolicy = Readonly<{
  id: ContextScopeId;
  state: "active" | "authority_held";
  conversationHistory: "current_turn" | "session";
  durableContext:
    | "none"
    | "agent_private"
    | "explicit_selection"
    | "authority_held";
  requiresSelection: boolean;
  reason: string;
}>;

export const CONTEXT_SCOPE_POLICIES: readonly ContextScopePolicy[] = Object.freeze([
  {
    id: "none",
    state: "active",
    conversationHistory: "current_turn",
    durableContext: "none",
    requiresSelection: false,
    reason: "Only the submitted task and governing instructions are used.",
  },
  {
    id: "current_turn",
    state: "active",
    conversationHistory: "current_turn",
    durableContext: "none",
    requiresSelection: false,
    reason: "Only the current turn is used; saved and prior conversation context are excluded.",
  },
  {
    id: "session",
    state: "active",
    conversationHistory: "session",
    durableContext: "none",
    requiresSelection: false,
    reason: "The current conversation is used without durable memory or knowledge retrieval.",
  },
  {
    id: "agent_private",
    state: "active",
    conversationHistory: "session",
    durableContext: "agent_private",
    requiresSelection: false,
    reason: "Only memory bound to the exact actor and assigned agent is eligible.",
  },
  {
    id: "mission",
    state: "authority_held",
    conversationHistory: "session",
    durableContext: "authority_held",
    requiresSelection: false,
    reason: "Mission membership and context grants are not active.",
  },
  {
    id: "project",
    state: "authority_held",
    conversationHistory: "session",
    durableContext: "authority_held",
    requiresSelection: false,
    reason: "Project membership, consent, and context grants are not active.",
  },
  {
    id: "workspace",
    state: "authority_held",
    conversationHistory: "session",
    durableContext: "authority_held",
    requiresSelection: false,
    reason: "Workspace membership, consent, and context grants are not active.",
  },
  {
    id: "personal",
    state: "authority_held",
    conversationHistory: "session",
    durableContext: "authority_held",
    requiresSelection: false,
    reason: "Automatic personal-memory disclosure requires active standing authority.",
  },
  {
    id: "explicit_selection",
    state: "active",
    conversationHistory: "session",
    durableContext: "explicit_selection",
    requiresSelection: true,
    reason: "Only the reviewed selection may add durable context to the conversation.",
  },
]);

const policyById = new Map(
  CONTEXT_SCOPE_POLICIES.map((policy) => [policy.id, policy] as const),
);

export function getContextScopePolicy(scopeId: ContextScopeId): ContextScopePolicy {
  const policy = policyById.get(scopeId);
  if (!policy) {
    throw new Error("Unknown context scope.");
  }
  return policy;
}

export function contextScopeUsesThreadHistory(scopeId: ContextScopeId): boolean {
  const policy = getContextScopePolicy(scopeId);
  requireActiveContextScope(policy);
  return policy.conversationHistory === "session";
}

export function contextScopeMemoryMode(
  scopeId: ContextScopeId,
): "session" | "all" {
  const policy = getContextScopePolicy(scopeId);
  requireActiveContextScope(policy);
  return policy.durableContext === "explicit_selection" ||
      policy.durableContext === "agent_private"
    ? "all"
    : "session";
}

export function assertContextScopeRequest(
  scopeId: ContextScopeId,
  contextSelectionPresent: boolean,
): ContextScopePolicy {
  const policy = getContextScopePolicy(scopeId);
  requireActiveContextScope(policy);
  if (policy.requiresSelection !== contextSelectionPresent) {
    throw new Error(
      policy.requiresSelection
        ? "Explicit-selection context requires a reviewed context selection."
        : "A reviewed context selection requires the explicit-selection scope.",
    );
  }
  return policy;
}

function requireActiveContextScope(policy: ContextScopePolicy) {
  if (policy.state !== "active") {
    throw new Error(`Context scope ${policy.id} is held: ${policy.reason}`);
  }
}
