import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { AgentPerformance } from "@/lib/agents/performance";
import type { ThreadTurnRecord } from "@/lib/threads/types";

export type SupervisorRoute = "direct" | "durable_workflow";
export type SupervisorAgentId = "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne";

export type SupervisorDecision = {
  route: SupervisorRoute;
  score: number;
  reasons: string[];
  requiresApproval: boolean;
  primaryAgentId: SupervisorAgentId;
  specialistIds: SupervisorAgentId[];
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
  const durableIntent = /\b(in the background|keep working|long[- ]running|workflow|monitor|watch for|every (day|week|morning)|schedule|recurring|until (done|complete)|multiple steps)\b/i.test(text);
  const actionIntent = /\b(create|update|send|publish|deploy|migrate|execute|implement|investigate|research|compare|coordinate|prepare)\b/gi;
  const actions = text.match(actionIntent)?.length || 0;
  const externalEffect = /\b(send|publish|deploy|delete|purchase|book|email|post|change external|update production)\b/i.test(text);
  const team = selectAgentTeam(text, mode, externalEffect, preferredAgentId);

  if (durableIntent) { score += 4; reasons.push("Explicit durable or recurring work requested."); }
  if (actions >= 2) { score += 2; reasons.push("Multiple distinct actions detected."); }
  if (text.length > 700) { score += 1; reasons.push("Large task description benefits from persisted execution state."); }
  if (mode === "execute") { score += 1; reasons.push("Execute mode favors governed durable work."); }
  if (/\b(verify|acceptance criteria|report back|with evidence|retries|approval)\b/i.test(text)) { score += 1; reasons.push("Verification or recovery requirements detected."); }
  if (preferredAgentId) reasons.push(`${agentName(preferredAgentId)} was explicitly selected as the primary agent.`);
  if (!reasons.length) reasons.push("A fast conversational response is sufficient.");

  return {
    route: score >= 4 ? "durable_workflow" : "direct",
    score,
    reasons,
    requiresApproval: externalEffect,
    ...team,
  };
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
