import type { CouncilFailureCode, CouncilFailureStage } from "@/lib/orchestration/types";

const stages = new Set<CouncilFailureStage>([
  "delegation", "tool_plan_model", "tool_plan_parse", "tool_execution",
  "contribution_model", "contribution_parse", "proposal", "parent_evaluation",
]);
const codes = new Set<CouncilFailureCode>([
  "abort", "authentication", "context_length", "invalid_request", "overloaded",
  "rate_limit", "safety", "timeout", "unavailable", "unknown", "invalid_json",
  "invalid_tool_plan", "invalid_contribution", "invalid_evidence_ids",
  "execution_failed", "proposal_failed", "parent_rejected",
]);

/** Only bounded diagnostic labels and an opaque usage-receipt ID cross event projections. */
export function councilFailureMetadata(value: unknown): {
  failureStage?: CouncilFailureStage;
  failureCode?: CouncilFailureCode;
  usageReceiptId?: string;
} {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  return {
    ...(typeof input.failureStage === "string" && stages.has(input.failureStage as CouncilFailureStage)
      ? { failureStage: input.failureStage as CouncilFailureStage }
      : {}),
    ...(typeof input.failureCode === "string" && codes.has(input.failureCode as CouncilFailureCode)
      ? { failureCode: input.failureCode as CouncilFailureCode }
      : {}),
    ...(typeof input.usageReceiptId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.usageReceiptId)
      ? { usageReceiptId: input.usageReceiptId }
      : {}),
  };
}
