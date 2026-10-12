import type { ModelAssignmentScope } from "@/lib/settings/types";
import type { ComputerUseTarget } from "@/lib/orchestration/types";

/** Recognizes an explicit target; it never selects a device or grants access. */
export function isLocalComputerTarget(value: unknown): value is ComputerUseTarget {
  return value === "local_macos" || value === "local_android";
}

export function localComputerTargetFrom(value: unknown): ComputerUseTarget | undefined {
  return isLocalComputerTarget(value) ? value : undefined;
}

export function isLocalComputerToolId(value: string): boolean {
  return value.startsWith("local.macos.") || value.startsWith("local.android.");
}

export function isLocalComputerAppListTool(value: string | undefined): boolean {
  return value === "local.macos.list_apps" || value === "local.android.list_apps";
}

/** Selects behavior routing only; it never grants tools or action authority. */
export function modelAssignmentScopeForAgent(
  agentId?: string,
  computerUse = false,
): ModelAssignmentScope {
  if (computerUse) return "computer_use";
  if (agentId === "forge") return "code_builder";
  if (agentId === "sentinel") return "verifier";
  if (agentId === "meridian") return "market_research";
  if (agentId === "mnemosyne") return "memory";
  if (agentId === "scout") return "council";
  return "main_agent";
}
