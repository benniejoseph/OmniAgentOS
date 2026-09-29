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
  } | undefined;
  const status = Number(candidate?.status);
  const message = String(candidate?.message || "Model provider request failed.").slice(0, 1_000);
  const normalized = message.toLowerCase();
  const preserve = (classified: ModelProviderError) =>
    preserveModelProviderResponseReceipt(error, classified);
  if (candidate?.name === "AbortError") return preserve(new ModelProviderError(message, provider, "abort", false, status));
  if (status === 401 || status === 403) return preserve(new ModelProviderError(message, provider, "authentication", false, status));
  if (status === 400 || status === 404 || status === 422) return preserve(new ModelProviderError(message, provider, "invalid_request", false, status));
  if (status === 429) return preserve(new ModelProviderError(message, provider, "rate_limit", true, status));
  if (normalized.includes("safety") || normalized.includes("refusal") || normalized.includes("blocked")) {
    return preserve(new ModelProviderError(message, provider, "safety", false, status));
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return preserve(new ModelProviderError(message, provider, "timeout", true, status));
  }
  if (status >= 500 || normalized.includes("unavailable") || normalized.includes("connection")) {
    return preserve(new ModelProviderError(message, provider, "unavailable", true, status));
  }
  if (isRetryableNetworkFailure(candidate)) {
    return preserve(new ModelProviderError(message, provider, "unavailable", true, status));
  }
  return preserve(new ModelProviderError(message, provider, "unknown", false, Number.isFinite(status) ? status : undefined));
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
