import {
  ModelProviderError,
  preserveModelProviderResponseReceipt,
  type ProviderId,
} from "@/lib/models/types";

/** A provider SDK or HTTP failure as a typed model error that says whether a retry can help. */
export function classifyProviderError(provider: ProviderId, error: unknown) {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return preserveModelProviderResponseReceipt(
      error,
      new ModelProviderError("Model request was aborted.", provider, "abort", false),
    );
  }
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    headers?: unknown;
  } | undefined;
  const status = Number(candidate?.status);
  const message = String(candidate?.message || "Model provider request failed.").slice(0, 1_000);
  const normalized = message.toLowerCase();
  const preserve = (classified: ModelProviderError) =>
    preserveModelProviderResponseReceipt(error, classified);
  const retryAfterMs = providerRetryAfterMs(candidate?.headers);
  if (candidate?.name === "AbortError") return preserve(new ModelProviderError(message, provider, "abort", false, status));
  if (candidate?.name === "TimeoutError") {
    return preserve(new ModelProviderError(
      "The model provider did not answer before the call deadline.",
      provider,
      "timeout",
      true,
    ));
  }
  if (status === 401 || status === 403) return preserve(new ModelProviderError(message, provider, "authentication", false, status));
  if (candidate?.code === "context_length_exceeded" || contextLengthMessage.test(normalized)) {
    return preserve(new ModelProviderError(message, provider, "context_length", false, status));
  }
  if (status === 400 || status === 404 || status === 422) return preserve(new ModelProviderError(message, provider, "invalid_request", false, status));
  if (status === 429) return preserve(new ModelProviderError(message, provider, "rate_limit", true, status, { retryAfterMs }));
  if (status === 529 || normalized.includes("overloaded")) {
    return preserve(new ModelProviderError(message, provider, "overloaded", true, status, { retryAfterMs }));
  }
  if (normalized.includes("safety") || normalized.includes("refusal") || normalized.includes("blocked")) {
    return preserve(new ModelProviderError(message, provider, "safety", false, status));
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return preserve(new ModelProviderError(message, provider, "timeout", true, status));
  }
  if (status >= 500 || normalized.includes("unavailable") || normalized.includes("connection")) {
    return preserve(new ModelProviderError(message, provider, "unavailable", true, status, { retryAfterMs }));
  }
  if (isRetryableNetworkFailure(candidate)) {
    return preserve(new ModelProviderError(message, provider, "unavailable", true, status));
  }
  return preserve(new ModelProviderError(message, provider, "unknown", false, Number.isFinite(status) ? status : undefined));
}

/** How OpenAI, Claude and Gemini say the input exceeds the model's context. */
const contextLengthMessage =
  /context[ _](length|window)|prompt is too long|input token count/;

/**
 * The wait a provider asked for, in milliseconds, from OpenAI's
 * retry-after-ms or from retry-after as seconds or an HTTP date.
 */
function providerRetryAfterMs(headers: unknown) {
  if (!(headers instanceof Headers)) return undefined;
  const milliseconds = Number(headers.get("retry-after-ms") || NaN);
  if (milliseconds >= 0) return milliseconds;
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : undefined;
}

const retryableNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableNetworkFailure(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const code = String(candidate.code || "").toUpperCase();
    if (retryableNetworkCodes.has(code)) return true;
    const message = String(candidate.message || "").toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("failed to fetch") ||
      message.includes("network request failed") ||
      message.includes("socket hang up")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
