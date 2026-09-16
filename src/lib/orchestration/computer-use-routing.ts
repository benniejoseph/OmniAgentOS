import type { ModelAssignmentScope } from "@/lib/settings/types";

/** Selects behavior routing only; it never grants tools or action authority. */
export function modelAssignmentScopeForAgent(
  agentId?: string,
  computerUse = false,
): ModelAssignmentScope {
  if (computerUse) return "computer_use";
  if (agentId === "forge") return "code_builder";
  if (agentId === "sentinel") return "verifier";
  return "main_agent";
}
