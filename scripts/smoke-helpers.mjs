const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

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
  const timeoutMs = positiveInteger(
    process.env.SMOKE_REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const method = init.method || "GET";

  try {
    return await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown network error";
    throw new Error(`${method} ${path} failed within ${timeoutMs}ms: ${reason}`);
  }
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
