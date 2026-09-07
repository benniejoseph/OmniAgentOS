import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { createThread, getOwnedThread } from "@/lib/threads/store";
import {
  issueRealtimeTranscriptionSecret,
  REALTIME_AUDIO_RETENTION,
  REALTIME_TRANSCRIPT_RETENTION,
  REALTIME_TRANSPORT_URL,
} from "@/lib/voice/realtime-session";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const languageSchema = z.string().trim().toLowerCase().regex(/^[a-z]{2}$/);
const sessionSchema = z.object({
  sessionId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).default("orchestrate"),
  language: languageSchema.optional(),
  providerConsent: z.literal(true),
  audioRetention: z.literal(REALTIME_AUDIO_RETENTION),
  reconnectAttempt: z.number().int().min(0).max(3).default(0),
}).strict().superRefine((value, context) => {
  if (value.reconnectAttempt > 0 && (!value.sessionId || !value.conversationId)) {
    context.addIssue({
      code: "custom",
      message: "Reconnects require the existing session and conversation.",
      path: ["sessionId"],
    });
  }
});

const completionSchema = z.object({
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  outcome: z.enum(["sent", "canceled", "failed"]),
  durationMilliseconds: z.number().int().min(0).max(10 * 60 * 1_000),
  turnCount: z.number().int().min(0).max(1_000),
  reconnectCount: z.number().int().min(0).max(3),
  transcriptCharacters: z.number().int().min(0).max(100_000),
  confidenceBand: z.enum(["high", "low", "unavailable", "edited"]),
  confidenceMean: z.number().min(0).max(1).optional(),
  confidenceMinimum: z.number().min(0).max(1).optional(),
  confidenceSampleCount: z.number().int().min(0).max(10_000),
  reviewRequired: z.boolean(),
  reviewAttested: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "sent" && !value.reviewAttested) {
    context.addIssue({
      code: "custom",
      message: "Sent voice commands require a review attestation.",
      path: ["reviewAttested"],
    });
  }
  if (
    value.confidenceBand === "high" &&
    (value.confidenceMean === undefined ||
      value.confidenceMinimum === undefined ||
      value.confidenceSampleCount < 1)
  ) {
    context.addIssue({
      code: "custom",
      message: "High-confidence completion metadata is incomplete.",
      path: ["confidenceBand"],
    });
  }
});

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  const parsed = await parseRequest(request, sessionSchema);
  if (parsed instanceof Response) return parsed;

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "voice_session",
      metadata: {
        operation: parsed.reconnectAttempt ? "reconnect" : "start",
        provider: "openai",
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const limited = await enforceRateLimit(context.tenantId, context.actorId);
  if (limited) return limited;

  const requestActorBinding =
    canonicalRequestActorBindingFromSecurityContext(context);
  let conversation = parsed.conversationId
    ? await getOwnedThread(parsed.conversationId, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding,
      })
    : null;
  if (parsed.conversationId && !conversation) {
    return Response.json(
      { error: "The voice conversation was not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  if (!conversation) {
    conversation = await createThread({
      tenantId: context.tenantId,
      actorId: context.actorId,
      title: "Voice conversation",
      mode: parsed.mode,
    });
  }

  const sessionId = parsed.reconnectAttempt
    ? parsed.sessionId!
    : randomUUID();
  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId: `voice:${sessionId}`,
    purpose: parsed.reconnectAttempt
      ? "voice.realtime.reconnect"
      : "voice.realtime.start",
  });

  try {
    const credential = await issueRealtimeTranscriptionSecret({
      language: parsed.language,
    });
    await appendScopedDomainEvent({
      streamId: scopedVoiceStreamId(
        context.tenantId,
        context.actorId,
        sessionId,
      ),
      type: parsed.reconnectAttempt
        ? "voice.realtime_reconnected"
        : "voice.realtime_started",
      executionScope,
      payload: {
        schemaVersion: 1,
        conversationId: conversation.id,
        provider: "openai",
        model: credential.model,
        language: parsed.language || "auto",
        turnDetection: "server_vad",
        audioRetention: REALTIME_AUDIO_RETENTION,
        transcriptRetention: REALTIME_TRANSCRIPT_RETENTION,
        reconnectAttempt: parsed.reconnectAttempt,
        credentialExpiresAt: credential.clientSecretExpiresAt,
      },
    });

    return Response.json({
      schemaVersion: 1,
      sessionId,
      conversationId: conversation.id,
      clientSecret: credential.clientSecret,
      clientSecretExpiresAt: credential.clientSecretExpiresAt,
      transportUrl: REALTIME_TRANSPORT_URL,
      provider: "openai",
      model: credential.model,
      language: parsed.language || "auto",
      turnDetection: "server_vad",
      audioRetention: REALTIME_AUDIO_RETENTION,
      transcriptRetention: REALTIME_TRANSCRIPT_RETENTION,
      reconnectAttempt: parsed.reconnectAttempt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Realtime voice session creation failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Realtime voice is temporarily unavailable." },
      { status: 502, headers: privateNoStoreHeaders },
    );
  }
}

async function PATCHHandler(request: Request) {
  const parsed = await parseRequest(request, completionSchema);
  if (parsed instanceof Response) return parsed;

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "voice_session",
      resourceId: parsed.sessionId,
      metadata: { operation: "finish", outcome: parsed.outcome },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const conversation = await getOwnedThread(parsed.conversationId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding:
      canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!conversation) {
    return Response.json(
      { error: "The voice conversation was not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }

  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId: `voice:${parsed.sessionId}`,
    purpose: "voice.realtime.finish",
  });
  await appendScopedDomainEvent({
    streamId: scopedVoiceStreamId(
      context.tenantId,
      context.actorId,
      parsed.sessionId,
    ),
    type: `voice.realtime_${parsed.outcome}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      conversationId: conversation.id,
      provider: "openai",
      audioRetention: REALTIME_AUDIO_RETENTION,
      durationMilliseconds: parsed.durationMilliseconds,
      turnCount: parsed.turnCount,
      reconnectCount: parsed.reconnectCount,
      transcriptCharacters: parsed.transcriptCharacters,
      confidenceBand: parsed.confidenceBand,
      confidenceMean: parsed.confidenceMean ?? null,
      confidenceMinimum: parsed.confidenceMinimum ?? null,
      confidenceSampleCount: parsed.confidenceSampleCount,
      reviewRequired: parsed.reviewRequired,
      reviewAttested: parsed.reviewAttested,
    },
  });
  return Response.json({ recorded: true }, { headers: privateNoStoreHeaders });
}

async function parseRequest<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
): Promise<z.output<TSchema> | Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid realtime voice request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  return parsed.data;
}

async function enforceRateLimit(tenantId: string, actorId: string) {
  try {
    const rate = await checkSharedRateLimit({
      key: `voice:realtime:${tenantId}:${actorId}`,
      limit: 12,
      windowMs: 60_000,
    });
    if (rate.allowed) return undefined;
    return Response.json(
      { error: "Too many realtime voice sessions. Try again shortly." },
      {
        status: 429,
        headers: {
          ...privateNoStoreHeaders,
          "retry-after": String(rate.retryAfterSeconds),
        },
      },
    );
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) throw error;
    return Response.json(
      { error: "Realtime voice is temporarily unavailable." },
      {
        status: 503,
        headers: { ...privateNoStoreHeaders, "retry-after": "30" },
      },
    );
  }
}

function scopedVoiceStreamId(
  tenantId: string,
  actorId: string,
  sessionId: string,
) {
  const ownerScope = createHash("sha256")
    .update(`${tenantId}\0${actorId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `voice:${ownerScope}:${sessionId}`;
}
