import "server-only";

import type { SecurityContext } from "@/lib/security/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import {
  isMoltbookToolId,
  parseMoltbookToolInput,
  type MoltbookRateLimitProjection,
  type MoltbookToolId,
} from "@/lib/moltbook/contracts";
import {
  createMoltbookClient,
  MoltbookProviderError,
  type MoltbookHttpResult,
} from "@/lib/moltbook/http-client";
import {
  appendMoltbookToolActivity,
  MoltbookConnectionError,
  observeMoltbookRateLimit,
  resolveMoltbookAgentOwner,
  resolveMoltbookConnectionForTool,
  type MoltbookConnectionAccess,
} from "@/lib/moltbook/store";

export type { MoltbookToolId } from "@/lib/moltbook/contracts";

export type MoltbookUntrustedReadResult = Readonly<{
  source: "moltbook";
  untrusted: true;
  data: unknown;
  rateLimit?: MoltbookRateLimitProjection;
}>;

export type MoltbookPendingVerificationResult = Readonly<{
  source: "moltbook";
  untrusted: true;
  status: "pending_verification";
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
  verification: Readonly<{
    verificationCode: string;
    challengeText: string;
    expiresAt?: string;
  }>;
}>;

export type MoltbookMutationResult = Readonly<{
  status: "published" | "succeeded";
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
}>;

export type MoltbookToolActionResult =
  | MoltbookUntrustedReadResult
  | MoltbookPendingVerificationResult
  | MoltbookMutationResult;

class RecordedMoltbookEffectError extends MoltbookConnectionError {}

export async function executeMoltbookToolAction(input: {
  toolId: MoltbookToolId;
  toolInput: unknown;
  context: SecurityContext;
  executionScope: ExecutionScope;
  toolExecutionId: string;
  agentRunId?: string;
  abortSignal?: AbortSignal;
}): Promise<MoltbookToolActionResult> {
  if (!isMoltbookToolId(input.toolId)) {
    throw new MoltbookConnectionError("Unknown Moltbook tool action.", {
      status: 400,
      code: "tool_unknown",
    });
  }
  const authority = await exactToolAuthority(input);
  const toolInput = parseMoltbookToolInput(input.toolId, input.toolInput);
  const access = await resolveMoltbookConnectionForTool({
    tenantId: input.executionScope.tenantId,
    ownerActorId: authority.ownerActorId,
    executingAgentId: authority.executingAgentId,
  });
  const client = createMoltbookClient({
    apiKey: access.apiKey,
    abortSignal: input.abortSignal,
  });

  if (isReadTool(input.toolId)) {
    return executeRead(input, toolInput, access, client);
  }
  return executeMutation(input, toolInput, access, client);
}

async function executeRead(
  input: Parameters<typeof executeMoltbookToolAction>[0],
  toolInput: Record<string, unknown>,
  access: MoltbookConnectionAccess,
  client: ReturnType<typeof createMoltbookClient>,
): Promise<MoltbookUntrustedReadResult> {
  const publicAccess = withoutApiKey(access);
  try {
    const result = input.toolId === "moltbook.home.read"
      ? await client.home()
      : input.toolId === "moltbook.feed.read"
        ? await client.feed(toolInput as {
            sort: "new" | "hot" | "top";
            limit: number;
            filter?: "following";
          })
        : await client.thread(toolInput as {
            postId: string;
            sort: "best" | "new" | "old";
            limit: number;
          });
    await observeMoltbookRateLimit({ access: publicAccess, rateLimit: result.rateLimit });
    await appendMoltbookToolActivity({
      access: publicAccess,
      kind: toolKind(input.toolId),
      status: "succeeded",
      summary: readSummary(input.toolId),
      toolExecutionId: input.toolExecutionId,
      agentRunId: input.agentRunId,
      requestSha256: result.requestSha256,
      responseSha256: result.responseSha256,
    });
    return {
      source: "moltbook",
      untrusted: true,
      data: result.data,
      ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}),
    };
  } catch (error) {
    await recordToolFailure(input, publicAccess, error, false);
    throw error;
  }
}

async function executeMutation(
  input: Parameters<typeof executeMoltbookToolAction>[0],
  toolInput: Record<string, unknown>,
  access: MoltbookConnectionAccess,
  client: ReturnType<typeof createMoltbookClient>,
): Promise<MoltbookMutationResult | MoltbookPendingVerificationResult> {
  const publicAccess = withoutApiKey(access);
  try {
    const result = await callMutation(input.toolId, toolInput, client);
    if (input.toolId === "moltbook.verify") {
      const settled = await settleVerification(input, toolInput, publicAccess, result);
      await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
      return settled;
    }
    const providerObject = providerObjectFromResponse(input.toolId, result.data);
    const targetObject = targetObjectFromInput(input.toolId, toolInput);
    const activityObject = providerObject || targetObject;
    await assertSuccessfulProviderEffect({
      input,
      access: publicAccess,
      result,
      providerObject: activityObject,
      identityRequired: input.toolId === "moltbook.post.create" ||
        input.toolId === "moltbook.comment.create",
    });
    const verification = verificationFromResponse(result.data);
    if (verification) {
      await appendMoltbookToolActivity({
        access: publicAccess,
        kind: toolKind(input.toolId),
        status: "pending_verification",
        summary: "Moltbook accepted the content, but verification is required before publication.",
        providerObjectType: activityObject?.type,
        providerObjectRef: activityObject?.ref,
        providerObjectUrl: activityObject?.url,
        toolExecutionId: input.toolExecutionId,
        agentRunId: input.agentRunId,
        requestSha256: result.requestSha256,
        responseSha256: result.responseSha256,
        effect: true,
      });
      await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
      return {
        source: "moltbook",
        untrusted: true,
        status: "pending_verification",
        providerObject,
        verification,
      };
    }
    const status = publishStatus(input.toolId);
    await appendMoltbookToolActivity({
      access: publicAccess,
      kind: toolKind(input.toolId),
      status,
      summary: mutationSummary(input.toolId, status, toolInput),
      providerObjectType: activityObject?.type,
      providerObjectRef: activityObject?.ref,
      providerObjectUrl: activityObject?.url,
      toolExecutionId: input.toolExecutionId,
      agentRunId: input.agentRunId,
      requestSha256: result.requestSha256,
      responseSha256: result.responseSha256,
      effect: true,
    });
    await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
    return { status, providerObject };
  } catch (error) {
    if (error instanceof RecordedMoltbookEffectError) throw error;
    await recordToolFailure(input, publicAccess, error, true);
    throw error;
  }
}

async function settleVerification(
  input: Parameters<typeof executeMoltbookToolAction>[0],
  toolInput: Record<string, unknown>,
  access: Omit<MoltbookConnectionAccess, "apiKey">,
  result: MoltbookHttpResult,
): Promise<MoltbookMutationResult> {
  const record = providerRecord(result.data);
  const providerObject = verificationProviderObject(record) ||
    targetObjectFromInput(input.toolId, toolInput);
  if (record.success !== true) {
    await appendMoltbookToolActivity({
      access,
      kind: "verification",
      status: "failed",
      summary: "Moltbook did not accept the verification answer.",
      providerObjectType: providerObject?.type,
      providerObjectRef: providerObject?.ref,
      providerObjectUrl: providerObject?.url,
      toolExecutionId: input.toolExecutionId,
      agentRunId: input.agentRunId,
      requestSha256: result.requestSha256,
      responseSha256: result.responseSha256,
      errorCode: "verification_failed",
      effect: true,
    });
    await observeRateLimitAfterEffect(access, result.rateLimit);
    throw new RecordedMoltbookEffectError(
      "Moltbook did not accept the verification answer.",
      { code: "verification_failed" },
    );
  }
  await appendMoltbookToolActivity({
    access,
    kind: "verification",
    status: "published",
    summary: "Moltbook verification succeeded and the content is published.",
    providerObjectType: providerObject?.type,
    providerObjectRef: providerObject?.ref,
    providerObjectUrl: providerObject?.url,
    toolExecutionId: input.toolExecutionId,
    agentRunId: input.agentRunId,
    requestSha256: result.requestSha256,
    responseSha256: result.responseSha256,
    effect: true,
  });
  return { status: "published", providerObject };
}

async function assertSuccessfulProviderEffect(input: {
  input: Parameters<typeof executeMoltbookToolAction>[0];
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  result: MoltbookHttpResult;
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
  identityRequired: boolean;
}) {
  const record = providerRecord(input.result.data);
  const errorCode = record.success !== true
    ? "provider_effect_rejected"
    : input.identityRequired && !input.providerObject
      ? "provider_effect_identity_missing"
      : undefined;
  if (!errorCode) return;
  await appendMoltbookToolActivity({
    access: input.access,
    kind: toolKind(input.input.toolId),
    status: "failed",
    summary: errorCode === "provider_effect_rejected"
      ? "Moltbook did not confirm the requested public change."
      : "Moltbook confirmed the request without a valid public object identity.",
    providerObjectType: input.providerObject?.type,
    providerObjectRef: input.providerObject?.ref,
    providerObjectUrl: input.providerObject?.url,
    toolExecutionId: input.input.toolExecutionId,
    agentRunId: input.input.agentRunId,
    requestSha256: input.result.requestSha256,
    responseSha256: input.result.responseSha256,
    errorCode,
    effect: true,
  });
  await observeRateLimitAfterEffect(input.access, input.result.rateLimit);
  throw new RecordedMoltbookEffectError(
    errorCode === "provider_effect_rejected"
      ? "Moltbook did not confirm the requested public change."
      : "Moltbook did not return a valid identity for the created content.",
    { code: errorCode },
  );
}

async function observeRateLimitAfterEffect(
  access: Omit<MoltbookConnectionAccess, "apiKey">,
  rateLimit: MoltbookRateLimitProjection | undefined,
) {
  await observeMoltbookRateLimit({ access, rateLimit }).catch(() => undefined);
}

function callMutation(
  toolId: MoltbookToolId,
  toolInput: Record<string, unknown>,
  client: ReturnType<typeof createMoltbookClient>,
) {
  switch (toolId) {
    case "moltbook.post.create":
      return client.createPost(toolInput as {
        submoltName: string;
        title: string;
        content?: string;
        url?: string;
        type?: "text" | "link" | "image";
      });
    case "moltbook.comment.create":
      return client.createComment(toolInput as {
        postId: string;
        content: string;
        parentId?: string;
      });
    case "moltbook.post.vote":
      return client.votePost(
        String(toolInput.postId),
        toolInput.direction as "up" | "down",
      );
    case "moltbook.comment.upvote":
      return client.upvoteComment(String(toolInput.commentId));
    case "moltbook.agent.follow":
      return client.followAgent(String(toolInput.name), Boolean(toolInput.follow));
    case "moltbook.verify":
      return client.verify(
        String(toolInput.verificationCode),
        String(toolInput.answer),
      );
    default:
      throw new MoltbookConnectionError("Moltbook read action reached the mutation boundary.", {
        status: 400,
        code: "tool_operation_mismatch",
      });
  }
}

async function recordToolFailure(
  input: Parameters<typeof executeMoltbookToolAction>[0],
  access: Omit<MoltbookConnectionAccess, "apiKey">,
  error: unknown,
  effect: boolean,
) {
  const provider = error instanceof MoltbookProviderError ? error : undefined;
  const code = provider?.code ||
    (error instanceof MoltbookConnectionError ? error.code : "tool_failed");
  if (provider?.rateLimit) {
    await observeMoltbookRateLimit({ access, rateLimit: provider.rateLimit })
      .catch(() => undefined);
  }
  await appendMoltbookToolActivity({
    access,
    kind: toolKind(input.toolId),
    status: "failed",
    summary: effect
      ? "The Moltbook mutation did not complete. It was not retried."
      : "The Moltbook read did not complete.",
    toolExecutionId: input.toolExecutionId,
    agentRunId: input.agentRunId,
    requestSha256: provider?.requestSha256,
    responseSha256: provider?.responseSha256,
    errorCode: code,
    effect: effect && Boolean(provider?.requestSha256),
  }).catch(() => undefined);
}

async function exactToolAuthority(
  input: Parameters<typeof executeMoltbookToolAction>[0],
) {
  const scope = input.executionScope;
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(input.context);
  if (
    input.context.tenantId !== scope.tenantId ||
    !actorBinding ||
    !scope.initiatingActorId ||
    input.context.actorId !== scope.initiatingActorId ||
    scope.executingPrincipalType !== "agent" ||
    !scope.executingPrincipalId ||
    !input.toolExecutionId.trim() ||
    input.toolExecutionId.length > 240 ||
    (input.agentRunId !== undefined &&
      (!input.agentRunId.trim() || input.agentRunId.length > 240))
  ) {
    throw new MoltbookConnectionError(
      "Moltbook tool authority does not match the exact owner and Agent scope.",
      { code: "tool_authority_mismatch" },
    );
  }
  const owner = await resolveMoltbookAgentOwner({
    tenantId: scope.tenantId,
    agentId: scope.executingPrincipalId,
    readableOwnerActorIds: actorBinding.readableOwnerActorIds,
  });
  return {
    ownerActorId: owner.actorId,
    executingAgentId: scope.executingPrincipalId,
  };
}

function verificationFromResponse(
  data: unknown,
): MoltbookPendingVerificationResult["verification"] | undefined {
  const root = providerRecord(data);
  const object = providerRecord(root.post || root.comment || root.content);
  const raw = providerRecord(object.verification || root.verification);
  const required = root.verification_required === true ||
    object.verification_status === "pending" ||
    Object.keys(raw).length > 0;
  if (!required) return undefined;
  const verificationCode = boundedProviderString(raw.verification_code, 240);
  const challengeText = boundedProviderString(raw.challenge_text, 2_000);
  if (!verificationCode || !challengeText) {
    throw new MoltbookConnectionError(
      "Moltbook requested verification without a complete challenge.",
      { code: "verification_challenge_invalid" },
    );
  }
  return {
    verificationCode,
    challengeText,
    ...(boundedProviderString(raw.expires_at, 100)
      ? { expiresAt: boundedProviderString(raw.expires_at, 100) }
      : {}),
  };
}

function providerObjectFromResponse(
  toolId: MoltbookToolId,
  data: unknown,
) {
  const root = providerRecord(data);
  const expectedType = toolId === "moltbook.post.create"
    ? "post"
    : toolId === "moltbook.comment.create"
      ? "comment"
      : undefined;
  if (!expectedType) return undefined;
  const object = providerRecord(root[expectedType] || root.content || root);
  const ref = boundedProviderId(object.id || root.content_id);
  if (!ref) return undefined;
  return {
    type: expectedType,
    ref,
    url: expectedType === "post"
      ? `https://www.moltbook.com/post/${encodeURIComponent(ref)}`
      : undefined,
  };
}

function targetObjectFromInput(
  toolId: MoltbookToolId,
  toolInput: Record<string, unknown>,
) {
  if (toolId === "moltbook.post.vote") {
    const ref = boundedProviderId(toolInput.postId);
    return ref ? {
      type: "post",
      ref,
      url: `https://www.moltbook.com/post/${encodeURIComponent(ref)}`,
    } : undefined;
  }
  if (toolId === "moltbook.comment.upvote") {
    const ref = boundedProviderId(toolInput.commentId);
    return ref ? { type: "comment", ref } : undefined;
  }
  if (toolId === "moltbook.agent.follow") {
    const ref = boundedProviderId(toolInput.name);
    return ref ? { type: "agent", ref } : undefined;
  }
  return undefined;
}

function verificationProviderObject(record: Record<string, unknown>) {
  const type = record.content_type === "comment" ? "comment"
    : record.content_type === "post" ? "post"
    : undefined;
  const ref = boundedProviderId(record.content_id);
  if (!type || !ref) return undefined;
  return {
    type,
    ref,
    url: type === "post"
      ? `https://www.moltbook.com/post/${encodeURIComponent(ref)}`
      : undefined,
  };
}

function withoutApiKey(access: MoltbookConnectionAccess) {
  return {
    connectionId: access.connectionId,
    tenantId: access.tenantId,
    ownerActorId: access.ownerActorId,
    agentId: access.agentId,
    externalName: access.externalName,
  };
}

function isReadTool(toolId: MoltbookToolId) {
  return toolId === "moltbook.home.read" ||
    toolId === "moltbook.feed.read" ||
    toolId === "moltbook.thread.read";
}

function publishStatus(toolId: MoltbookToolId): "published" | "succeeded" {
  return toolId === "moltbook.post.create" ||
      toolId === "moltbook.comment.create"
    ? "published"
    : "succeeded";
}

function toolKind(toolId: MoltbookToolId) {
  return toolId.replace(/^moltbook\./, "").replace(/\./g, "_");
}

function readSummary(toolId: MoltbookToolId) {
  if (toolId === "moltbook.home.read") return "Moltbook home was read.";
  if (toolId === "moltbook.feed.read") return "Moltbook feed was read.";
  return "A Moltbook thread was read.";
}

function mutationSummary(
  toolId: MoltbookToolId,
  status: "published" | "succeeded",
  toolInput: Record<string, unknown>,
) {
  if (status === "published") return "Moltbook content was published.";
  if (toolId === "moltbook.post.vote") {
    return `${toolInput.direction === "down" ? "Downvoted" : "Upvoted"} Moltbook post ${String(toolInput.postId)}.`;
  }
  if (toolId === "moltbook.comment.upvote") {
    return `Upvoted Moltbook comment ${String(toolInput.commentId)}.`;
  }
  if (toolId === "moltbook.agent.follow") {
    return `${toolInput.follow ? "Followed" : "Unfollowed"} Moltbook agent ${String(toolInput.name)}.`;
  }
  return "Moltbook mutation completed.";
}

function providerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedProviderString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function boundedProviderId(value: unknown) {
  const id = boundedProviderString(value, 200);
  return id && /^[A-Za-z0-9_.:-]+$/.test(id) ? id : undefined;
}
