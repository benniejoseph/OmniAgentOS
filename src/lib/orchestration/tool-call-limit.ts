import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { MAX_DEFERRED_TOOL_CALL_HASHES } from "@/lib/runs/types";
import type { AgentEvent, AgentToolLimitMetadata } from "./types";

type Call = { callId: string; name: string; arguments?: string; argumentsJson?: string };
type Allowance = { remainingToolCalls?: number; remainingToolRounds: number };

/** Internal equality only: no arguments or their digests enter status events. */
function requestHash(call: Call) {
  const raw = call.argumentsJson ?? call.arguments ?? "{}";
  let argumentsValue: unknown;
  let parsed = true;
  try { argumentsValue = JSON.parse(raw); } catch { argumentsValue = raw; parsed = false; }
  return canonicalJsonSha256({ version: 1, toolName: call.name, parsed, arguments: argumentsValue });
}

export function deferredToolCallTracker(initial: readonly string[] = []) {
  let hashes = new Set(initial);
  return {
    hashes: () => [...hashes],
    count: () => hashes.size,
    replace: (values: readonly string[]) => { hashes = new Set(values); },
    admit: (calls: readonly Call[]) => { for (const call of calls) hashes.delete(requestHash(call)); },
    defer: (calls: readonly Call[]) => {
      const next = new Set(hashes);
      for (const call of calls) {
        next.add(requestHash(call));
        if (next.size > MAX_DEFERRED_TOOL_CALL_HASHES) throw new Error("Too many distinct deferred tool requests to retain safely.");
      }
      hashes = next;
    },
  };
}

export function toolLimitMetadata(allowance: Allowance, batch?: { proposedCalls: number; admittedCalls: number }): AgentToolLimitMetadata {
  const remainingToolRounds = Math.max(0, allowance.remainingToolRounds);
  return {
    version: 1,
    reason: allowance.remainingToolCalls === 0 ? "run_tool_calls" : remainingToolRounds === 0 ? "run_tool_rounds" : "per_turn_calls",
    ...(batch ? { ...batch, skippedCalls: batch.proposedCalls - batch.admittedCalls } : {}),
    ...(allowance.remainingToolCalls !== undefined ? { remainingToolCalls: Math.max(0, allowance.remainingToolCalls) } : {}),
    remainingToolRounds,
  };
}

export function skippedToolCallPayload(call: Call, toolLimit: AgentToolLimitMetadata) {
  const recoverable = toolLimit.reason === "per_turn_calls";
  return {
    error: recoverable
      ? "This call was not executed because this turn's call allowance was filled. This is not a run-wide limit or an approval denial."
      : toolLimit.reason === "run_tool_calls"
        ? "Run tool-call budget reached; call not run. Answer in text from the results you already have."
        : "Tool step budget reached; call not run. Answer in text from the results you already have.",
    executed: false,
    skippedCall: { callId: call.callId, toolName: call.name },
    toolLimit,
    nextStep: recoverable
      ? "Request this exact call again in the next model turn, together with at most the remaining per-turn allowance. Continue the authorized work instead of concluding that the run reached its action limit. The next turn must still pass time, token, cost, approval, and other run checks."
      : "Do not start more actions in this run. Report the unexecuted work explicitly.",
  };
}

export function toolLimitStatus(toolLimit: AgentToolLimitMetadata): Extract<AgentEvent, { type: "status" }> {
  const recoverable = toolLimit.reason === "per_turn_calls";
  return {
    type: "status",
    label: recoverable ? "tool calls deferred" : "tool budget reached",
    detail: recoverable
      ? `${toolLimit.skippedCalls ?? 0} requested call(s) were not executed in this batch. The model may request them in another turn within the remaining run limits.`
      : `The ${toolLimit.reason === "run_tool_calls" ? "total tool-call" : "tool-round"} allowance is exhausted. Unexecuted calls remain unfinished.`,
    toolLimit,
  };
}

export function unresolvedToolCallStatus(count: number, allowance: Allowance): Extract<AgentEvent, { type: "status" }> {
  return {
    type: "status", label: "requested actions unfinished",
    detail: `${count} earlier requested call(s) were still unexecuted when the model ended. No automatic retry was made.`,
    toolLimit: { ...toolLimitMetadata(allowance), unresolvedCalls: count },
  };
}

export function deferredToolCallNotice(count: number) {
  return `\n\nSome requested work is incomplete: ${count} deferred action(s) did not run. Work depending on those actions remains unfinished.`;
}
