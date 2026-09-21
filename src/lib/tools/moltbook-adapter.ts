import {
  isMoltbookToolId as isCoreMoltbookToolId,
  parseMoltbookToolInput as parseCoreMoltbookToolInput,
} from "@/lib/moltbook/contracts";
import {
  executeMoltbookToolAction,
  moltbookEffectCommitFromResult,
  moltbookPublicToolResult,
  reconcileMoltbookToolAction,
  type MoltbookEffectCommit,
  type MoltbookReconciliationResult,
  type MoltbookToolId,
} from "@/lib/moltbook/tool-actions";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import { toolInputSha256 } from "@/lib/tools/execution-scope";

export {
  moltbookEffectCommitFromResult,
  moltbookPublicToolResult,
};
export type { MoltbookEffectCommit, MoltbookReconciliationResult };

export function isMoltbookToolId(toolId: string): toolId is MoltbookToolId {
  return isCoreMoltbookToolId(toolId);
}

export function parseMoltbookToolInput(
  toolId: MoltbookToolId,
  input: Record<string, unknown>,
) {
  const parsed = parseCoreMoltbookToolInput(toolId, input);
  if (toolId === "moltbook.post.create" && parsed.url !== undefined) {
    assertCredentialFreeHttpsUrl(parsed.url);
  }
  if (
    toolId === "moltbook.verify" &&
    (String(parsed.verificationCode).length > 200 ||
      String(parsed.answer).length > 64)
  ) {
    throw new Error("Moltbook verification input exceeds the governed bound.");
  }
  return parsed;
}

export async function executeGovernedMoltbookToolAction(input: {
  toolId: MoltbookToolId;
  toolInput: Record<string, unknown>;
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  executionRecord?: ToolExecutionRecord;
  effectTargetId?: string;
  agentRunId?: string;
  abortSignal?: AbortSignal;
}) {
  assertGovernedMoltbookAuthority(input);
  const parsed = parseMoltbookToolInput(input.toolId, input.toolInput);

  return executeMoltbookToolAction({
    toolId: input.toolId,
    toolInput: parsed,
    context: input.context!,
    executionScope: input.executionScope!,
    toolExecutionId: input.executionRecord!.id,
    agentRunId: input.agentRunId,
    effectTargetId: input.effectTargetId,
    toolInputSha256: toolInputSha256(parsed),
    abortSignal: input.abortSignal,
  });
}

export async function reconcileGovernedMoltbookToolAction(input: {
  toolId: MoltbookToolId;
  toolInput: Record<string, unknown>;
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  executionRecord?: ToolExecutionRecord;
  effectTargetId?: string;
  agentRunId?: string;
}) {
  assertGovernedMoltbookAuthority(input);
  const parsed = parseMoltbookToolInput(input.toolId, input.toolInput);
  return reconcileMoltbookToolAction({
    toolId: input.toolId,
    toolInput: parsed,
    context: input.context!,
    executionScope: input.executionScope!,
    toolExecutionId: input.executionRecord!.id,
    agentRunId: input.agentRunId,
    effectTargetId: input.effectTargetId,
    toolInputSha256: toolInputSha256(parsed),
  });
}

function assertGovernedMoltbookAuthority(input: {
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  executionRecord?: ToolExecutionRecord;
}) {
  if (!input.context || !input.executionScope || !input.executionRecord) {
    throw new Error(
      "Moltbook actions require an authenticated, scoped governed execution.",
    );
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    input.context,
  );
  if (
    input.context.tenantId !== input.executionScope.tenantId ||
    !actorBinding ||
    input.context.actorId !== input.executionScope.initiatingActorId
  ) {
    throw new Error(
      "Moltbook action context does not match the governed execution scope.",
    );
  }
  if (!input.executionScope.correlationId) {
    throw new Error("Moltbook actions require an exact correlation ID.");
  }
}

function assertCredentialFreeHttpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("Moltbook post URLs must be bounded HTTPS URLs.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Moltbook post URLs must be valid HTTPS URLs.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    throw new Error(
      "Moltbook post URLs must be credential-free HTTPS URLs.",
    );
  }
}
