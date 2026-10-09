import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { checkSharedRateLimit, RateLimitStoreUnavailableError } from "@/lib/http/rate-limit";
import { getOwnedProject } from "@/lib/projects/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { createThread, getOwnedThread } from "@/lib/threads/store";
import {
  voiceConversationCommandContextSchema, voiceConversationFinishRequestSchema,
  voiceConversationStartRequestSchema, voiceConversationStartResponseSchema,
} from "@/lib/voice/conversation-contracts";
import {
  buildConversationVoiceInstructions, conversationVoiceContextMatches,
  conversationVoiceOwnerContext, conversationVoiceStreamId,
  issueConversationVoiceSecret, requireActiveConversationVoiceSession,
  resolveConversationVoiceRuntime,
  VoiceConversationError, VOICE_CONVERSATION_MAX_AGE_MS,
} from "@/lib/voice/conversation-session";
import { REALTIME_TRANSPORT_URL } from "@/lib/voice/realtime-session";

export const runtime = "nodejs";
export const maxDuration = 90;
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
const headers = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request, 64_000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = voiceConversationStartRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "The voice request is invalid." }, { status: 400, headers });
  const input = parsed.data;
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "voice_session",
      nativeMutationCapability: "voice.session.manage", metadata: { operation: "conversation_start" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const owner = conversationVoiceOwnerContext(context);
    const rate = await checkSharedRateLimit({ key: `voice:conversation:${owner.tenantId}:${owner.actorId}`, limit: 12, windowMs: 60_000 });
    if (!rate.allowed) return Response.json({ error: "Please wait briefly before starting voice again.", code: "voice_rate_limited" },
      { status: 429, headers: { ...headers, "retry-after": String(rate.retryAfterSeconds) } });
    if (input.contextSelection || input.contextScope === "explicit_selection" || input.contextScope === "mission") {
      throw new VoiceConversationError("voice_context_needs_selection",
        "For live voice, choose conversation or project context. A reviewed one-task selection cannot be reused for changing spoken requests.", 409);
    }
    const voiceRuntime = await resolveConversationVoiceRuntime(context);
    const model = voiceRuntime.model;
    const commandContext = voiceConversationCommandContextSchema.parse({
      agentId: input.agentId, projectId: input.projectId, mode: input.mode,
      contextScope: input.contextScope, contextReferences: input.contextReferences,
    });
    if (input.projectId && !await getOwnedProject(input.projectId, {
      tenantId: context.tenantId, actorId: context.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
    })) {
      throw new VoiceConversationError("voice_context_changed", "This project is unavailable. Choose an accessible project before starting voice.", 404);
    }
    let conversation = input.conversationId ? await getOwnedThread(input.conversationId, {
      tenantId: context.tenantId, actorId: context.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
    }) : null;
    if (input.conversationId && !conversation) {
      throw new VoiceConversationError("voice_conversation_not_found", "This voice conversation is unavailable.", 404);
    }
    if (conversation && input.projectId && conversation.projectId !== input.projectId) {
      throw new VoiceConversationError("voice_context_changed", "Start a new conversation for a different project.", 409);
    }
    if (!conversation) conversation = await createThread({
      tenantId: context.tenantId, actorId: context.actorId, title: "Voice conversation", mode: input.mode,
      projectId: input.projectId,
    });
    const sessionId = input.reconnectAttempt ? input.sessionId! : randomUUID();
    if (input.reconnectAttempt) {
      const existing = await requireActiveConversationVoiceSession({ context, sessionId, conversationId: conversation.id });
      if (!conversationVoiceContextMatches(existing.commandContext, commandContext)) {
        throw new VoiceConversationError("voice_context_changed", "End voice before changing the selected Agent or context.", 409);
      }
    }
    const prepared = await buildConversationVoiceInstructions({ context, conversationId: conversation.id, commandContext });
    const credential = await voiceRuntime.withApiKey(apiKey => issueConversationVoiceSecret({ model, instructions: prepared.instructions,
      language: input.language, correlationId: `voice:${sessionId}`, apiKey }));
    const expiresAt = new Date(Date.now() + VOICE_CONVERSATION_MAX_AGE_MS).toISOString();
    await appendScopedDomainEvent({
      streamId: conversationVoiceStreamId(owner, sessionId),
      type: input.reconnectAttempt ? "voice.conversation_reconnected" : "voice.conversation_started",
      executionScope: executionScopeFromSecurityContext(owner, {
        correlationId: `voice:${sessionId}`, purpose: "voice.conversation.start", projectId: input.projectId,
      }),
      payload: {
        schemaVersion: 2, sessionId, conversationId: conversation.id, agentName: prepared.agentName,
        model, provider: "openai", credentialSource: voiceRuntime.credentialSource, commandContext,
        expiresAt, language: input.language || "auto", reconnectAttempt: input.reconnectAttempt,
        contextReceiptSha256: prepared.contextReceiptSha256,
        audioRetention: "not_stored_by_asael", transcriptRetention: "conversation_history",
        continuousConsent: true, forceApprovalAboveRisk: 0,
      },
    });
    return Response.json(voiceConversationStartResponseSchema.parse({
      schemaVersion: 2, sessionId, conversationId: conversation.id, ...credential,
      transportUrl: REALTIME_TRANSPORT_URL, provider: "openai", model,
      agentName: prepared.agentName, language: input.language || "auto", voice: "cedar",
      turnDetection: "server_vad", audioRetention: "not_stored_by_asael",
      transcriptRetention: "conversation_history", reconnectAttempt: input.reconnectAttempt,
      expiresAt, commandContext,
    }), { headers });
  } catch (error) { return failureResponse(error); }
}

async function PATCHHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request, 8000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = voiceConversationFinishRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "The voice completion is invalid." }, { status: 400, headers });
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "voice_session",
      nativeMutationCapability: "voice.session.manage", metadata: { operation: "conversation_finish" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const input = parsed.data;
    const active = await requireActiveConversationVoiceSession({ context, sessionId: input.sessionId, conversationId: input.conversationId });
    const owner = { ...context, actorId: active.ownerActorId };
    await appendScopedDomainEvent({
      streamId: conversationVoiceStreamId(owner, input.sessionId), type: `voice.conversation_${input.outcome}`,
      executionScope: executionScopeFromSecurityContext(owner, { correlationId: `voice:${input.sessionId}`, purpose: "voice.conversation.finish" }),
      payload: { ...input, observedBy: "client", audioRetention: "not_stored_by_asael", transcriptRetention: "conversation_history" },
    });
    return Response.json({ recorded: true }, { headers });
  } catch (error) { return failureResponse(error); }
}

function failureResponse(error: unknown) {
  if (error instanceof VoiceConversationError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  if (error instanceof RateLimitStoreUnavailableError) {
    return Response.json({ error: "Voice is temporarily unavailable. Try again shortly.", code: "voice_admission_unavailable" }, { status: 503, headers });
  }
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  const timeout = error instanceof OpenAI.APIConnectionTimeoutError;
  const code = timeout ? "voice_provider_timeout" : status === 429 ? "voice_provider_limit" :
    status === 401 || status === 403 ? "voice_provider_credential_rejected" :
    status === 400 || status === 404 || status === 422 ? "voice_provider_request_rejected" : "voice_connection_unavailable";
  console.error("Conversational voice setup failed.", { code, providerStatus: status });
  return Response.json({
    code,
    error: timeout ? "Voice took too long to connect. Please try again." :
      status === 429 ? "Voice has reached its current provider limit. Please try again shortly." :
      "Voice could not connect. Please try again; your conversation is saved.",
  }, { status: timeout ? 504 : status === 429 ? 429 : 503, headers });
}
