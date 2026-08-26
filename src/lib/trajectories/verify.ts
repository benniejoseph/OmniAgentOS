import { createHash } from "node:crypto";
import type { AgentRunRecord } from "@/lib/runs/types";
import type {
  RunTrajectory,
  TrajectoryVerification,
} from "@/lib/trajectories/types";

export function verifyRunTrajectory(
  trajectory: RunTrajectory,
  run: AgentRunRecord,
): TrajectoryVerification {
  const issues: string[] = [];
  const orderedEvents = trajectory.events.every((event, index, events) =>
    index === 0 || events[index - 1].seq < event.seq
  );
  if (!orderedEvents) issues.push("Events are not in a unique ascending sequence.");

  const expectedResponse = run.response === undefined
    ? undefined
    : {
        length: run.response.length,
        sha256: createHash("sha256").update(run.response).digest("hex"),
      };
  const terminalReceipt = expectedResponse === undefined
    ? trajectory.response === undefined
    : trajectory.response?.length === expectedResponse.length &&
      trajectory.response.sha256 === expectedResponse.sha256;
  if (!terminalReceipt) issues.push("The terminal response receipt does not match the run.");

  const modelEvents = trajectory.events.filter((event) => event.type === "run.model");
  const usageTotals = sum(modelEvents, "inputTokens") === trajectory.usage.inputTokens &&
    sum(modelEvents, "outputTokens") === trajectory.usage.outputTokens &&
    sum(modelEvents, "cachedInputTokens") === trajectory.usage.cachedInputTokens &&
    sum(modelEvents, "totalTokens") === trajectory.usage.totalTokens;
  if (!usageTotals) issues.push("Model usage totals do not match event receipts.");

  const toolReceipts = trajectory.toolExecutionIds.every((id) =>
    trajectory.events.some((event) => event.receipt.executionId === id)
  );
  if (!toolReceipts) issues.push("A tool execution is missing its event receipt.");

  return {
    valid: issues.length === 0,
    checks: { orderedEvents, terminalReceipt, usageTotals, toolReceipts },
    issues,
  };
}

function sum(
  events: RunTrajectory["events"],
  key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "totalTokens",
) {
  return events.reduce((total, event) => {
    const value = Number(event.receipt[key]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}
