import { createHash } from "node:crypto";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { checkSharedRateLimit, RateLimitStoreUnavailableError } from "@/lib/http/rate-limit";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { appendThreadTurn, getOwnedThread } from "@/lib/threads/store";
import { requireActiveConversationVoiceSession, VoiceConversationError } from "@/lib/voice/conversation-session";
import { conversationVoiceTurnsRequestSchema } from "@/lib/voice/conversation-transcript";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const headers = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 64_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = conversationVoiceTurnsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "These voice captions could not be saved." }, { status: 400, headers });
  }
  const input = parsed.data;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "voice_session",
      resourceId: input.sessionId,
      metadata: { operation: "save_conversation_captions" },
      nativeMutationCapability: "voice.session.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const rate = await checkSharedRateLimit({
      key: `voice:captions:${context.tenantId}:${context.actorId}`,
      limit: 240,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      return Response.json({ error: "Voice history is saving too quickly. Try again shortly." }, {
        status: 429,
        headers: { ...headers, "retry-after": String(rate.retryAfterSeconds) },
      });
    }
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) throw error;
    return Response.json({ error: "Voice history is temporarily unavailable." }, { status: 503, headers });
  }

  const thread = await getOwnedThread(input.conversationId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json({ error: "This voice conversation is unavailable." }, { status: 404, headers });
  }
  let active;
  try {
    active = await requireActiveConversationVoiceSession({ context, sessionId: input.sessionId, conversationId: input.conversationId });
  } catch (error) {
    return Response.json({ error: "This voice session is unavailable for saving captions." }, {
      status: error instanceof VoiceConversationError ? error.status : 503, headers,
    });
  }

  const owner = { ...context, actorId: active.ownerActorId };
  const turnIds: string[] = [];
  for (const caption of input.turns) {
    const identity = JSON.stringify([owner.tenantId, owner.actorId, input.sessionId, caption.role, caption.itemId]);
    const id = stableId("asael.voice.caption.v2", identity);
    // The client may observe generated captions before all audio plays. It
    // must omit the unheard tail, or submit only an interruption marker.
    const content = caption.interrupted && caption.role === "assistant"
      ? caption.text === "[Reply interrupted]" ? "Reply interrupted." : `${caption.text}\n\n[Reply interrupted]`
      : caption.text;
    try {
      await appendThreadTurn({ id, tenantId: context.tenantId, threadId: thread.id, role: caption.role, content });
      await appendScopedDomainEvent({
        id: stableId("asael.voice.caption.event.v2", identity),
        streamId: `thread:${thread.id}`,
        type: "voice.conversation_turn_saved",
        executionScope: executionScopeFromSecurityContext(owner, {
          projectId: thread.projectId,
          correlationId: `voice:${input.sessionId}`,
          causationId: id,
          purpose: "voice.conversation.caption",
        }),
        payload: {
          schemaVersion: 2,
          conversationId: thread.id,
          voiceSessionId: input.sessionId,
          turnId: id,
          role: caption.role,
          provenance: "client_observed_caption",
          providerVerified: false,
          interrupted: caption.interrupted,
          transcriptCharacters: content.length,
          transcriptSha256: createHash("sha256").update(content).digest("hex"),
        },
      });
      turnIds.push(id);
    } catch {
      // No raw captions, provider content, or credentials enter error logs.
      // Stable IDs permit retry after a partially persisted batch.
      return Response.json({ error: "Some voice captions could not be saved. The live conversation can continue." }, { status: 503, headers });
    }
  }
  return Response.json({ recorded: true, turnIds }, { headers });
}

function stableId(domain: string, identity: string) {
  const hex = createHash("sha256").update(`${domain}\0${identity}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
