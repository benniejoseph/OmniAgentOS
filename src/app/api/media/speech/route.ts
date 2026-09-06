import { createHash } from "node:crypto";
import { z } from "zod";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { synthesizeGoogleSpeech } from "@/lib/google/ai";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { isBuiltInPromptAgentId } from "@/lib/orchestration/prompts";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  CustomAgentReadConflictError,
  getCustomAgentForRequest,
} from "@/lib/skills/store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  text: z.string().trim().min(1).max(5_000),
  agentId: z.string().trim().min(1).max(240).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  ).optional(),
}).strict();

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "synthesize_speech" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Add text between 1 and 5,000 characters." }, { status: 400 });
  let identity;
  try {
    identity = await resolveSpeechIdentity(parsed.data.agentId, context);
  } catch (error) {
    if (error instanceof CustomAgentReadConflictError) {
      return Response.json(
        { error: "Custom Agent ownership could not be verified." },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    throw error;
  }
  if (!identity) {
    return Response.json(
      { error: "Agent not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  const startedAt = Date.now();
  try {
    const audio = await synthesizeGoogleSpeech(parsed.data.text, request.signal, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      sourceStreamId: "api:media:speech",
      operation: "speech_synthesis",
      purpose: "agent.voice.synthesize",
      credentialSource: "deployment_environment",
    });
    await recordRuntimeEventSafely({
      category: "api",
      action: "media.speech",
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "media",
      resourceId: identity.id,
      durationMs: Date.now() - startedAt,
      message: "Agent speech synthesis completed.",
      metadata: {
        provider: "google",
        characters: parsed.data.text.length,
        agentId: identity.id,
        voiceSha256: createHash("sha256").update(identity.voice).digest("hex"),
      },
    });
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length), "cache-control": "private, no-store", "content-disposition": `inline; filename=${safeFilename(identity.name)}-response.mp3` } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Speech synthesis failed." }, { status: 502 });
  }
}

async function resolveSpeechIdentity(
  agentId: string | undefined,
  context: Awaited<ReturnType<typeof authorizeRequest>>,
) {
  if (!agentId) {
    return {
      id: "asael",
      name: "Asael",
      voice: "Clear, direct, calm, and explicit about uncertainty.",
    };
  }
  if (isBuiltInPromptAgentId(agentId)) {
    const agent = arsenalAgents.find((candidate) => candidate.id === agentId);
    if (!agent) return undefined;
    return { id: agent.id, name: agent.name, voice: agent.persona.voice };
  }
  const agent = await getCustomAgentForRequest(agentId, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  return agent
    ? { id: agent.id, name: agent.name, voice: agent.persona.voice }
    : undefined;
}

function safeFilename(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60);
  return normalized || "agent";
}
