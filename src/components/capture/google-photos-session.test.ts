import { describe, expect, it, vi } from "vitest";

import {
  closeGooglePhotosPickerSession,
  googlePhotosSessionDeadlineElapsed,
  nextGooglePhotosSessionWakeDelayMs,
  withGooglePhotosPollDeadline,
} from "@/components/capture/google-photos-session";

const session = {
  handle: "picker/session #1",
  pickerUri: "https://photos.google.com/picker",
  expiresAt: "2026-09-11T12:10:00.000Z",
  mediaItemsSet: false,
  pollAfterMs: 3_000,
  timeoutAfterMs: 120_000,
};

describe("Google Photos client session lifecycle", () => {
  it("bounds the client deadline by both provider expiry and timeout", () => {
    const now = Date.parse("2026-09-11T12:00:00.000Z");

    expect(withGooglePhotosPollDeadline(session, undefined, now).clientPollDeadlineAt)
      .toBe(now + 120_000);
    expect(withGooglePhotosPollDeadline({
      ...session,
      expiresAt: "2026-09-11T12:00:30.000Z",
    }, undefined, now).clientPollDeadlineAt).toBe(now + 30_000);
  });

  it("never extends a same-handle deadline during refresh", () => {
    const startedAt = Date.parse("2026-09-11T12:00:00.000Z");
    const initial = withGooglePhotosPollDeadline(session, undefined, startedAt);
    const refreshed = withGooglePhotosPollDeadline(
      { ...session, timeoutAfterMs: 600_000 },
      initial,
      startedAt + 60_000,
    );

    expect(refreshed.clientPollDeadlineAt).toBe(initial.clientPollDeadlineAt);
  });

  it("wakes at the deadline instead of polling past it", () => {
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    const active = withGooglePhotosPollDeadline({
      ...session,
      pollAfterMs: 10_000,
      timeoutAfterMs: 1_500,
    }, undefined, now);

    expect(nextGooglePhotosSessionWakeDelayMs(active, now)).toBe(1_500);
    expect(nextGooglePhotosSessionWakeDelayMs(active, now + 1_500)).toBe(0);
    expect(googlePhotosSessionDeadlineElapsed(active, now + 1_499)).toBe(false);
    expect(googlePhotosSessionDeadlineElapsed(active, now + 1_500)).toBe(true);

    const selectionReady = { ...active, mediaItemsSet: true };
    expect(nextGooglePhotosSessionWakeDelayMs(selectionReady, now)).toBe(1_500);
  });

  it.each([404, 410])("treats DELETE %s as an already-closed session", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));

    await expect(closeGooglePhotosPickerSession(session.handle, { fetcher }))
      .resolves.toBe("already_closed");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/oauth/google/photos/sessions/picker%2Fsession%20%231",
      { method: "DELETE", keepalive: undefined },
    );
  });

  it("uses keepalive for unmount cleanup", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(closeGooglePhotosPickerSession(session.handle, { fetcher, keepalive: true }))
      .resolves.toBe("closed");
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("surfaces non-terminal close failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: "Provider cleanup failed." },
      { status: 503 },
    ));

    await expect(closeGooglePhotosPickerSession(session.handle, { fetcher }))
      .rejects.toMatchObject({
        name: "GooglePhotosPickerSessionCloseError",
        message: "Provider cleanup failed.",
        status: 503,
      });
  });
});
