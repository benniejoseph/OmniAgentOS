import "server-only";

import { recordAiUsageSafely } from "@/lib/usage/ledger";
import type { AiUsageScope } from "@/lib/usage/types";

const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

export type OpenAIImageFailure = {
  category: "configuration" | "permission" | "quota" | "safety" | "cancelled" | "upstream";
  code: string;
  publicMessage: string;
  suggestion: string;
  retryable: boolean;
  httpStatus: number;
  providerStatus?: number;
  retryAfterSeconds?: number;
};

export class OpenAIImageGenerationError extends Error {
  constructor(readonly failure: OpenAIImageFailure) {
    super(failure.publicMessage);
    this.name = "OpenAIImageGenerationError";
  }
}

export async function generateOpenAIImage(input: {
  prompt: string;
  model: string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  sources?: Array<{ bytes: Uint8Array; mimeType: string; filename: string }>;
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
  apiKey?: string;
}) {
  const apiKey = input.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  const model = input.model.trim();
  if (!apiKey || !model) {
    throw new OpenAIImageGenerationError({
      category: "configuration",
      code: "openai_image_not_configured",
      publicMessage: "OpenAI image generation is not configured for this workspace.",
      suggestion: "Connect OpenAI and assign an image model in Settings.",
      retryable: false,
      httpStatus: 503,
    });
  }
  const startedAt = Date.now();
  let response: Response | undefined;
  let responseBody: Record<string, unknown> | undefined;
  try {
    const sources = input.sources || [];
    const url = sources.length
      ? "https://api.openai.com/v1/images/edits"
      : "https://api.openai.com/v1/images/generations";
    const body = sources.length
      ? openAIImageEditForm(input, sources)
      : JSON.stringify({
          model,
          prompt: input.prompt,
          size: openAIImageSize(input.aspectRatio),
          quality: "high",
          output_format: "png",
        });
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
      },
      body,
      signal: input.abortSignal,
    });
    responseBody = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw providerError(response, responseBody);
    const data = Array.isArray(responseBody.data) ? responseBody.data : [];
    const first = data[0] && typeof data[0] === "object"
      ? data[0] as Record<string, unknown>
      : undefined;
    const encoded = typeof first?.b64_json === "string" ? first.b64_json : "";
    const bytes = decodeImage(encoded);
    const usage = normalizeUsage(responseBody.usage);
    if (input.usageScope) {
      await recordAiUsageSafely({
        ...input.usageScope,
        status: "completed",
        provider: "openai",
        model,
        usage: { ...usage, imageCount: 1, outputBytes: bytes.length },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: Date.now() - startedAt,
        providerRequestId: response.headers.get("x-request-id") || undefined,
      });
    }
    return {
      bytes,
      mimeType: "image/png",
      model,
      responseId: response.headers.get("x-request-id") || undefined,
      latencyMs: Date.now() - startedAt,
      usage,
    };
  } catch (error) {
    const failure = describeOpenAIImageFailure(error, response);
    if (input.usageScope) {
      await recordAiUsageSafely({
        ...input.usageScope,
        status: "failed",
        provider: "openai",
        model,
        usage: normalizeUsage(responseBody?.usage),
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 1,
        latencyMs: Date.now() - startedAt,
        providerRequestId: response?.headers.get("x-request-id") || undefined,
        failureKind: failure.category,
        retryable: failure.retryable,
      });
    }
    if (error instanceof OpenAIImageGenerationError) throw error;
    throw new OpenAIImageGenerationError(failure);
  }
}

export function describeOpenAIImageFailure(
  error: unknown,
  response?: Response,
): OpenAIImageFailure {
  if (error instanceof OpenAIImageGenerationError) return error.failure;
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown } | undefined;
  const status = Number(candidate?.status) || (response && !response.ok ? response.status : undefined);
  const message = String(candidate?.message || "").toLowerCase();
  const retryAfterSeconds = retryAfter(response?.headers.get("retry-after"));
  if (candidate?.name === "AbortError") return failure("cancelled", "openai_image_cancelled", "Image creation was cancelled.", "Try again when ready.", false, 499, status);
  if (status === 401 || status === 403) return failure("permission", "openai_image_permission", "OpenAI rejected the image-model credential.", "Validate the OpenAI connection and model access in Settings.", false, 403, status);
  if (status === 429) return { ...failure("quota", "openai_image_quota", "OpenAI image capacity is temporarily unavailable.", "Try again after the quota resets.", true, 429, status), retryAfterSeconds };
  if (/safety|policy|moderation/.test(message)) return failure("safety", "openai_image_safety", "OpenAI could not complete this image request under its safety policy.", "Revise the request and try again.", false, 400, status);
  return failure("upstream", "openai_image_upstream", "OpenAI could not complete the image request.", "Try again shortly or select another image model in Settings.", true, status && status >= 400 && status < 600 ? status : 502, status);
}

function openAIImageEditForm(
  input: Parameters<typeof generateOpenAIImage>[0],
  sources: NonNullable<Parameters<typeof generateOpenAIImage>[0]["sources"]>,
) {
  const form = new FormData();
  form.set("model", input.model);
  form.set("prompt", input.prompt);
  form.set("size", openAIImageSize(input.aspectRatio));
  form.set("quality", "high");
  form.set("output_format", "png");
  for (const source of sources) {
    const bytes = new ArrayBuffer(source.bytes.byteLength);
    new Uint8Array(bytes).set(source.bytes);
    form.append("image[]", new Blob([bytes], { type: source.mimeType }), source.filename);
  }
  return form;
}

function openAIImageSize(ratio?: string) {
  if (ratio === "9:16" || ratio === "3:4") return "1024x1536";
  if (ratio === "16:9" || ratio === "4:3") return "1536x1024";
  return "1024x1024";
}

function decodeImage(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (!value || !bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new OpenAIImageGenerationError({
      category: "upstream",
      code: "openai_image_invalid_output",
      publicMessage: "OpenAI returned an invalid or oversized image.",
      suggestion: "Try again with a simpler request.",
      retryable: true,
      httpStatus: 502,
    });
  }
  return bytes;
}

function providerError(response: Response, body: Record<string, unknown>) {
  const nested = body.error && typeof body.error === "object"
    ? body.error as Record<string, unknown>
    : undefined;
  const error = new Error(String(nested?.message || `OpenAI returned ${response.status}.`)) as Error & { status: number };
  error.status = response.status;
  return error;
}

function normalizeUsage(value: unknown) {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const inputTokens = unit(usage.input_tokens);
  const outputTokens = unit(usage.output_tokens);
  return { inputTokens, outputTokens, totalTokens: unit(usage.total_tokens) || inputTokens + outputTokens };
}

function unit(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function retryAfter(value?: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : undefined;
}

function failure(
  category: OpenAIImageFailure["category"],
  code: string,
  publicMessage: string,
  suggestion: string,
  retryable: boolean,
  httpStatus: number,
  providerStatus?: number,
): OpenAIImageFailure {
  return { category, code, publicMessage, suggestion, retryable, httpStatus, providerStatus };
}
