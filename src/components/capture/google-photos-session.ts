export type GooglePhotosPickerSession = {
  handle: string;
  pickerUri?: string;
  expiresAt: string;
  mediaItemsSet: boolean;
  pollAfterMs: number;
  timeoutAfterMs: number;
};

export type ClientGooglePhotosPickerSession = GooglePhotosPickerSession & {
  clientPollDeadlineAt: number;
};

type CloseGooglePhotosPickerSessionOptions = {
  fetcher?: typeof fetch;
  keepalive?: boolean;
};

export class GooglePhotosPickerSessionCloseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GooglePhotosPickerSessionCloseError";
    this.status = status;
  }
}

export function withGooglePhotosPollDeadline(
  session: GooglePhotosPickerSession,
  previous?: ClientGooglePhotosPickerSession,
  nowMs = Date.now(),
): ClientGooglePhotosPickerSession {
  const expiresAtMs = Date.parse(session.expiresAt);
  const validExpiry = Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs;
  const validTimeout = Number.isFinite(session.timeoutAfterMs) && session.timeoutAfterMs > 0
    ? session.timeoutAfterMs
    : 0;
  const providerDeadline = Math.min(validExpiry, nowMs + validTimeout);
  const existingDeadline = previous?.handle === session.handle && Number.isFinite(previous.clientPollDeadlineAt)
    ? previous.clientPollDeadlineAt
    : providerDeadline;

  return {
    ...session,
    clientPollDeadlineAt: Math.min(providerDeadline, existingDeadline),
  };
}

export function googlePhotosSessionDeadlineElapsed(
  session: ClientGooglePhotosPickerSession,
  nowMs = Date.now(),
) {
  return session.clientPollDeadlineAt <= nowMs;
}

export function nextGooglePhotosSessionWakeDelayMs(
  session: ClientGooglePhotosPickerSession,
  nowMs = Date.now(),
) {
  const remainingMs = Math.max(0, session.clientPollDeadlineAt - nowMs);
  if (remainingMs === 0 || session.mediaItemsSet) return remainingMs;

  const pollAfterMs = Number.isFinite(session.pollAfterMs) && session.pollAfterMs > 0
    ? session.pollAfterMs
    : 3_000;
  const boundedPollDelay = Math.min(Math.max(pollAfterMs, 2_000), 10_000);
  return Math.min(boundedPollDelay, remainingMs);
}

export async function closeGooglePhotosPickerSession(
  handle: string,
  options: CloseGooglePhotosPickerSessionOptions = {},
): Promise<"closed" | "already_closed"> {
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(
    `/api/oauth/google/photos/sessions/${encodeURIComponent(handle)}`,
    {
      method: "DELETE",
      keepalive: options.keepalive,
    },
  );

  if (response.ok) return "closed";
  if (response.status === 404 || response.status === 410) return "already_closed";

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new GooglePhotosPickerSessionCloseError(
    payload.error || "Google Photos could not confirm that the selection was closed.",
    response.status,
  );
}
