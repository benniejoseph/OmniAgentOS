import type { ToolDefinition } from "@/lib/tools/types";
import type { AgentToolLimitMetadata } from "./types";

export type ImprovementToolBinding = Readonly<{
  projectId: string; sessionId: string; readOnly: boolean;
  allowedToolIds: readonly string[];
  assertCurrent: () => Promise<void>;
}>;
const sessionless = new Set(["app.projects.builder.show", "app.projects.builder.create", "app.projects.builder.repositories.list"]);
const belongs = (binding: ImprovementToolBinding, toolId: string) => toolId.startsWith("app.projects.builder.") && binding.allowedToolIds.includes(toolId);

/** Only the provider-facing schema loses coordinates. The governed registry stays intact. */
export function improvementToolSchema(binding: ImprovementToolBinding | undefined, toolId: string, schema: Record<string, unknown>) {
  if (!binding || !belongs(binding, toolId)) return schema;
  const properties = { ...(schema.properties as Record<string, unknown>) };
  delete properties.projectId; delete properties.sessionId;
  return { ...schema, properties, required: Array.isArray(schema.required) ? schema.required.filter(key => key !== "projectId" && key !== "sessionId") : [], additionalProperties: false };
}

/** Injection precedes the existing validator, scope binding and idempotency hash. */
export function improvementToolInput(binding: ImprovementToolBinding | undefined, toolId: string, input: Record<string, unknown>) {
  if (!binding || !belongs(binding, toolId)) return input;
  if ((Object.hasOwn(input, "projectId") && input.projectId !== binding.projectId) || (Object.hasOwn(input, "sessionId") && input.sessionId !== binding.sessionId)) throw new Error("The tool's supplied project or workspace differs from its bound improvement phase.");
  return { ...input, projectId: binding.projectId, ...(!sessionless.has(toolId) ? { sessionId: binding.sessionId } : {}) };
}

type Call = { callId: string; name: string };
type PendingReason = "per_turn_calls" | "run_tool_calls" | "run_tool_rounds" | "answer_reservation" | "time_reserved" | "invalid_arguments";

/** Content-free handles survive in typed run events when no executor receipt exists. */
export function improvementPendingCalls(binding: ImprovementToolBinding | undefined, calls: readonly Call[], definition: (name: string) => ToolDefinition | undefined, reason: PendingReason): NonNullable<AgentToolLimitMetadata["pendingCalls"]> {
  if (!binding) return [];
  return calls.slice(0, 48).flatMap(call => {
    const tool = definition(call.name);
    return tool && belongs(binding, tool.id) && /^[A-Za-z0-9_-]{1,160}$/.test(call.callId) ? [{ callId: call.callId, toolId: tool.id, reason }] : [];
  });
}

/** A synchronous drain of already-requested reads, never a retry or a durable work queue. */
export function improvementReadBatch(input: {
  binding?: ImprovementToolBinding; calls: readonly Call[]; definition: (name: string) => ToolDefinition | undefined;
  maxPerBatch: number; remainingRounds: number; remainingCalls: number; forceApproval?: boolean;
}) {
  const binding = input.binding;
  if (!binding?.readOnly || input.forceApproval || !input.calls.length || !input.calls.every(call => {
    const tool = input.definition(call.name);
    return tool && belongs(binding, tool.id) && tool.riskLevel === 0 && !tool.approvalRequired && /^[A-Za-z0-9_-]{1,160}$/.test(call.callId);
  })) return undefined;
  const callLimit = Math.min(input.calls.length, input.remainingCalls, input.maxPerBatch * input.remainingRounds);
  let stopped: PendingReason | undefined;
  const refused = new Map<number, PendingReason>();
  return {
    callLimit,
    refuse: (index: number, reason: PendingReason) => { refused.set(index, reason); },
    async beforeCall(index: number, options: { abortSignal?: AbortSignal; timeReserved: boolean; canReserveAnswer?: (resultCount: number) => boolean }) {
      options.abortSignal?.throwIfAborted();
      await binding.assertCurrent();
      if (options.timeReserved) stopped = "time_reserved";
      // The original reservation covered one batch. Extra batches must retain
      // room for every bounded result plus a final answer in the same budget.
      if (!stopped && index >= input.maxPerBatch && index % input.maxPerBatch === 0 && options.canReserveAnswer?.(Math.min(callLimit, index + input.maxPerBatch)) !== true) stopped = "answer_reservation";
      if (stopped) refused.set(index, stopped);
      return stopped;
    },
    pending(): NonNullable<AgentToolLimitMetadata["pendingCalls"]> {
      return input.calls.slice(0, 48).flatMap((call, index) => {
        const reason = refused.get(index) || (index >= callLimit ? input.remainingCalls <= index ? "run_tool_calls" : "run_tool_rounds" : undefined);
        return reason ? [{ callId: call.callId, toolId: input.definition(call.name)!.id, reason }] : [];
      });
    },
    queued(): NonNullable<AgentToolLimitMetadata["pendingCalls"]> {
      return input.calls.slice(input.maxPerBatch, input.maxPerBatch + 48).map(call => ({ callId: call.callId, toolId: input.definition(call.name)!.id, reason: "per_turn_calls" }));
    },
  };
}
