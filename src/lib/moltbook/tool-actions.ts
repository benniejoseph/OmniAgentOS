import "server-only";

import type { SecurityContext } from "@/lib/security/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import {
  isMoltbookToolId,
  parseMoltbookToolInput,
  type MoltbookRateLimitProjection,
  type MoltbookToolId,
} from "@/lib/moltbook/contracts";
import {
  createMoltbookClient,
  moltbookMutationRequestSha256,
  MoltbookProviderError,
  type MoltbookHttpResult,
} from "@/lib/moltbook/http-client";
import {
  appendMoltbookToolActivity,
  MoltbookConnectionError,
  observeMoltbookRateLimit,
  readMoltbookEffectEvidence,
  resolveMoltbookPrincipalAuthority,
  resolveMoltbookConnectionForReceipt,
  resolveMoltbookConnectionForTool,
  type MoltbookConnectionAccess,
  type MoltbookEffectEvidence,
} from "@/lib/moltbook/store";
import {
  moltbookConnectionIdentityPinFromRunPin,
} from "@/lib/moltbook/identity-boundary";
import {
  getAgentRunExecutionScope,
  getAgentRunIdentityPin,
} from "@/lib/runs/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { toolInputSha256 as canonicalToolInputSha256 } from "@/lib/tools/execution-scope";

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
  verification?: Readonly<{
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

export type MoltbookEffectCommit = Readonly<{
  version: "moltbook.effect-commit.v1";
  providerAcknowledgement:
    | "provider_response"
    | "provider_idempotency_reconciliation";
  providerAcknowledgementId: string;
  providerAcknowledgementSha256: string;
  toolExecutionId: string;
  toolId: MoltbookToolId;
  toolInputSha256: string;
  effectTargetId: string;
  requestSha256: string;
  responseSha256: string;
  status: "succeeded" | "published" | "pending_verification";
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
}>;

export type MoltbookReconciliationResult =
  | Readonly<{
      kind: "completed";
      result: MoltbookMutationResult | MoltbookPendingVerificationResult;
    }>
  | Readonly<{
      kind: "held";
      status: "failed" | "uncertain" | "pending_verification";
      errorCode?: string;
    }>;

type MoltbookToolActionInput = Readonly<{
  toolId: MoltbookToolId;
  toolInput: unknown;
  context: SecurityContext;
  executionScope: ExecutionScope;
  toolExecutionId: string;
  agentRunId?: string;
  effectTargetId?: string;
  toolInputSha256?: string;
  abortSignal?: AbortSignal;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}>;

type MoltbookEffectBinding = Readonly<{
  toolInputSha256: string;
  effectTargetId: string;
  requestSha256: string;
}>;

const MOLTBOOK_EFFECT_COMMIT = Symbol("asael.moltbook.effect-commit.v1");

class RecordedMoltbookEffectError extends MoltbookConnectionError {}

export async function executeMoltbookToolAction(
  input: MoltbookToolActionInput,
): Promise<MoltbookToolActionResult> {
  if (!isMoltbookToolId(input.toolId)) {
    throw new MoltbookConnectionError("Unknown Moltbook tool action.", {
      status: 400,
      code: "tool_unknown",
    });
  }
  const authority = await exactToolAuthority(input);
  const toolInput = parseMoltbookToolInput(input.toolId, input.toolInput);
  const binding = isReadTool(input.toolId)
    ? undefined
    : exactEffectBinding(input, toolInput);
  const access = await resolveMoltbookConnectionForTool({
    tenantId: input.executionScope.tenantId,
    ownerActorId: authority.ownerActorId,
    executingAgentId: authority.executingAgentId,
    identityPin: authority.identityPin,
  });
  const client = createMoltbookClient({
    apiKey: access.apiKey,
    abortSignal: input.abortSignal,
  });

  if (isReadTool(input.toolId)) {
    return executeRead(input, toolInput, access, client);
  }
  if (!binding) {
    throw new MoltbookConnectionError("Moltbook mutation binding is unavailable.", {
      code: "effect_binding_missing",
    });
  }
  return executeMutation(input, toolInput, binding, access, client);
}

/**
 * Reconciles one already-attempted mutation exclusively from Asael's durable
 * actor-private receipt. This path never opens the provider credential and
 * therefore cannot repeat the public operation.
 */
export async function reconcileMoltbookToolAction(
  input: MoltbookToolActionInput,
): Promise<MoltbookReconciliationResult | undefined> {
  if (!isMoltbookToolId(input.toolId) || isReadTool(input.toolId)) return undefined;
  const toolInput = parseMoltbookToolInput(input.toolId, input.toolInput);
  const binding = exactEffectBinding(input, toolInput);
  const authority = await exactToolAuthority(input);
  const access = await resolveMoltbookConnectionForReceipt({
    tenantId: input.executionScope.tenantId,
    ownerActorId: authority.ownerActorId,
    executingAgentId: authority.executingAgentId,
    identityPin: authority.identityPin,
  });
  const evidence = await readMoltbookEffectEvidence({
    access,
    toolId: input.toolId,
    toolExecutionId: input.toolExecutionId,
    toolInputSha256: binding.toolInputSha256,
    effectTargetId: binding.effectTargetId,
    requestSha256: binding.requestSha256,
  });
  if (!evidence) return undefined;
  if (
    evidence.status === "failed" ||
    evidence.status === "uncertain" ||
    evidence.status === "pending_verification"
  ) {
    return {
      kind: "held",
      status: evidence.status,
      ...(evidence.errorCode ? { errorCode: evidence.errorCode } : {}),
    };
  }
  if (!evidence.responseSha256) {
    throw new MoltbookConnectionError(
      "Moltbook effect evidence is missing its provider response digest.",
      { code: "effect_receipt_invalid" },
    );
  }
  const providerObject = publicProviderObject(input.toolId, evidence.providerObject);
  const result: MoltbookMutationResult = {
    status: evidence.status,
    ...(providerObject ? { providerObject } : {}),
  };
  return {
    kind: "completed",
    result: withEffectCommit(result, effectCommit({
      acknowledgement: "provider_idempotency_reconciliation",
      input,
      binding,
      result: {
        requestSha256: evidence.requestSha256,
        responseSha256: evidence.responseSha256,
      },
      status: evidence.status,
      providerObject: evidence.providerObject,
    })),
  };
}

export function moltbookEffectCommitFromResult(
  value: unknown,
): MoltbookEffectCommit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const commit = (value as { [MOLTBOOK_EFFECT_COMMIT]?: unknown })[
    MOLTBOOK_EFFECT_COMMIT
  ];
  if (!commit || typeof commit !== "object" || Array.isArray(commit)) return undefined;
  const candidate = commit as MoltbookEffectCommit;
  if (
    candidate.version !== "moltbook.effect-commit.v1" ||
    !isMoltbookToolId(candidate.toolId) ||
    isReadTool(candidate.toolId) ||
    !["provider_response", "provider_idempotency_reconciliation"].includes(
      candidate.providerAcknowledgement,
    ) ||
    !["succeeded", "published", "pending_verification"].includes(candidate.status) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(candidate.effectTargetId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(candidate.toolExecutionId) ||
    !isDigest(candidate.toolInputSha256) ||
    !isDigest(candidate.requestSha256) ||
    !isDigest(candidate.responseSha256) ||
    !isDigest(candidate.providerAcknowledgementSha256) ||
    candidate.providerAcknowledgementId !==
      `moltbook_ack_${candidate.providerAcknowledgementSha256.slice(0, 50)}` ||
    candidate.providerAcknowledgementSha256 !== commitSha256(candidate) ||
    !isCommitProviderObject(candidate.providerObject)
  ) return undefined;
  return candidate;
}

export function moltbookPublicToolResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>));
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
  binding: MoltbookEffectBinding,
  access: MoltbookConnectionAccess,
  client: ReturnType<typeof createMoltbookClient>,
): Promise<MoltbookMutationResult | MoltbookPendingVerificationResult> {
  const publicAccess = withoutApiKey(access);
  let providerResult: MoltbookHttpResult | undefined;
  try {
    const result = await callMutation(input.toolId, toolInput, client);
    providerResult = result;
    if (result.requestSha256 !== binding.requestSha256) {
      throw new MoltbookConnectionError(
        "Moltbook response evidence does not match the exact requested mutation.",
        { code: "effect_request_digest_mismatch" },
      );
    }
    if (input.toolId === "moltbook.verify") {
      const settled = await settleVerification(
        input,
        toolInput,
        binding,
        publicAccess,
        result,
      );
      await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
      return settled;
    }
    const providerObject = providerObjectFromResponse(input.toolId, result.data);
    const targetObject = targetObjectFromInput(input.toolId, toolInput);
    const activityObject = providerObject || targetObject;
    await assertSuccessfulProviderEffect({
      input,
      binding,
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
        toolId: input.toolId,
        toolInputSha256: binding.toolInputSha256,
        effectTargetId: binding.effectTargetId,
        effect: true,
      });
      await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
      return withEffectCommit({
        source: "moltbook",
        untrusted: true,
        status: "pending_verification",
        providerObject,
        verification,
      }, effectCommit({
        acknowledgement: "provider_response",
        input,
        binding,
        result,
        status: "pending_verification",
        providerObject: activityObject,
      }));
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
      toolId: input.toolId,
      toolInputSha256: binding.toolInputSha256,
      effectTargetId: binding.effectTargetId,
      effect: true,
    });
    await observeRateLimitAfterEffect(publicAccess, result.rateLimit);
    return withEffectCommit(
      { status, providerObject },
      effectCommit({
        acknowledgement: "provider_response",
        input,
        binding,
        result,
        status,
        providerObject: activityObject,
      }),
    );
  } catch (error) {
    if (error instanceof RecordedMoltbookEffectError) throw error;
    if (providerResult) {
      await recordProviderResultUncertainty(
        input,
        binding,
        publicAccess,
        providerResult,
      );
      throw error;
    }
    await recordToolFailure(input, publicAccess, error, true, binding);
    throw error;
  }
}

async function recordProviderResultUncertainty(
  input: MoltbookToolActionInput,
  binding: MoltbookEffectBinding,
  access: Omit<MoltbookConnectionAccess, "apiKey">,
  result: MoltbookHttpResult,
) {
  await appendMoltbookToolActivity({
    access,
    kind: toolKind(input.toolId),
    status: "uncertain",
    summary: "Moltbook returned a response, but its durable public-effect evidence could not be finalized. It will not be retried.",
    toolExecutionId: input.toolExecutionId,
    agentRunId: input.agentRunId,
    requestSha256: result.requestSha256,
    responseSha256: result.responseSha256,
    errorCode: "provider_effect_evidence_unavailable",
    toolId: input.toolId,
    toolInputSha256: binding.toolInputSha256,
    effectTargetId: binding.effectTargetId,
    effect: true,
  });
  await observeRateLimitAfterEffect(access, result.rateLimit);
}

async function settleVerification(
  input: Parameters<typeof executeMoltbookToolAction>[0],
  toolInput: Record<string, unknown>,
  binding: MoltbookEffectBinding,
  access: Omit<MoltbookConnectionAccess, "apiKey">,
  result: MoltbookHttpResult,
): Promise<MoltbookMutationResult> {
  const record = providerRecord(result.data);
  const providerObject = verificationProviderObject(record) ||
    targetObjectFromInput(input.toolId, toolInput);
  if (record.success !== true) {
    const explicitRejection = record.success === false;
    await appendMoltbookToolActivity({
      access,
      kind: "verification",
      status: explicitRejection ? "failed" : "uncertain",
      summary: explicitRejection
        ? "Moltbook did not accept the verification answer."
        : "Moltbook returned an incomplete verification acknowledgement; the public outcome is uncertain.",
      providerObjectType: providerObject?.type,
      providerObjectRef: providerObject?.ref,
      providerObjectUrl: providerObject?.url,
      toolExecutionId: input.toolExecutionId,
      agentRunId: input.agentRunId,
      requestSha256: result.requestSha256,
      responseSha256: result.responseSha256,
      errorCode: explicitRejection
        ? "verification_failed"
        : "verification_outcome_uncertain",
      toolId: input.toolId,
      toolInputSha256: binding.toolInputSha256,
      effectTargetId: binding.effectTargetId,
      effect: true,
    });
    await observeRateLimitAfterEffect(access, result.rateLimit);
    throw new RecordedMoltbookEffectError(
      explicitRejection
        ? "Moltbook did not accept the verification answer."
        : "Moltbook did not return enough evidence to determine the verification outcome.",
      {
        code: explicitRejection
          ? "verification_failed"
          : "verification_outcome_uncertain",
      },
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
    toolId: input.toolId,
    toolInputSha256: binding.toolInputSha256,
    effectTargetId: binding.effectTargetId,
    effect: true,
  });
  return withEffectCommit(
    { status: "published", providerObject },
    effectCommit({
      acknowledgement: "provider_response",
      input,
      binding,
      result,
      status: "published",
      providerObject,
    }),
  );
}

async function assertSuccessfulProviderEffect(input: {
  input: Parameters<typeof executeMoltbookToolAction>[0];
  binding: MoltbookEffectBinding;
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  result: MoltbookHttpResult;
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
  identityRequired: boolean;
}) {
  const record = providerRecord(input.result.data);
  const errorCode = record.success === false
    ? "provider_effect_rejected"
    : record.success !== true
      ? "provider_effect_outcome_uncertain"
      : input.identityRequired && !input.providerObject
        ? "provider_effect_identity_missing"
        : undefined;
  if (!errorCode) return;
  const definitive = errorCode === "provider_effect_rejected";
  await appendMoltbookToolActivity({
    access: input.access,
    kind: toolKind(input.input.toolId),
    status: definitive ? "failed" : "uncertain",
    summary: definitive
      ? "Moltbook did not confirm the requested public change."
      : errorCode === "provider_effect_identity_missing"
        ? "Moltbook acknowledged the request without a valid public object identity; the public outcome is uncertain."
        : "Moltbook returned an incomplete mutation acknowledgement; the public outcome is uncertain.",
    providerObjectType: input.providerObject?.type,
    providerObjectRef: input.providerObject?.ref,
    providerObjectUrl: input.providerObject?.url,
    toolExecutionId: input.input.toolExecutionId,
    agentRunId: input.input.agentRunId,
    requestSha256: input.result.requestSha256,
    responseSha256: input.result.responseSha256,
    errorCode,
    toolId: input.input.toolId,
    toolInputSha256: input.binding.toolInputSha256,
    effectTargetId: input.binding.effectTargetId,
    effect: true,
  });
  await observeRateLimitAfterEffect(input.access, input.result.rateLimit);
  throw new RecordedMoltbookEffectError(
    definitive
      ? "Moltbook did not confirm the requested public change."
      : "Moltbook did not return enough evidence to determine the public outcome.",
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
  binding?: MoltbookEffectBinding,
) {
  const provider = error instanceof MoltbookProviderError ? error : undefined;
  const code = provider?.code ||
    (error instanceof MoltbookConnectionError ? error.code : "tool_failed");
  const uncertain = effect && Boolean(provider?.requestSha256) &&
    isAmbiguousProviderMutationFailure(provider);
  const activity = appendMoltbookToolActivity({
    access,
    kind: toolKind(input.toolId),
    status: uncertain ? "uncertain" : "failed",
    summary: effect
      ? uncertain
        ? "Moltbook received the request, but the public outcome is uncertain. It will not be retried."
        : "Moltbook definitively rejected the mutation. It was not retried."
      : "The Moltbook read did not complete.",
    toolExecutionId: input.toolExecutionId,
    agentRunId: input.agentRunId,
    requestSha256: provider?.requestSha256 || binding?.requestSha256,
    responseSha256: provider?.responseSha256,
    errorCode: code,
    effect: effect && Boolean(provider?.requestSha256) && Boolean(binding),
    ...(binding
      ? {
          toolId: input.toolId,
          toolInputSha256: binding.toolInputSha256,
          effectTargetId: binding.effectTargetId,
        }
      : {}),
  });
  if (effect && provider?.requestSha256 && binding) {
    // The provider outcome is persisted before auxiliary health metadata. A
    // receipt failure must leave the governed execution held as uncertain.
    await activity;
  } else {
    await activity.catch(() => undefined);
  }
  if (provider?.rateLimit) {
    await observeMoltbookRateLimit({ access, rateLimit: provider.rateLimit })
      .catch(() => undefined);
  }
}

function isAmbiguousProviderMutationFailure(
  error: MoltbookProviderError | undefined,
) {
  if (!error) return false;
  if (error.statusCode === undefined || error.statusCode >= 500) return true;
  return [
    "provider_timeout",
    "provider_unavailable",
    "provider_response_too_large",
    "provider_response_unavailable",
    "provider_response_invalid",
  ].includes(error.code);
}

function exactEffectBinding(
  input: MoltbookToolActionInput,
  toolInput: Record<string, unknown>,
): MoltbookEffectBinding {
  const actualInputSha256 = canonicalToolInputSha256(toolInput);
  if (
    input.toolInputSha256 !== actualInputSha256 ||
    !input.effectTargetId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(input.effectTargetId)
  ) {
    throw new MoltbookConnectionError(
      "Moltbook mutation authority is not bound to the exact governed input and target.",
      { code: "effect_binding_mismatch" },
    );
  }
  return Object.freeze({
    toolInputSha256: actualInputSha256,
    effectTargetId: input.effectTargetId,
    requestSha256: moltbookMutationRequestSha256(input.toolId, toolInput),
  });
}

function effectCommit(input: {
  acknowledgement: MoltbookEffectCommit["providerAcknowledgement"];
  input: MoltbookToolActionInput;
  binding: MoltbookEffectBinding;
  result: Pick<MoltbookHttpResult, "requestSha256" | "responseSha256">;
  status: MoltbookEffectCommit["status"];
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
}): MoltbookEffectCommit {
  const material = {
    version: "moltbook.effect-commit.v1" as const,
    providerAcknowledgement: input.acknowledgement,
    toolExecutionId: input.input.toolExecutionId,
    toolId: input.input.toolId,
    toolInputSha256: input.binding.toolInputSha256,
    effectTargetId: input.binding.effectTargetId,
    requestSha256: input.result.requestSha256,
    responseSha256: input.result.responseSha256,
    status: input.status,
    ...(input.providerObject ? { providerObject: input.providerObject } : {}),
  };
  const providerAcknowledgementSha256 = canonicalJsonSha256(material);
  return Object.freeze({
    ...material,
    providerAcknowledgementId:
      `moltbook_ack_${providerAcknowledgementSha256.slice(0, 50)}`,
    providerAcknowledgementSha256,
  });
}

function commitSha256(commit: MoltbookEffectCommit) {
  return canonicalJsonSha256({
    version: commit.version,
    providerAcknowledgement: commit.providerAcknowledgement,
    toolExecutionId: commit.toolExecutionId,
    toolId: commit.toolId,
    toolInputSha256: commit.toolInputSha256,
    effectTargetId: commit.effectTargetId,
    requestSha256: commit.requestSha256,
    responseSha256: commit.responseSha256,
    status: commit.status,
    ...(commit.providerObject ? { providerObject: commit.providerObject } : {}),
  });
}

function withEffectCommit<T extends object>(
  result: T,
  commit: MoltbookEffectCommit,
) {
  Object.defineProperty(result, MOLTBOOK_EFFECT_COMMIT, {
    value: commit,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function publicProviderObject(
  toolId: MoltbookToolId,
  providerObject: MoltbookEffectEvidence["providerObject"],
) {
  return toolId === "moltbook.post.create" ||
      toolId === "moltbook.comment.create" ||
      toolId === "moltbook.verify"
    ? providerObject
    : undefined;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCommitProviderObject(
  value: MoltbookEffectCommit["providerObject"],
) {
  if (value === undefined) return true;
  return /^[a-z0-9_.:-]{1,80}$/.test(value.type) &&
    /^[A-Za-z0-9_.:-]{1,240}$/.test(value.ref) &&
    (value.url === undefined || value.url.startsWith("https://www.moltbook.com/"));
}

async function exactToolAuthority(
  input: Parameters<typeof executeMoltbookToolAction>[0],
) {
  const scope = input.executionScope;
  const liveActorBinding = canonicalRequestActorBindingFromSecurityContext(
    input.context,
  );
  const actorBinding = input.requestActorBinding || liveActorBinding;
  if (
    input.context.tenantId !== scope.tenantId ||
    !actorBinding ||
    !isExactCanonicalActorBinding(actorBinding, input.context.actorId) ||
    (liveActorBinding && !sameCanonicalActorBinding(
      liveActorBinding,
      actorBinding,
    )) ||
    !scope.initiatingActorId ||
    input.context.actorId !== scope.initiatingActorId ||
    scope.executingPrincipalType !== "agent" ||
    !scope.executingPrincipalId ||
    !input.toolExecutionId.trim() ||
    input.toolExecutionId.length > 240 ||
    !input.agentRunId ||
    !input.agentRunId.trim() ||
    input.agentRunId.length > 240
  ) {
    throw new MoltbookConnectionError(
      "Moltbook tool authority does not match the exact owner and Agent scope.",
      { code: "tool_authority_mismatch" },
    );
  }
  const runPin = await getAgentRunIdentityPin(input.agentRunId, {
    tenantId: scope.tenantId,
  });
  const runScope = await getAgentRunExecutionScope(input.agentRunId, {
    tenantId: scope.tenantId,
  });
  if (
    !runPin ||
    runPin.runId !== input.agentRunId ||
    runPin.tenantId !== scope.tenantId ||
    runPin.actorId !== actorBinding.canonicalActorId ||
    runPin.principalId !== scope.executingPrincipalId ||
    !runScope ||
    !toolScopeMatchesRunScope(scope, runScope) ||
    scope.contextGrantIds.length !== 0 ||
    scope.capabilityGrantIds.length !== 0 ||
    runScope.contextGrantIds.length !== 0 ||
    runScope.capabilityGrantIds.length !== 0
  ) {
    throw new MoltbookConnectionError(
      "Moltbook tool authority is not pinned to the active Agent identity.",
      { code: "tool_identity_pin_mismatch" },
    );
  }
  const principal = await resolveMoltbookPrincipalAuthority({
    tenantId: scope.tenantId,
    principalId: runPin.principalId,
    principalGeneration: runPin.principalGeneration,
    authUserId: actorBinding.authUserId,
    canonicalActorId: actorBinding.canonicalActorId,
    readableOwnerActorIds: actorBinding.readableOwnerActorIds,
  });
  if (
    runPin.logicalAgentId !== principal.logicalAgentId ||
    runPin.principalId !== principal.principalId ||
    runPin.principalGeneration !== principal.principalGeneration
  ) {
    throw new MoltbookConnectionError(
      "Moltbook tool authority is not pinned to the active Agent identity.",
      { code: "tool_identity_pin_mismatch" },
    );
  }
  const identityPin = moltbookConnectionIdentityPinFromRunPin(runPin);
  return {
    ownerActorId: principal.owner.actorId,
    executingAgentId: principal.logicalAgentId,
    identityPin,
  };
}

function isExactCanonicalActorBinding(
  binding: CanonicalRequestActorBindingV1,
  actorId: string,
) {
  return binding.version === 1 &&
    binding.kind === "auth_user" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      binding.authUserId,
    ) &&
    binding.canonicalActorId === `actor:${binding.authUserId}` &&
    binding.legacyOwnerActorIds.length === 1 &&
    binding.legacyOwnerActorIds[0] === actorId &&
    binding.readableOwnerActorIds.length === 2 &&
    binding.readableOwnerActorIds[0] === binding.canonicalActorId &&
    binding.readableOwnerActorIds[1] === actorId;
}

function sameCanonicalActorBinding(
  left: CanonicalRequestActorBindingV1,
  right: CanonicalRequestActorBindingV1,
) {
  return left.authUserId === right.authUserId &&
    left.canonicalActorId === right.canonicalActorId &&
    left.legacyOwnerActorIds.length === right.legacyOwnerActorIds.length &&
    left.legacyOwnerActorIds.every((value, index) =>
      value === right.legacyOwnerActorIds[index]
    ) &&
    left.readableOwnerActorIds.length === right.readableOwnerActorIds.length &&
    left.readableOwnerActorIds.every((value, index) =>
      value === right.readableOwnerActorIds[index]
    );
}

function toolScopeMatchesRunScope(
  toolScope: ExecutionScope,
  runScope: ExecutionScope,
) {
  return toolScope.tenantId === runScope.tenantId &&
    toolScope.initiatingActorId === runScope.initiatingActorId &&
    toolScope.executingPrincipalType === runScope.executingPrincipalType &&
    toolScope.executingPrincipalId === runScope.executingPrincipalId &&
    toolScope.workspaceId === runScope.workspaceId &&
    toolScope.projectId === runScope.projectId &&
    toolScope.missionId === runScope.missionId &&
    toolScope.delegationId === runScope.delegationId &&
    toolScope.correlationId === runScope.correlationId &&
    sameStrings(toolScope.contextGrantIds, runScope.contextGrantIds) &&
    sameStrings(toolScope.capabilityGrantIds, runScope.capabilityGrantIds);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
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
