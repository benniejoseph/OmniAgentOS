const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 300_000;
const TRANSPORT_RETRY_DELAY_MS = 250;
const MAX_FAST_TRANSPORT_FAILURE_MS = 10_000;
const retryableTransportCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function getSmokeBaseUrl() {
  const value = process.env.BASE_URL?.trim();
  if (!value) {
    failSmoke("BASE_URL is required; production smoke never guesses a deployment URL.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    failSmoke("BASE_URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
    failSmoke("BASE_URL must use HTTPS unless it targets a loopback development server.");
  }
  if (url.username || url.password) {
    failSmoke("BASE_URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    failSmoke("BASE_URL must not contain a query string or fragment.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export async function smokeFetch(baseUrl, path, init = {}) {
  const {
    retryTransport = false,
    timeoutMs: requestedTimeoutMs,
    ...fetchInit
  } = init;
  const environmentTimeoutMs = positiveInteger(
    process.env.SMOKE_REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const timeoutMs = positiveInteger(
    requestedTimeoutMs,
    environmentTimeoutMs,
    MAX_TIMEOUT_MS,
  );
  const method = String(fetchInit.method || "GET").toUpperCase();
  const headers = new Headers(fetchInit.headers);
  const bypassSecret =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypassSecret) {
    headers.set("x-vercel-protection-bypass", bypassSecret);
  }
  const mayRetryTransport =
    retryTransport === true && (method === "GET" || method === "HEAD");
  const maximumAttempts = mayRetryTransport ? 2 : 1;
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  let attempts = 0;
  let lastError;

  while (attempts < maximumAttempts) {
    const attemptStartedAt = Date.now();
    const remainingMs = deadlineAt - attemptStartedAt;
    if (remainingMs <= 0) {
      lastError = new DOMException(
        "The smoke request deadline elapsed.",
        "TimeoutError",
      );
      break;
    }
    attempts += 1;

    try {
      return await fetch(`${baseUrl}${path}`, {
        redirect: "manual",
        ...fetchInit,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (error) {
      lastError = error;
      const attemptElapsedMs = Date.now() - attemptStartedAt;
      const retryDelayFitsDeadline =
        Date.now() + TRANSPORT_RETRY_DELAY_MS < deadlineAt;
      if (
        attempts >= maximumAttempts ||
        attemptElapsedMs > MAX_FAST_TRANSPORT_FAILURE_MS ||
        !retryDelayFitsDeadline ||
        !isRetryableTransportFailure(error)
      ) {
        break;
      }
      console.warn(JSON.stringify({
        level: "warn",
        event: "smoke.transport_retry",
        method,
        path: diagnosticPath(path),
        code: transportDiagnosticCode(error),
        attempt: attempts,
        elapsedMs: attemptElapsedMs,
        maximumAttempts,
      }));
      await delay(TRANSPORT_RETRY_DELAY_MS);
    }
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const diagnosticCode = transportDiagnosticCode(lastError);
  throw new Error(
    `${method} ${diagnosticPath(path)} failed after ${attempts} attempt(s) in ${elapsedMs}ms ` +
      `(timeout ${timeoutMs}ms; code=${diagnosticCode}).`,
  );
}

export function failSmoke(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

export function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function isLoopbackHttp(url) {
  return url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
}

function isRetryableTransportFailure(error) {
  if (!(error instanceof TypeError)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  return retryableTransportCodes.has(rawTransportCode(error));
}

function transportDiagnosticCode(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "TIMEOUT";
    if (error.name === "AbortError") return "ABORTED";
  }
  const code = rawTransportCode(error);
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNCLASSIFIED";
}

function rawTransportCode(error) {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  const code = cause && typeof cause === "object" ? cause.code : undefined;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function diagnosticPath(path) {
  try {
    return new URL(String(path), "https://smoke.invalid").pathname
      .replace(/[\u0000-\u001f\u007f<>]/g, "_")
      .slice(0, 240) || "/";
  } catch {
    return "/invalid-smoke-path";
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
