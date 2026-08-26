import { GEMINI_FAST_MODEL, GEMINI_IMAGE_MODEL, hasGeminiKey, hasGoogleMediaKey } from "@/lib/config";
import type {
  ModelToolCall,
  ModelToolContinuation,
  ModelToolDefinition,
  ModelToolResult,
} from "@/lib/models/types";
import type { ModelUsage } from "@/lib/openai/model-router";

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const SPEECH_URL = "https://speech.googleapis.com/v1/speech:recognize";
const TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

type InteractionContent = { type?: string; text?: string; data?: string; mime_type?: string };
type InteractionStep = Record<string, unknown> & {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  content?: InteractionContent[];
};
type InteractionResponse = {
  id?: string;
  model?: string;
  status?: string;
  steps?: InteractionStep[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_cached_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

export type GeminiTextResult = {
  text: string;
  model: string;
  responseId?: string;
  latencyMs: number;
  usage: ModelUsage;
  estimatedCostUsd?: number;
};

export type GeminiToolTurnResult = GeminiTextResult & {
  toolCalls: ModelToolCall[];
  continuation: ModelToolContinuation;
};

export async function generateGeminiText(input: {
  prompt: string;
  instructions?: string;
  model?: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}): Promise<GeminiTextResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || !hasGeminiKey()) throw new Error("Gemini is not configured.");
  const model = input.model || GEMINI_FAST_MODEL;
  const startedAt = Date.now();
  const response = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model,
      input: input.prompt,
      ...(input.instructions ? { system_instruction: input.instructions } : {}),
      generation_config: { max_output_tokens: Math.min(Math.max(input.maxOutputTokens || 2_000, 64), 8_000) },
      store: false,
    }),
    signal: input.abortSignal,
  });
  const body = await readInteractionResponse(response);
  const text = interactionContents(body).filter((item) => item.type === "text").map((item) => item.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no text.");
  const usage = normalizeGeminiUsage(body.usage);
  return { text, model: body.model || model, responseId: body.id, latencyMs: Date.now() - startedAt, usage, estimatedCostUsd: estimateGeminiCostUsd(body.model || model, usage) };
}

export async function generateGeminiToolTurn(input: {
  prompt: string;
  instructions?: string;
  model?: string;
  maxOutputTokens?: number;
  tools: readonly ModelToolDefinition[];
  continuation?: ModelToolContinuation;
  toolResults?: readonly ModelToolResult[];
  abortSignal?: AbortSignal;
}): Promise<GeminiToolTurnResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || !hasGeminiKey()) throw new Error("Gemini is not configured.");
  if (input.continuation && input.continuation.provider !== "google") {
    throw new Error("Gemini cannot consume another provider's continuation state.");
  }
  const model = input.model || GEMINI_FAST_MODEL;
  const history: Record<string, unknown>[] = input.continuation?.state.length
    ? input.continuation.state.map((step) => ({ ...step }))
    : [{
        type: "user_input",
        content: [{ type: "text", text: input.prompt }],
      }];
  for (const result of input.toolResults || []) {
    history.push({
      type: "function_result",
      name: result.name,
      call_id: result.callId,
      result: [{ type: "text", text: result.output }],
      ...(result.isError ? { is_error: true } : {}),
    });
  }

  const startedAt = Date.now();
  const response = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model,
      input: history,
      ...(input.instructions ? { system_instruction: input.instructions } : {}),
      tools: input.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      generation_config: {
        max_output_tokens: Math.min(
          Math.max(input.maxOutputTokens || 2_000, 64),
          8_000,
        ),
      },
      store: false,
    }),
    signal: input.abortSignal,
  });
  const body = await readInteractionResponse(response);
  const steps = body.steps || [];
  const text = interactionContents(body)
    .filter((item) => item.type === "text")
    .map((item) => item.text || "")
    .join("")
    .trim();
  const toolCalls = steps.flatMap((step) => {
    if (step.type !== "function_call" || !step.id || !step.name) return [];
    return [{
      callId: step.id,
      name: step.name,
      argumentsJson: typeof step.arguments === "string"
        ? step.arguments
        : JSON.stringify(
            step.arguments && typeof step.arguments === "object"
              ? step.arguments
              : {},
          ),
    }];
  });
  if (!text && !toolCalls.length) {
    throw new Error("Gemini returned neither text nor function calls.");
  }
  const usage = normalizeGeminiUsage(body.usage);
  return {
    text,
    toolCalls,
    continuation: {
      provider: "google",
      // Preserve every model step exactly, including thought/tool signatures,
      // so the next store:false request remains a valid stateless continuation.
      state: [...history, ...steps],
    },
    model: body.model || model,
    responseId: body.id,
    latencyMs: Date.now() - startedAt,
    usage,
    estimatedCostUsd: estimateGeminiCostUsd(body.model || model, usage),
  };
}

export async function generateGeminiImage(input: {
  prompt: string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  abortSignal?: AbortSignal;
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || !hasGeminiKey()) throw new Error("Gemini image generation is not configured.");
  const startedAt = Date.now();
  const response = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model: GEMINI_IMAGE_MODEL,
      input: input.prompt,
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: input.aspectRatio || "1:1", image_size: "1K" },
      store: false,
    }),
    signal: input.abortSignal,
  });
  const body = await readInteractionResponse(response);
  const image = interactionContents(body).find((item) => item.type === "image" && item.data);
  if (!image?.data) throw new Error("Gemini returned no image.");
  return { data: image.data, mimeType: image.mime_type || "image/jpeg", model: body.model || GEMINI_IMAGE_MODEL, responseId: body.id, latencyMs: Date.now() - startedAt, usage: normalizeGeminiUsage(body.usage) };
}

export async function transcribeGoogleAudio(audio: File, abortSignal?: AbortSignal) {
  const apiKey = process.env.GOOGLE_MEDIA_API_KEY?.trim();
  if (!apiKey || !hasGoogleMediaKey()) throw new Error("Google Speech is not configured.");
  const mimeType = audio.type.split(";", 1)[0].toLowerCase();
  const encoding = speechEncoding(mimeType);
  const content = Buffer.from(await audio.arrayBuffer()).toString("base64");
  const response = await fetch(`${SPEECH_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { ...(encoding ? { encoding } : {}), languageCode: "en-US", enableAutomaticPunctuation: true, model: "latest_long" }, audio: { content } }),
    signal: abortSignal,
  });
  const body = await readJsonResponse(response) as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  const text = (body.results || []).map((result) => result.alternatives?.[0]?.transcript || "").filter(Boolean).join(" ").trim();
  if (!text) throw new Error("Google Speech could not recognize this recording.");
  return { text, model: "google-cloud-speech:latest_long" };
}

export async function synthesizeGoogleSpeech(text: string, abortSignal?: AbortSignal) {
  const apiKey = process.env.GOOGLE_MEDIA_API_KEY?.trim();
  if (!apiKey || !hasGoogleMediaKey()) throw new Error("Google Text-to-Speech is not configured.");
  const response = await fetch(`${TTS_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { text: text.slice(0, 5_000) }, voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" }, audioConfig: { audioEncoding: "MP3", speakingRate: 1.02 } }),
    signal: abortSignal,
  });
  const body = await readJsonResponse(response) as { audioContent?: string };
  if (!body.audioContent) throw new Error("Google Text-to-Speech returned no audio.");
  return Buffer.from(body.audioContent, "base64");
}

function interactionContents(body: InteractionResponse) {
  return (body.steps || []).flatMap((step) => step.type === "model_output" ? step.content || [] : []);
}

async function readInteractionResponse(response: Response) {
  const body = await readJsonResponse(response) as InteractionResponse;
  if (body.status === "failed") throw new Error(body.error?.message || "Gemini interaction failed.");
  return body;
}

async function readJsonResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nested = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
    const error = new Error(
      String(
        nested?.message || body.message || `Google API returned ${response.status}.`,
      ).slice(0, 1_000),
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

function speechEncoding(mimeType: string) {
  if (mimeType === "audio/webm") return "WEBM_OPUS";
  if (mimeType === "audio/ogg") return "OGG_OPUS";
  if (mimeType === "audio/mpeg") return "MP3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "LINEAR16";
  return undefined;
}

function normalizeGeminiUsage(raw?: InteractionResponse["usage"]): ModelUsage {
  const inputTokens = finiteToken(raw?.total_input_tokens);
  const outputTokens = finiteToken(raw?.total_output_tokens);
  return { inputTokens, outputTokens, cachedInputTokens: finiteToken(raw?.total_cached_tokens), totalTokens: finiteToken(raw?.total_tokens) || inputTokens + outputTokens };
}

export function estimateGeminiCostUsd(model: string, usage: ModelUsage) {
  try {
    const pricing = JSON.parse(process.env.GEMINI_MODEL_PRICING_JSON || "{}") as Record<string, { input?: unknown; output?: unknown; cachedInput?: unknown }>;
    const rate = pricing[model];
    const input = Number(rate?.input);
    const output = Number(rate?.output);
    const cachedInput = Number(rate?.cachedInput);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
    const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    const value = (uncached * input + usage.cachedInputTokens * (Number.isFinite(cachedInput) ? cachedInput : input) + usage.outputTokens * output) / 1_000_000;
    return Math.round(value * 1_000_000) / 1_000_000;
  } catch { return undefined; }
}

function finiteToken(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}
