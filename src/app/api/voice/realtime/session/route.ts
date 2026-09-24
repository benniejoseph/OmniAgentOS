import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { REALTIME_TRANSCRIPTION_MODEL, hasOpenAIKey } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  nativeRealtimeVoiceSessionFinishRequestSchema,
  nativeRealtimeVoiceSessionStartRequestSchema,
} from "@/lib/mobile/contracts";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  resolveSpecializedRuntime,
  type SpecializedRuntimeResolution,
} from "@/lib/settings/specialized-runtime";
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

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  const parsed = await parseRequest(
    request,
    nativeRealtimeVoiceSessionStartRequestSchema,
  );
  if (parsed instanceof Response) return parsed;

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "voice_session",
      metadata: {
        operation: parsed.reconnectAttempt ? "reconnect" : "start",
      },
      nativeMutationCapability: "voice.session.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const limited = await enforceRateLimit(context.tenantId, context.actorId);
  if (limited) return limited;

  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: context.tenantId,
    actorId: context.actorId,
    scope: "realtime_transcription",
    requiredCapability: "transcription",
    deploymentProvider: "openai",
    deploymentModel: REALTIME_TRANSCRIPTION_MODEL,
    deploymentConfigured: hasOpenAIKey(),
  });
  if (!runtimeModel.configured || runtimeModel.provider !== "openai") {
    const failure = realtimeConfigurationFailure(runtimeModel);
    return Response.json(
      failure,
      { status: 503, headers: privateNoStoreHeaders },
    );
  }

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
    const credential = await runtimeModel.withApiKey((apiKey) =>
      issueRealtimeTranscriptionSecret({
        language: parsed.language,
        model: runtimeModel.model,
        apiKey,
      })
    );
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
        provider: runtimeModel.provider,
        model: credential.model,
        language: parsed.language || "auto",
        turnDetection: "server_vad",
        audioRetention: REALTIME_AUDIO_RETENTION,
        transcriptRetention: REALTIME_TRANSCRIPT_RETENTION,
        reconnectAttempt: parsed.reconnectAttempt,
        credentialExpiresAt: credential.clientSecretExpiresAt,
        assignmentScope: runtimeModel.usageReceipt.assignmentScope || null,
        assignmentId: runtimeModel.usageReceipt.assignmentId || null,
        assignmentRevision:
          runtimeModel.usageReceipt.assignmentRevision || null,
        credentialSource: runtimeModel.usageReceipt.credentialSource,
      },
    });

    return Response.json({
      schemaVersion: 1,
      sessionId,
      conversationId: conversation.id,
      clientSecret: credential.clientSecret,
      clientSecretExpiresAt: credential.clientSecretExpiresAt,
      transportUrl: REALTIME_TRANSPORT_URL,
      provider: runtimeModel.provider,
      model: credential.model,
      language: parsed.language || "auto",
      turnDetection: "server_vad",
      audioRetention: REALTIME_AUDIO_RETENTION,
      transcriptRetention: REALTIME_TRANSCRIPT_RETENTION,
      reconnectAttempt: parsed.reconnectAttempt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    const failure = describeRealtimeSessionFailure(error);
    console.error(
      "Realtime voice session creation failed.",
      failure.code,
    );
    return Response.json(
      failure,
      { status: failure.status, headers: privateNoStoreHeaders },
    );
  }
}

function realtimeConfigurationFailure(
  runtimeModel: SpecializedRuntimeResolution,
) {
  const suggestion = runtimeModel.source === "tenant_assignment"
    ? "Open Settings → Models, validate the selected provider, and re-save Realtime transcription."
    : "Open Settings → Models and assign Realtime transcription, or explicitly configure both OPENAI_API_KEY and OPENAI_REALTIME_TRANSCRIPTION_MODEL.";
  const message = runtimeModel.warning ||
    "Realtime voice does not have an active transcription model route.";
  return {
    error: `${message} ${suggestion}`,
    code: "realtime_transcription_not_configured",
    suggestion,
  } as const;
}

function describeRealtimeSessionFailure(error: unknown) {
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  } | undefined;
  const name = String(candidate?.name || "");
  const status = Number(candidate?.status);
  const code = String(candidate?.code || "").toLowerCase();
  const message = String(candidate?.message || "").toLowerCase();
  if (name === "AbortError") {
    const suggestion = "Check the network connection and try voice mode again.";
    return {
      error: `Realtime voice took too long to connect. ${suggestion}`,
      code: "realtime_transcription_timeout",
      suggestion,
      status: 504,
    } as const;
  }
  if (
    status === 401 ||
    status === 403 ||
    code === "invalid_api_key" ||
    message.includes("api key not valid")
  ) {
    const suggestion = "Reconnect OpenAI in Settings, refresh its models, and re-save Realtime transcription.";
    return {
      error: `The realtime transcription provider rejected the credential selected in Settings. ${suggestion}`,
      code: "realtime_transcription_credential_rejected",
      suggestion,
      status: 503,
    } as const;
  }
  if (status === 429 || code.includes("rate_limit") || message.includes("quota")) {
    const suggestion = "Wait for the provider limit to reset, then start voice mode again.";
    return {
      error: `The realtime transcription provider has reached its current usage limit. ${suggestion}`,
      code: "realtime_transcription_rate_limited",
      suggestion,
      status: 429,
    } as const;
  }
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    code === "model_not_found" ||
    message.includes("model not found")
  ) {
    const suggestion = "Refresh OpenAI models and save a supported Realtime transcription model.";
    return {
      error: `The realtime transcription model selected in Settings is unavailable. ${suggestion}`,
      code: "realtime_transcription_model_unavailable",
      suggestion,
      status: 503,
    } as const;
  }
  const suggestion = "Try again. If it continues, reconnect OpenAI or select another realtime transcription model in Settings.";
  return {
    error: `Realtime voice could not establish a private transcription session. ${suggestion}`,
    code: "realtime_transcription_provider_unavailable",
    suggestion,
    status: 502,
  } as const;
}

async function PATCHHandler(request: Request) {
  const parsed = await parseRequest(
    request,
    nativeRealtimeVoiceSessionFinishRequestSchema,
  );
  if (parsed instanceof Response) return parsed;

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "voice_session",
      resourceId: parsed.sessionId,
      metadata: { operation: "finish", outcome: parsed.outcome },
      nativeMutationCapability: "voice.session.manage",
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
