import { createHash } from "node:crypto";
import type { ToolDefinition } from "@/lib/tools/types";

export function toolApprovalFingerprint(tool: ToolDefinition) {
  return (
    tool.approvalFingerprint ||
    fingerprintApprovalContract({
      id: tool.id,
      category: tool.category,
      status: tool.status,
      riskLevel: tool.riskLevel,
      approvalRequired: tool.approvalRequired,
      ...(tool.operationClass
        ? { operationClass: tool.operationClass }
        : {}),
      inputSchema: tool.inputSchema,
    })
  );
}

export function fingerprintApprovalContract(value: unknown) {
  return createHash("sha256")
    .update(stableJson(value, 0, { nodes: 0 }), "utf8")
    .digest("base64url");
}

function stableJson(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): string {
  budget.nodes += 1;
  if (depth > 40 || budget.nodes > 10_000) {
    throw new Error("Tool approval contract is too deeply nested or complex.");
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => stableJson(item, depth + 1, budget))
      .join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${stableJson(item, depth + 1, budget)}`,
    )
    .join(",")}}`;
}
