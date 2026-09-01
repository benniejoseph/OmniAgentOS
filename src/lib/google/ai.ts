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
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

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

export type GeminiImageFailureCategory =
  | "configuration"
  | "permission"
  | "quota"
  | "safety"
  | "cancelled"
  | "upstream";

export type GeminiImageFailure = {
  category: GeminiImageFailureCategory;
  code: string;
  publicMessage: string;
  suggestion: string;
  retryable: boolean;
  httpStatus: number;
  providerStatus?: number;
  retryAfterSeconds?: number;
};

export class GeminiImageGenerationError extends Error {
  constructor(readonly failure: GeminiImageFailure) {
    super(failure.publicMessage);
    this.name = "GeminiImageGenerationError";
  }
}

export async function generateGeminiText(input: {
  prompt: string;
  instructions?: string;
  model?: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Server-only request credential. Never persist or include in receipts. */
  apiKey?: string;
}): Promise<GeminiTextResult> {
  const apiKey = input.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || (!input.apiKey && !hasGeminiKey())) throw new Error("Gemini is not configured.");
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
  /** Server-only request credential. Never persist or include in receipts. */
  apiKey?: string;
}): Promise<GeminiToolTurnResult> {
  const apiKey = input.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || (!input.apiKey && !hasGeminiKey())) throw new Error("Gemini is not configured.");
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
  if (!apiKey || !hasGeminiKey()) {
    throw new GeminiImageGenerationError({
      category: "configuration",
      code: "gemini_image_not_configured",
      publicMessage: "Gemini image generation is not configured for this workspace.",
      suggestion: "Add a valid Gemini API key in the workspace environment, then try again.",
      retryable: false,
      httpStatus: 503,
    });
  }
  const startedAt = Date.now();
  let response: Response | undefined;
  try {
    response = await fetch(INTERACTIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        input: input.prompt,
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: input.aspectRatio || "1:1",
          image_size: "1K",
        },
        store: false,
      }),
      signal: input.abortSignal,
    });
    const body = await readInteractionResponse(response);
    input.abortSignal?.throwIfAborted();
    const image = interactionContents(body).find((item) => item.type === "image" && item.data);
    if (!image?.data) {
      throw new GeminiImageGenerationError({
        category: "upstream",
        code: "gemini_image_empty_response",
        publicMessage: "Gemini completed the request but did not return an image.",
        suggestion: "Revise the prompt and try again.",
        retryable: true,
        httpStatus: 502,
      });
    }
    const mimeType = normalizeGeneratedImageMimeType(image.mime_type);
    const bytes = decodeGeneratedImage(image.data, mimeType);
    return {
      bytes,
      mimeType,
      model: body.model || GEMINI_IMAGE_MODEL,
      responseId: body.id,
      latencyMs: Date.now() - startedAt,
      usage: normalizeGeminiUsage(body.usage),
    };
  } catch (error) {
    if (error instanceof GeminiImageGenerationError) throw error;
    if (input.abortSignal?.aborted) {
      throw new GeminiImageGenerationError(
        classifyGeminiImageFailure({ name: "AbortError" }),
      );
    }
    throw new GeminiImageGenerationError(
      classifyGeminiImageFailure(error, response),
    );
  }
}

export function describeGeminiImageFailure(error: unknown): GeminiImageFailure {
  if (error instanceof GeminiImageGenerationError) return error.failure;
  return classifyGeminiImageFailure(error);
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

function classifyGeminiImageFailure(
  error: unknown,
  response?: Response,
): GeminiImageFailure {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
  } | undefined;
  const message = String(candidate?.message || "").toLowerCase();
  const numericStatus = Number(candidate?.status);
  const providerStatus = Number.isFinite(numericStatus) && numericStatus >= 400
    ? numericStatus
    : response && !response.ok
      ? response.status
      : undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(
    response?.headers.get("retry-after"),
  );

  if (candidate?.name === "AbortError") {
    return {
      category: "cancelled",
      code: "gemini_image_cancelled",
      publicMessage: "Image generation was cancelled.",
      suggestion: "Start a new generation when you are ready.",
      retryable: false,
      httpStatus: 499,
      providerStatus,
    };
  }

  if (
    providerStatus === 429 ||
    message.includes("resource_exhausted") ||
    message.includes("resource exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit")
  ) {
    return {
      category: "quota",
      code: "gemini_image_quota_exhausted",
      publicMessage: "Gemini image generation quota is currently exhausted.",
      suggestion: "Wait for the provider limit to reset or review the Gemini project quota.",
      retryable: true,
      httpStatus: 429,
      providerStatus,
      retryAfterSeconds,
    };
  }

  if (
    providerStatus === 401 ||
    providerStatus === 403 ||
    message.includes("permission_denied") ||
    message.includes("permission denied") ||
    message.includes("unauthenticated") ||
    message.includes("unauthorized") ||
    message.includes("api key not valid")
  ) {
    return {
      category: "permission",
      code: "gemini_image_permission_denied",
      publicMessage: "Google rejected the Gemini image credentials or permissions.",
      suggestion: "Check the Gemini API key and confirm the Gemini API is enabled for its project.",
      retryable: false,
      httpStatus: 502,
      providerStatus,
    };
  }

  if (
    message.includes("safety") ||
    message.includes("blocked") ||
    message.includes("policy violation") ||
    message.includes("refusal")
  ) {
    return {
      category: "safety",
      code: "gemini_image_safety_block",
      publicMessage: "Gemini could not generate this image because the request was blocked by its safety policy.",
      suggestion: "Revise the prompt and try again.",
      retryable: false,
      httpStatus: 422,
      providerStatus,
    };
  }

  if (
    providerStatus === 400 ||
    providerStatus === 404 ||
    providerStatus === 422 ||
    message.includes("invalid_argument") ||
    message.includes("invalid argument") ||
    message.includes("model not found") ||
    message.includes("not supported")
  ) {
    return {
      category: "configuration",
      code: "gemini_image_invalid_configuration",
      publicMessage: "Gemini image generation has a server configuration issue.",
      suggestion: "Check the configured Gemini image model and request settings.",
      retryable: false,
      httpStatus: 503,
      providerStatus,
    };
  }

  return {
    category: "upstream",
    code: "gemini_image_upstream_failure",
    publicMessage: "Gemini image generation is temporarily unavailable.",
    suggestion: "Try the generation again in a moment.",
    retryable: true,
    httpStatus: 502,
    providerStatus,
  };
}

function parseRetryAfterSeconds(value: string | null | undefined) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}

function normalizeGeneratedImageMimeType(value: string | undefined) {
  const mimeType = String(value || "image/jpeg").trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  if (mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp") {
    return mimeType;
  }
  throw invalidGeminiImageResponse("gemini_image_unsupported_media_type");
}

function decodeGeneratedImage(data: string, mimeType: string) {
  const encoded = data.trim();
  const maxEncodedCharacters = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4;
  if (!encoded || encoded.length > maxEncodedCharacters) {
    throw invalidGeminiImageResponse(
      encoded ? "gemini_image_response_too_large" : "gemini_image_empty_response",
    );
  }
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw invalidGeminiImageResponse("gemini_image_invalid_base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw invalidGeminiImageResponse("gemini_image_response_too_large");
  }
  const hasExpectedSignature = mimeType === "image/jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!hasExpectedSignature) {
    throw invalidGeminiImageResponse("gemini_image_invalid_content");
  }
  return bytes;
}

function invalidGeminiImageResponse(code: string) {
  return new GeminiImageGenerationError({
    category: "upstream",
    code,
    publicMessage: "Gemini returned an invalid image response.",
    suggestion: "Try the generation again in a moment.",
    retryable: true,
    httpStatus: 502,
  });
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
