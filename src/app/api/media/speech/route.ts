import { randomUUID } from "node:crypto";
import { z } from "zod";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { isBuiltInPromptAgentId } from "@/lib/orchestration/prompts";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  CustomAgentReadConflictError,
  getCustomAgentForRequest,
} from "@/lib/skills/store";
import { getOwnedThread } from "@/lib/threads/store";
import { recordAiUsageSafely } from "@/lib/usage/ledger";
import { createOpenAISpeechStream } from "@/lib/voice/openai-speech";
import {
  ASAEL_VOICE_PROFILE_VERSION,
  versionedVoiceProfile,
} from "@/lib/voice/profile";

export const runtime = "nodejs";
export const maxDuration = 180;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  text: z.string().trim().min(1).max(4_000),
  agentId: z.string().trim().min(1).max(240).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  ).optional(),
  threadId: z.string().uuid().optional(),
  runId: z.string().trim().min(1).max(240).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  ).optional(),
  voiceProfileVersion: z.literal(ASAEL_VOICE_PROFILE_VERSION)
    .default(ASAEL_VOICE_PROFILE_VERSION),
}).strict();

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "media",
      metadata: { operation: "stream_speech" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Add text between 1 and 4,000 characters and use the active voice profile." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  const rateLimitResponse = await enforceRateLimit(
    context.tenantId,
    context.actorId,
  );
  if (rateLimitResponse) return rateLimitResponse;
  const requestActorBinding =
    canonicalRequestActorBindingFromSecurityContext(context);
  if (parsed.data.threadId) {
    const thread = await getOwnedThread(parsed.data.threadId, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    if (!thread) {
      return Response.json(
        { error: "The speech conversation was not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
  }

  let identity;
  try {
    identity = await resolveSpeechIdentity(
      parsed.data.agentId,
      context,
      requestActorBinding,
    );
  } catch (error) {
    if (error instanceof CustomAgentReadConflictError) {
      return Response.json(
        { error: "Custom Agent ownership could not be verified." },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
  if (!identity) {
    return Response.json(
      { error: "Agent not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }

  const profile = versionedVoiceProfile(identity);
  const correlationId = `voice-speech:${randomUUID()}`;
  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId,
    purpose: "agent.voice.stream",
  });
  const startedAt = Date.now();
  try {
    const upstreamBody = await createOpenAISpeechStream({
      text: parsed.data.text,
      profile,
      signal: request.signal,
    });
    const meteredBody = meterSpeechStream(upstreamBody, async (
      outcome,
      outputBytes,
    ) => {
      const durationMs = Date.now() - startedAt;
      await recordAiUsageSafely({
        tenantId: context.tenantId,
        actorId: context.actorId,
        sourceStreamId: parsed.data.threadId
          ? `thread:${parsed.data.threadId}`
          : "api:media:speech",
        operation: "speech_synthesis",
        purpose: "agent.voice.stream",
        correlationId,
        executionScope,
        credentialSource: "deployment_environment",
        status: outcome === "completed" ? "completed" : "failed",
        provider: profile.provider,
        model: profile.model,
        usage: {
          inputCharacters: parsed.data.text.length,
          outputBytes,
        },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: outcome === "completed" ? 0 : 1,
        latencyMs: durationMs,
        ...(outcome === "completed"
          ? {}
          : {
              failureKind: outcome === "interrupted"
                ? "abort"
                : "provider_error",
              retryable: outcome !== "interrupted",
            }),
      });
      await Promise.all([
        recordRuntimeEventSafely({
          category: "api",
          action: outcome === "interrupted"
            ? "media.speech_interrupted"
            : outcome === "completed"
              ? "media.speech_streamed"
              : "media.speech_failed",
          tenantId: context.tenantId,
          actorId: context.actorId,
          correlationId,
          resourceType: "media",
          resourceId: identity.id,
          durationMs,
          message: outcome === "completed"
            ? "Versioned Agent speech stream completed."
            : outcome === "interrupted"
              ? "Versioned Agent speech stream was interrupted."
              : "Versioned Agent speech stream failed.",
          metadata: {
            provider: profile.provider,
            model: profile.model,
            profileVersion: profile.profileVersion,
            profileSha256: profile.sha256,
            agentId: identity.id,
            agentDefinitionVersion: identity.definitionVersion,
            threadId: parsed.data.threadId,
            runId: parsed.data.runId,
            characters: parsed.data.text.length,
            outputBytes,
          },
        }),
        appendScopedDomainEvent({
          streamId: parsed.data.threadId
            ? `thread:${parsed.data.threadId}`
            : `voice:${correlationId}`,
          type: outcome === "completed"
            ? "voice.speech_streamed"
            : outcome === "interrupted"
              ? "voice.speech_interrupted"
              : "voice.speech_failed",
          executionScope,
          payload: {
            schemaVersion: 1,
            provider: profile.provider,
            model: profile.model,
            profileVersion: profile.profileVersion,
            profileSha256: profile.sha256,
            agentId: identity.id,
            agentDefinitionVersion: identity.definitionVersion,
            threadId: parsed.data.threadId,
            runId: parsed.data.runId,
            characters: parsed.data.text.length,
            outputBytes,
          },
        }).catch((error) => {
          console.warn(
            "Voice speech lifecycle event failed.",
            error instanceof Error ? error.name : "UnknownError",
          );
          return undefined;
        }),
      ]);
    }, request.signal);

    return new Response(meteredBody, {
      headers: {
        "content-type": "audio/pcm",
        ...privateNoStoreHeaders,
        "x-asael-audio-encoding": profile.encoding,
        "x-asael-audio-sample-rate": String(profile.sampleRate),
        "x-asael-voice-profile": profile.profileVersion,
        "x-asael-voice-profile-sha256": profile.sha256,
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json(
        { error: "Speech playback was interrupted." },
        { status: 499, headers: privateNoStoreHeaders },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Speech synthesis failed." },
      { status: 502, headers: privateNoStoreHeaders },
    );
  }
}

async function resolveSpeechIdentity(
  agentId: string | undefined,
  context: Awaited<ReturnType<typeof authorizeRequest>>,
  requestActorBinding: ReturnType<
    typeof canonicalRequestActorBindingFromSecurityContext
  >,
) {
  if (!agentId) {
    return {
      id: "asael",
      name: "Asael",
      delivery: "Clear, direct, calm, and explicit about uncertainty.",
      definitionVersion: 1,
    };
  }
  if (isBuiltInPromptAgentId(agentId)) {
    const agent = arsenalAgents.find((candidate) => candidate.id === agentId);
    if (!agent) return undefined;
    return {
      id: agent.id,
      name: agent.name,
      delivery: agent.persona.voice,
      definitionVersion: 1,
    };
  }
  const agent = await getCustomAgentForRequest(agentId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding,
  });
  return agent
    ? {
        id: agent.id,
        name: agent.name,
        delivery: agent.persona.voice,
        definitionVersion: agent.activeDefinitionVersion || 1,
      }
    : undefined;
}

async function enforceRateLimit(tenantId: string, actorId: string) {
  try {
    const rate = await checkSharedRateLimit({
      key: `voice:speech:${tenantId}:${actorId}`,
      limit: 30,
      windowMs: 60_000,
    });
    if (rate.allowed) return undefined;
    return Response.json(
      { error: "Too many speech requests. Try again shortly." },
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
      { error: "Speech is temporarily unavailable." },
      {
        status: 503,
        headers: { ...privateNoStoreHeaders, "retry-after": "30" },
      },
    );
  }
}

function meterSpeechStream(
  source: ReadableStream<Uint8Array>,
  onFinish: (
    outcome: "completed" | "interrupted" | "failed",
    outputBytes: number,
  ) => Promise<void>,
  requestSignal: AbortSignal,
) {
  const reader = source.getReader();
  let outputBytes = 0;
  let finalized = false;
  const finalize = async (
    outcome: "completed" | "interrupted" | "failed",
  ) => {
    if (finalized) return;
    finalized = true;
    await onFinish(outcome, outputBytes);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finalize("completed");
          controller.close();
          return;
        }
        outputBytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        await finalize(requestSignal.aborted ? "interrupted" : "failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finalize("interrupted");
    },
  });
}
