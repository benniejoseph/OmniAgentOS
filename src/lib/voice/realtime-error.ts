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

function identifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return REALTIME_PROVIDER_ERROR_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
