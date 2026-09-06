import { z } from "zod";

import {
  parseDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import {
  buildDelegatedPrincipalV1,
  type DelegatedPrincipalV1,
} from "@/lib/delegation/principal";
import { redactSensitive } from "@/lib/security/context";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

export const DELEGATION_BROKER_VERSION = "p8.2-delegation-broker:1" as const;
export const DELEGATION_BROKER_MAX_TOOL_CALLS = 3;
export const DELEGATION_BROKER_MAX_RESULT_CHARS = 12_000;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const toolPlanSchema = z.object({
  status: z.enum(["execute", "no_tool_needed", "clarification_required"]),
  clarification: z.string().trim().max(1_000),
  calls: z.array(z.object({
    callId: idSchema,
    toolId: idSchema,
    input: z.record(z.string().min(1).max(160), z.unknown()),
    rationale: z.string().trim().min(1).max(500),
  }).strict()).max(DELEGATION_BROKER_MAX_TOOL_CALLS),
}).strict().superRefine((value, context) => {
  if (
    (value.status === "execute" && value.calls.length === 0) ||
    (value.status !== "execute" && value.calls.length > 0) ||
    (value.status === "clarification_required" && !value.clarification) ||
    (value.status !== "clarification_required" && value.clarification)
  ) {
    context.addIssue({
      code: "custom",
      message: "Delegation tool plan status does not match its calls or clarification.",
    });
  }
  if (new Set(value.calls.map((call) => call.callId)).size !== value.calls.length) {
    context.addIssue({ code: "custom", message: "Delegation tool call IDs must be unique." });
  }
  for (const call of value.calls) assertSafeToolInput(call.input, context);
});

export type DelegationBrokerToolPlan = Readonly<z.infer<typeof toolPlanSchema>>;

export type DelegationBrokerProgress = Readonly<{
  version: typeof DELEGATION_BROKER_VERSION;
  delegationId: string;
  state:
    | "accepted"
    | "working"
    | "tool_started"
    | "tool_completed"
    | "waiting"
    | "clarification_required"
    | "completed_proposed"
    | "challenged";
  toolId?: string;
  executionId?: string;
  status?: ToolExecutionRecord["status"];
}>;

export type DelegationBrokerToolResult = Readonly<{
  callId: string;
  toolId: string;
  executionId: string;
  status: ToolExecutionRecord["status"];
  dryRun: boolean;
  approvalRequired: boolean;
  outputSha256: string;
  output: unknown;
}>;

export type DelegationBrokerResult = Readonly<{
  version: typeof DELEGATION_BROKER_VERSION;
  status: "completed" | "no_tool_needed" | "waiting" | "clarification_required";
  contractId: string;
  contractSha256: string;
  delegatedPrincipal: DelegatedPrincipalV1;
  executionScope: ExecutionScope;
  toolResults: readonly DelegationBrokerToolResult[];
  clarification?: string;
}>;

export async function runDelegationBroker(input: {
  contract: DelegationContractV1;
  parentExecutionScope: ExecutionScope;
  tools: readonly ToolDefinition[];
  planToolCalls: (input: Readonly<{
    contract: DelegationContractV1;
    delegatedPrincipal: DelegatedPrincipalV1;
    tools: readonly ToolDefinition[];
  }>) => Promise<unknown>;
  executeTool: (input: Readonly<{
    tool: ToolDefinition;
    callId: string;
    toolInput: Record<string, unknown>;
    idempotencyKey: string;
    executionScope: ExecutionScope;
    delegatedPrincipal: DelegatedPrincipalV1;
    abortSignal?: AbortSignal;
  }>) => Promise<Readonly<{
    record: ToolExecutionRecord;
    result?: unknown;
  }>>;
  onProgress?: (progress: DelegationBrokerProgress) => Promise<void> | void;
  abortSignal?: AbortSignal;
  now?: () => number;
}): Promise<DelegationBrokerResult> {
  const contract = parseDelegationContractV1(input.contract);
  const delegatedPrincipal = buildDelegatedPrincipalV1({
    contract,
    parentExecutionScope: input.parentExecutionScope,
  });
  const executionScope = deriveExecutionScope(input.parentExecutionScope, {
    executingPrincipalType: "agent",
    executingPrincipalId: delegatedPrincipal.principalId,
    delegationId: delegatedPrincipal.delegationId,
    causationId: contract.contractId,
    contextGrantIds: delegatedPrincipal.contextGrantIds,
    capabilityGrantIds: delegatedPrincipal.capabilityGrantIds,
    purpose: delegatedPrincipal.purpose,
  });
  const now = input.now || Date.now;
  assertActive(contract, input.abortSignal, now());
  const tools = exactGrantedTools(contract, input.tools);
  await progress(input.onProgress, contract.delegationId, "accepted");
  await progress(input.onProgress, contract.delegationId, "working");
  const plan = parseDelegationBrokerToolPlan(await input.planToolCalls({
    contract,
    delegatedPrincipal,
    tools,
  }));
  if (plan.calls.length > contract.budgets.toolCalls) {
    await progress(input.onProgress, contract.delegationId, "challenged");
    throw new Error("Delegation tool plan exceeds its contract budget.");
  }
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  for (const call of plan.calls) {
    if (!contract.grants.governedToolIds.includes(call.toolId) || !toolsById.has(call.toolId)) {
      await progress(input.onProgress, contract.delegationId, "challenged");
      throw new Error(`Delegation requested ungranted tool ${call.toolId}.`);
    }
  }
  if (plan.status === "clarification_required") {
    await progress(input.onProgress, contract.delegationId, "clarification_required");
    return brokerResult({
      status: "clarification_required",
      contract,
      delegatedPrincipal,
      executionScope,
      toolResults: [],
      clarification: plan.clarification,
    });
  }
  if (plan.status === "no_tool_needed") {
    await progress(input.onProgress, contract.delegationId, "completed_proposed");
    return brokerResult({
      status: "no_tool_needed",
      contract,
      delegatedPrincipal,
      executionScope,
      toolResults: [],
    });
  }

  const toolResults: DelegationBrokerToolResult[] = [];
  for (const call of plan.calls) {
    assertActive(contract, input.abortSignal, now());
    const tool = toolsById.get(call.toolId);
    if (!tool) throw new Error(`Delegation tool ${call.toolId} is unavailable.`);
    const toolExecutionScope = deriveExecutionScope(executionScope, {
      causationId: `delegation-tool:${call.callId}`,
      purpose: "delegation.tool.execute",
    });
    await progress(input.onProgress, contract.delegationId, "tool_started", {
      toolId: tool.id,
    });
    const execution = await input.executeTool({
      tool,
      callId: call.callId,
      toolInput: call.input,
      idempotencyKey: `${contract.idempotencyKeySha256}:${call.callId}`,
      executionScope: toolExecutionScope,
      delegatedPrincipal,
      abortSignal: input.abortSignal,
    });
    if (execution.record.toolId !== tool.id) {
      throw new Error("Delegation broker received a mismatched governed tool receipt.");
    }
    const safeOutput = boundedToolOutput(execution.result);
    const result = {
      callId: call.callId,
      toolId: tool.id,
      executionId: execution.record.id,
      status: execution.record.status,
      dryRun: execution.record.dryRun,
      approvalRequired: execution.record.approvalRequired,
      outputSha256: canonicalJsonSha256(safeOutput),
      output: safeOutput,
    } satisfies DelegationBrokerToolResult;
    toolResults.push(Object.freeze(result));
    await progress(input.onProgress, contract.delegationId, "tool_completed", {
      toolId: tool.id,
      executionId: execution.record.id,
      status: execution.record.status,
    });
    if (
      execution.record.status === "approval_required" ||
      execution.record.status === "executing"
    ) {
      await progress(input.onProgress, contract.delegationId, "waiting", {
        toolId: tool.id,
        executionId: execution.record.id,
        status: execution.record.status,
      });
      return brokerResult({
        status: "waiting",
        contract,
        delegatedPrincipal,
        executionScope,
        toolResults,
      });
    }
  }
  await progress(input.onProgress, contract.delegationId, "completed_proposed");
  return brokerResult({
    status: "completed",
    contract,
    delegatedPrincipal,
    executionScope,
    toolResults,
  });
}

export function parseDelegationBrokerToolPlan(value: unknown) {
  return deepFreeze(toolPlanSchema.parse(value));
}

function exactGrantedTools(
  contract: DelegationContractV1,
  tools: readonly ToolDefinition[],
) {
  const expected = [...contract.grants.governedToolIds].sort();
  const actual = [...new Set(tools.map((tool) => tool.id))].sort();
  if (
    canonicalJsonSha256(expected) !== canonicalJsonSha256(actual) ||
    tools.some((tool) => tool.status !== "active")
  ) {
    throw new Error("Delegation broker tools do not match the contract grant.");
  }
  return Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
}

function assertActive(
  contract: DelegationContractV1,
  abortSignal: AbortSignal | undefined,
  now: number,
) {
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new DOMException("Delegation was canceled.", "AbortError");
  }
  if (
    now < Date.parse(contract.deadline.createdAt) ||
    now >= Date.parse(contract.deadline.completeBy)
  ) {
    throw new Error("Delegation deadline has expired.");
  }
}

async function progress(
  observer: ((value: DelegationBrokerProgress) => Promise<void> | void) | undefined,
  delegationId: string,
  state: DelegationBrokerProgress["state"],
  detail: Pick<DelegationBrokerProgress, "toolId" | "executionId" | "status"> = {},
) {
  if (!observer) return;
  await observer(Object.freeze({
    version: DELEGATION_BROKER_VERSION,
    delegationId,
    state,
    ...detail,
  }));
}

function brokerResult(input: {
  status: DelegationBrokerResult["status"];
  contract: DelegationContractV1;
  delegatedPrincipal: DelegatedPrincipalV1;
  executionScope: ExecutionScope;
  toolResults: readonly DelegationBrokerToolResult[];
  clarification?: string;
}): DelegationBrokerResult {
  return Object.freeze({
    version: DELEGATION_BROKER_VERSION,
    status: input.status,
    contractId: input.contract.contractId,
    contractSha256: input.contract.contractSha256,
    delegatedPrincipal: input.delegatedPrincipal,
    executionScope: input.executionScope,
    toolResults: Object.freeze([...input.toolResults]),
    ...(input.clarification ? { clarification: input.clarification } : {}),
  });
}

function boundedToolOutput(value: unknown) {
  const safe = redactSensitive(value ?? null);
  const serialized = JSON.stringify(safe);
  if (serialized.length <= DELEGATION_BROKER_MAX_RESULT_CHARS) return safe;
  return {
    truncated: true,
    originalSha256: canonicalJsonSha256(safe),
    preview: serialized.slice(0, DELEGATION_BROKER_MAX_RESULT_CHARS),
  };
}

function assertSafeToolInput(value: Record<string, unknown>, context: z.RefinementCtx) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32_000) {
    context.addIssue({ code: "custom", message: "Delegation tool input is too large." });
    return;
  }
  let nodes = 0;
  const visit = (current: unknown, depth: number, key?: string) => {
    nodes += 1;
    if (nodes > 2_000 || depth > 12) {
      context.addIssue({ code: "custom", message: "Delegation tool input is too complex." });
      return;
    }
    if (key && /authorization|cookie|credential|password|private.?key|secret|(?:api|access|refresh).?token/i.test(key)) {
      context.addIssue({ code: "custom", message: "Delegation tool input cannot contain credential fields." });
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else if (current && typeof current === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(current)) {
        visit(nestedValue, depth + 1, nestedKey);
      }
    }
  };
  visit(value, 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
