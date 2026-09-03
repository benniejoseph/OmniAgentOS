import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  listStreamEvents,
} from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityRole } from "@/lib/security/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const TOOL_SCOPE_BOUND_EVENT_TYPE = "tool.scope_bound";

export type ToolExecutionScopeBinding = Readonly<{
  executionScope: ExecutionScope;
  requesterRole: SecurityRole;
  toolId: string;
  inputSha256: string;
}>;

export class ToolExecutionScopeBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionScopeBindingError";
  }
}

/**
 * Binds the original requester and execution scope to a governed-tool receipt.
 * The event ledger is used so this contract can roll out without changing the
 * existing execution table or inventing scope for legacy receipts.
 */
export async function bindToolExecutionScope(input: {
  record: ToolExecutionRecord;
  toolInput: Record<string, unknown>;
  executionScope: ExecutionScope;
  requesterRole: SecurityRole;
}) {
  assertBindingMatchesRecord(input);
  const expected: ToolExecutionScopeBinding = Object.freeze({
    executionScope: input.executionScope,
    requesterRole: input.requesterRole,
    toolId: input.record.toolId,
    inputSha256: toolInputSha256(input.toolInput),
  });
  const tenantId = normalizeTenantId(input.record.tenantId);
  const existing = await getToolExecutionScopeBinding(input.record.id, {
    tenantId,
  });
  if (existing) {
    assertSameBinding(existing, expected);
    return existing;
  }

  await appendDomainEvent({
    streamId: toolExecutionStreamId(input.record.id),
    type: TOOL_SCOPE_BOUND_EVENT_TYPE,
    tenantId,
    payload: {
      scopeVersion: input.executionScope.version,
      scopeSha256: executionScopeSha256(input.executionScope),
      requesterRole: input.requesterRole,
      toolId: input.record.toolId,
      inputSha256: expected.inputSha256,
    },
    correlationId: input.executionScope.correlationId,
    executionScope: input.executionScope,
  });

  const bound = await getToolExecutionScopeBinding(input.record.id, {
    tenantId,
  });
  if (!bound) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution scope binding could not be verified.",
    );
  }
  assertSameBinding(bound, expected);
  return bound;
}

/** Returns the one canonical scope shared by all binding events. */
export async function getToolExecutionScopeBinding(
  executionId: string,
  options: { tenantId?: string } = {},
): Promise<ToolExecutionScopeBinding | undefined> {
  const tenantId = normalizeTenantId(options.tenantId);
  const events = await listStreamEvents(toolExecutionStreamId(executionId), {
    tenantId,
    limit: 2_000,
    order: "asc",
  });
  let bound: ToolExecutionScopeBinding | undefined;
  for (const event of events) {
    if (event.type !== TOOL_SCOPE_BOUND_EVENT_TYPE) continue;
    if (!event.executionScope) {
      throw new ToolExecutionScopeBindingError(
        "Governed tool execution has an invalid scope binding.",
      );
    }
    try {
      assertExecutionScopeTenant(event.executionScope, tenantId);
    } catch {
      throw new ToolExecutionScopeBindingError(
        "Governed tool execution scope binding has the wrong tenant.",
      );
    }
    const requesterRole = parseSecurityRole(event.payload.requesterRole);
    const toolId = boundedString(event.payload.toolId, 512);
    const inputSha256 = sha256String(event.payload.inputSha256);
    const scopeSha256 = sha256String(event.payload.scopeSha256);
    if (
      !requesterRole ||
      !toolId ||
      !inputSha256 ||
      scopeSha256 !== executionScopeSha256(event.executionScope) ||
      event.correlationId !== event.executionScope.correlationId ||
      (event.executionScope.initiatingActorId &&
        event.actorId !== event.executionScope.initiatingActorId)
    ) {
      throw new ToolExecutionScopeBindingError(
        "Governed tool execution scope binding metadata is inconsistent.",
      );
    }
    const candidate: ToolExecutionScopeBinding = Object.freeze({
      executionScope: event.executionScope,
      requesterRole,
      toolId,
      inputSha256,
    });
    if (bound) {
      assertSameBinding(bound, candidate);
    }
    bound = candidate;
  }
  return bound;
}

export function assertToolExecutionBindingMatchesRequest(input: {
  binding: ToolExecutionScopeBinding;
  record: ToolExecutionRecord;
  toolInput: Record<string, unknown>;
  requestedScope?: ExecutionScope;
}) {
  assertBindingMatchesRecord({
    record: input.record,
    toolInput: input.toolInput,
    executionScope: input.binding.executionScope,
    requesterRole: input.binding.requesterRole,
  });
  if (input.binding.toolId !== input.record.toolId) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool receipt does not match its bound tool.",
    );
  }
  if (input.binding.inputSha256 !== toolInputSha256(input.toolInput)) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool input does not match its original scoped request.",
    );
  }
  if (
    input.requestedScope &&
    !executionScopesEqual(input.binding.executionScope, input.requestedScope)
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool receipt is already bound to another execution scope.",
    );
  }
}

export function toolInputSha256(input: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function assertBindingMatchesRecord(input: {
  record: ToolExecutionRecord;
  toolInput: Record<string, unknown>;
  executionScope: ExecutionScope;
  requesterRole: SecurityRole;
}) {
  const tenantId = normalizeTenantId(input.record.tenantId);
  try {
    assertExecutionScopeTenant(input.executionScope, tenantId);
  } catch {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution scope does not match the receipt tenant.",
    );
  }
  if (
    input.executionScope.initiatingActorId &&
    input.record.actorId &&
    input.executionScope.initiatingActorId !== input.record.actorId
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution scope does not match the requester.",
    );
  }
  assertTargetMatchesScope("workspaceId", input.toolInput, input.executionScope);
  assertTargetMatchesScope("projectId", input.toolInput, input.executionScope);
  assertTargetMatchesScope("missionId", input.toolInput, input.executionScope);
}

function assertTargetMatchesScope(
  field: "workspaceId" | "projectId" | "missionId",
  toolInput: Record<string, unknown>,
  scope: ExecutionScope,
) {
  const scopedId = scope[field];
  const requestedId = toolInput[field];
  if (
    scopedId &&
    typeof requestedId === "string" &&
    requestedId.trim() &&
    requestedId.trim() !== scopedId
  ) {
    throw new ToolExecutionScopeBindingError(
      `Governed tool ${field} does not match its execution scope.`,
    );
  }
}

function assertSameBinding(
  left: ToolExecutionScopeBinding,
  right: ToolExecutionScopeBinding,
) {
  if (
    !executionScopesEqual(left.executionScope, right.executionScope) ||
    left.requesterRole !== right.requesterRole ||
    left.toolId !== right.toolId ||
    left.inputSha256 !== right.inputSha256
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution has conflicting scope bindings.",
    );
  }
}

function executionScopeSha256(scope: ExecutionScope) {
  return createHash("sha256").update(stableJson(scope)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseSecurityRole(value: unknown): SecurityRole | undefined {
  return value === "viewer" ||
      value === "operator" ||
      value === "admin" ||
      value === "system"
    ? value
    : undefined;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value
    : undefined;
}

function sha256String(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

function toolExecutionStreamId(executionId: string) {
  return `tool_execution:${executionId}`;
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
