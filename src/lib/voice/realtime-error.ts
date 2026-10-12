/** The shape of a provider error code that a session receipt may keep. */
export const REALTIME_PROVIDER_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * Codes after which the provider session cannot continue. The Realtime API
 * keeps the session open after most errors, and a transport that does end is
 * handled by reconnection.
 */
const FATAL_CODES: ReadonlySet<string> = new Set(["session_expired"]);

/**
 * The client's commit found the audio buffer empty, because turn detection
 * had already committed the last turn.
 */
const EMPTY_COMMIT_CODE = "input_audio_buffer_commit_empty";

export type RealtimeProviderError = Readonly<{
  /** The provider's code or type, never its message. */
  code: string;
  fatal: boolean;
  emptyCommit: boolean;
}>;

/** Classifies an untrusted Realtime `error` event by its code alone. */
export function classifyRealtimeError(event: unknown): RealtimeProviderError {
  const error = isRecord(event) && isRecord(event.error) ? event.error : {};
  const code = identifier(error.code) ?? identifier(error.type) ?? "unknown";
  return {
    code,
    fatal: FATAL_CODES.has(code),
    emptyCommit: code === EMPTY_COMMIT_CODE,
  };
}

/** Connection failures contain our copy and allowlisted metadata, never a
 * provider message, credential, or SDP body. */
export class RealtimeConnectionError extends Error {
  constructor(message: string, readonly detail: string, readonly providerCode?: string) {
    super(message);
    this.name = "RealtimeConnectionError";
  }
}

const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "realtime_transcription_not_configured",
  "realtime_transcription_timeout",
  "realtime_transcription_credential_rejected",
  "realtime_transcription_rate_limited",
  "realtime_transcription_model_unavailable",
  "realtime_transcription_provider_unavailable",
  "invalid_api_key",
  "invalid_client_secret",
  "client_secret_expired",
  "session_expired",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "model_not_supported",
  "unsupported_country_region_territory",
  "invalid_request_error",
  "invalid_value",
  "unknown_parameter",
  "server_error",
]);

export function realtimeConnectionFailure(
  stage: "session" | "audio",
  status: number,
  body: unknown,
) {
  const record = isRecord(body) ? body : {};
  const provider = isRecord(record.error) ? record.error : record;
  const candidate = identifier(provider.code) ?? identifier(provider.type);
  const code = candidate && CONNECTION_ERROR_CODES.has(candidate) ? candidate : undefined;
  let message = stage === "session"
    ? "Voice setup could not finish. Try again; if it keeps failing, check Realtime transcription in Settings → Models."
    : "The audio connection could not open. Try again; if it keeps failing, check your network and Realtime transcription in Settings → Models.";
  if (code === "realtime_transcription_not_configured" || code === "realtime_transcription_model_unavailable" || code === "model_not_found" || code === "model_not_supported") {
    message = "The voice model is unavailable. Open Settings → Models, check Realtime transcription, then try again.";
  } else if (code === "realtime_transcription_credential_rejected" || code === "invalid_api_key") {
    message = "OpenAI refused the voice connection. Validate the OpenAI provider in Settings → Models, then try again.";
  } else if (code === "client_secret_expired" || code === "session_expired" || code === "invalid_client_secret") {
    message = "The voice connection expired before it could start. Try again to open a fresh session.";
  } else if (code === "unsupported_country_region_territory") {
    message = "OpenAI could not provide voice from this network or region. Check OpenAI availability for your connection.";
  } else if (code === "insufficient_quota" || status === 402) {
    message = "The OpenAI account has no available voice quota. Check its usage and billing before trying again.";
  } else if (status === 429 || code === "rate_limit_exceeded" || code === "realtime_transcription_rate_limited") {
    message = "Too many voice connections were started. Wait a minute, then try again.";
  } else if (status === 401 || status === 403) {
    message = stage === "session"
      ? "Voice access was refused. Check your sign-in and the OpenAI provider in Settings → Models, then try again."
      : "OpenAI refused the audio connection. Try again; if it continues, validate the OpenAI provider in Settings → Models.";
  } else if (status === 404 && stage === "session") {
    message = "This voice conversation is no longer available. Open a new conversation, then try voice again.";
  } else if (status === 408 || status === 504 || code === "realtime_transcription_timeout") {
    message = "Voice took too long to connect. Check your connection, then try again.";
  } else if (status >= 500) {
    message = "The voice service is temporarily unavailable. Try again shortly.";
  }
  const detail = `${stage === "session" ? "Voice setup" : "Audio connection"} · HTTP ${status}${code ? ` · ${code}` : ""}`;
  return new RealtimeConnectionError(message, detail, code);
}

function identifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return REALTIME_PROVIDER_ERROR_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
