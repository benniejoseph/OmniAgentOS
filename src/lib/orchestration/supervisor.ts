import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { AgentPerformance } from "@/lib/agents/performance";
import type { ThreadTurnRecord } from "@/lib/threads/types";

export type SupervisorRoute = "direct" | "durable_workflow" | "clarify";
export type SupervisorAgentId = "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne";

export type SupervisorAmbiguity =
  | { state: "none" }
  | {
      state: "detected";
      reasonCode: "ambiguous_destructive_target";
      clarificationPrompt: string;
    };

export type SupervisorDecision = {
  route: SupervisorRoute;
  score: number;
  reasons: string[];
  requiresApproval: boolean;
  primaryAgentId: SupervisorAgentId;
  specialistIds: SupervisorAgentId[];
  ambiguity: SupervisorAmbiguity;
  learning?: {
    state: "cold_start" | "observing" | "reinforced" | "supported";
    sampleSize: number;
    completionRate: number | null;
    verifiedRate: number | null;
    adjustments: string[];
  };
};

export function routeAgentRequest(
  message: string,
  mode: AgentMode = "orchestrate",
  preferredAgentId?: SupervisorAgentId,
): SupervisorDecision {
  const text = message.trim();
  const reasons: string[] = [];
  let score = 0;
  const durableIntent = hasDurableExecutionIntent(text);
  const boundedCapabilityAction = hasBoundedCapabilityAction(text);
  const actionIntent = /\b(create|update|send|publish|deploy|migrate|execute|implement|investigate|research|compare|coordinate|prepare|run|trigger|dispatch|start)\b/gi;
  const actions = text.match(actionIntent)?.length || 0;
  const externalEffect = /\b(send|publish|deploy|delete|remove|archive|cancel|revoke|purge|destroy|purchase|book|email|post|change external|update production|trigger|dispatch|re-?run)\b/i.test(text) ||
    /\brun\b[^.\n]{0,100}\b(action|automation|workflow|job|pipeline)\b/i.test(text);
  const ambiguity = analyzeAgentRequestAmbiguity(text);
  const team = selectAgentTeam(
    text,
    mode,
    externalEffect && !boundedCapabilityAction,
    preferredAgentId,
  );

  if (ambiguity.state === "detected") {
    return {
      route: "clarify",
      score: 0,
      reasons: ["A destructive request has no uniquely identified target."],
      requiresApproval: externalEffect,
      ambiguity,
      ...team,
    };
  }

  if (durableIntent) { score += 4; reasons.push("Explicit durable or recurring work requested."); }
  if (boundedCapabilityAction && !durableIntent) reasons.push("A bounded workspace action can run directly through governed tools.");
  if (actions >= 2) { score += 2; reasons.push("Multiple distinct actions detected."); }
  if (text.length > 700) { score += 1; reasons.push("Large task description benefits from persisted execution state."); }
  if (/\b(verify|acceptance criteria|report back|with evidence|retries|approval)\b/i.test(text)) { score += 1; reasons.push("Verification or recovery requirements detected."); }
  if (preferredAgentId) reasons.push(`${agentName(preferredAgentId)} was explicitly selected as the primary agent.`);
  if (!reasons.length) reasons.push("A fast conversational response is sufficient.");

  return {
    route: durableIntent || (!boundedCapabilityAction && score >= 4)
      ? "durable_workflow"
      : "direct",
    score,
    reasons,
    requiresApproval: externalEffect,
    ambiguity,
    ...team,
  };
}

export function applySupervisorStrategy(
  decision: SupervisorDecision,
  strategy: "auto" | "direct" | "durable" | undefined,
): SupervisorDecision {
  if (decision.route === "clarify" || !strategy || strategy === "auto") {
    return decision;
  }
  if (strategy === "direct") {
    return {
      ...decision,
      route: "direct",
      reasons: ["Direct execution was explicitly selected."],
    };
  }
  return {
    ...decision,
    route: "durable_workflow",
    reasons: ["Durable execution was explicitly selected."],
  };
}

export function analyzeAgentRequestAmbiguity(message: string): SupervisorAmbiguity {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text || isDestructiveActionDiscussion(text)) return { state: "none" };

  const destructiveRequest = /^(?:please\s+)?(?:go ahead and\s+)?(?:delete|remove|archive|cancel|revoke|purge|destroy)\b/i.test(text) ||
    /\b(?:please|can you|could you|would you|i (?:need|want) you to)\s+(?:delete|remove|archive|cancel|revoke|purge|destroy)\b/i.test(text);
  const vagueTarget = /\b(?:the\s+)?(?:old|older|recent|previous|last|former)\b/i.test(text) ||
    /\b(?:this|that|it|these|those|them)\b/i.test(text);
  if (!destructiveRequest || !vagueTarget || hasExplicitTargetReference(text)) {
    return { state: "none" };
  }

  return {
    state: "detected",
    reasonCode: "ambiguous_destructive_target",
    clarificationPrompt: "Name or identify the exact item you want changed before I continue.",
  };
}

function isDestructiveActionDiscussion(message: string) {
  return /\b(?:how to|how would|what (?:would|happens?)|why (?:did|does|would)|explain(?: how)?|documentation (?:for|about))\b[^.!?\n]{0,120}\b(?:delete|remove|archive|cancel|revoke|purge|destroy)\b/i.test(message) ||
    /\b(?:do not|don't|never)\s+(?:ever\s+)?(?:delete|remove|archive|cancel|revoke|purge|destroy)\b/i.test(message);
}

function hasExplicitTargetReference(message: string) {
  const action = /\b(?:delete|remove|archive|cancel|revoke|purge|destroy)\b/i.exec(message);
  if (!action || action.index === undefined) return false;
  const target = message.slice(action.index + action[0].length, action.index + action[0].length + 240);
  return /https?:\/\/\S+/i.test(target) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(target) ||
    /\b(?:project|repository|repo|file|folder|record|row|issue|ticket|deployment|release|branch|environment|workflow|job|automation|message|email|event|meeting|document|page|contact):[a-z0-9][a-z0-9._-]*\b/i.test(target) ||
    /^\s*(?:(?:the\s+)?(?:project|repository|repo|file|folder|record|row|issue|ticket|deployment|release|branch|environment|workflow|job|automation|message|email|event|meeting|document|page|contact)\s+(?:(?:named|called)\s+)?)?(?:"[^"]{1,160}"|'[^']{1,160}'|“[^”]{1,160}”)/i.test(target) ||
    /\B#[1-9][0-9]*\b/.test(target);
}

function hasDurableExecutionIntent(message: string) {
  return /\b(in the background|keep working|long[- ]running|monitor|watch for|recurring|every (day|week|month|morning|evening)|until (done|complete)|multiple steps|run later|keep checking|check back)\b/i.test(message) ||
    /\b(schedule|run)\b[^.\n]{0,80}\b(task|job|workflow|automation|report)\b[^.\n]{0,80}\b(later|every|daily|weekly|monthly|recurring)\b/i.test(message);
}

function hasBoundedCapabilityAction(message: string) {
  return /\b(run|trigger|dispatch|start|execute|send|post|publish|create|update|delete|book|schedule|read|show|list|get|find|search|check|inspect)\b/i.test(message) &&
    /\b(action|automation|workflow|job|pipeline|repository|repo|email|message|calendar|meeting|event|document|file|folder|page|record|row|issue|ticket|pull request|comment|channel|deployment|release|branch|environment|report|photo|image|contact)\b/i.test(message);
}

export function selectAgentTeam(
  message: string,
  mode: AgentMode,
  consequential = false,
  preferredAgentId?: SupervisorAgentId,
) {
  const research = mode === "research" || /\b(research|find|compare|source|investigate|explain|analy[sz]e)\b/i.test(message);
  const building = mode === "execute" || /\b(build|create|implement|write|fix|deploy|send|publish|automate)\b/i.test(message);
  const memory = mode === "learn" || /\b(remember|recall|learn|knowledge|what did (we|i)|preference)\b/i.test(message);
  const inferredAgentId: SupervisorAgentId = memory ? "mnemosyne" : building ? "forge" : research ? "scout" : "atlas";
  const primaryAgentId = preferredAgentId || inferredAgentId;
  const specialistIds = new Set<SupervisorDecision["primaryAgentId"]>([primaryAgentId]);
  if (preferredAgentId && inferredAgentId !== preferredAgentId && inferredAgentId !== "atlas") specialistIds.add(inferredAgentId);
  if (primaryAgentId !== "atlas" && /\b(plan|coordinate|multiple|workflow|project)\b/i.test(message)) specialistIds.add("atlas");
  if (research && building) { specialistIds.add("scout"); specialistIds.add("forge"); }
  if (consequential || /\b(verify|review|audit|safe|risk|evidence|production)\b/i.test(message)) specialistIds.add("sentinel");
  if (/\b(remember|learn|save|reuse|preference)\b/i.test(message)) specialistIds.add("mnemosyne");
  if (specialistIds.size > 1) specialistIds.add("sentinel");
  return { primaryAgentId, specialistIds: [...specialistIds] };
}

export function adaptSupervisorDecision(
  decision: SupervisorDecision,
  performance: AgentPerformance[],
): SupervisorDecision {
  const primary = performance.find((item) => item.agentId === decision.primaryAgentId);
  const sampleSize = primary ? primary.completed + primary.failed : 0;
  const verifiedRate = primary?.completed
    ? primary.verifiedAnswers / primary.completed
    : null;
  const adjustments: string[] = [];
  const specialists = new Set(decision.specialistIds);
  const feedbackCount = primary
    ? primary.usefulOutcomes + primary.needsWorkOutcomes
    : 0;

  if (primary && sampleSize >= 3 && primary.completionRate !== null && primary.completionRate < 0.7) {
    specialists.add("sentinel");
    if (decision.primaryAgentId !== "atlas") specialists.add("atlas");
    adjustments.push(
      `${agentName(decision.primaryAgentId)} receives planning and verification support after recent incomplete outcomes.`,
    );
  }

  if (
    primary &&
    decision.specialistIds.includes("scout") &&
    primary.completed >= 3 &&
    verifiedRate !== null &&
    verifiedRate < 0.5
  ) {
    specialists.add("sentinel");
    adjustments.push("Sentinel was added because recent answers need stronger evidence verification.");
  }

  if (
    primary &&
    feedbackCount >= 2 &&
    primary.userApprovalRate !== null &&
    primary.userApprovalRate < 0.6
  ) {
    specialists.add("sentinel");
    if (decision.primaryAgentId !== "atlas") specialists.add("atlas");
    adjustments.push(
      `${agentName(decision.primaryAgentId)} receives extra support after your recent outcome feedback.`,
    );
  }

  let state: NonNullable<SupervisorDecision["learning"]>["state"] = "cold_start";
  if (sampleSize >= 3) state = adjustments.length ? "supported" : "observing";
  if (
    sampleSize >= 5 &&
    primary?.completionRate !== null &&
    primary?.completionRate !== undefined &&
    primary.completionRate >= 0.85 &&
    !adjustments.length
  ) {
    state = "reinforced";
  }

  return {
    ...decision,
    specialistIds: [...specialists],
    reasons: adjustments.length ? [...decision.reasons, ...adjustments] : decision.reasons,
    learning: {
      state,
      sampleSize,
      completionRate: primary?.completionRate ?? null,
      verifiedRate,
      adjustments,
    },
  };
}

function agentName(agentId: SupervisorAgentId) {
  return {
    atlas: "Atlas",
    scout: "Scout",
    forge: "Forge",
    sentinel: "Sentinel",
    mnemosyne: "Mnemosyne",
  }[agentId];
}

export function compileThreadContext(
  turns: ThreadTurnRecord[],
  options: { maxMessages?: number; maxCharacters?: number; maxTokens?: number } = {},
) {
  const maxMessages = Math.min(Math.max(options.maxMessages || 40, 1), 100);
  const maxCharacters = Math.min(Math.max(options.maxCharacters || 48_000, 2_000), 120_000);
  const maxTokens = Math.min(Math.max(options.maxTokens || 12_000, 500), 30_000);
  const selected: ChatMessage[] = [];
  let characters = 0;
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const turn = turns[index];
    const remainingCharacters = maxCharacters - characters;
    const remainingTokenCharacters = (maxTokens - tokens) * 4;
    const remaining = Math.min(remainingCharacters, remainingTokenCharacters);
    if (remaining <= 0) break;
    const content = turn.content.length > remaining ? turn.content.slice(-remaining) : turn.content;
    selected.unshift({ role: turn.role, content });
    characters += content.length;
    tokens += estimateTokens(content);
  }
  return {
    messages: selected,
    stats: { selected: selected.length, omitted: Math.max(0, turns.length - selected.length), characters, tokens },
  };
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}
