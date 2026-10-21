import { afterEach, describe, expect, it, vi } from "vitest";
import { followCommandAttachments, prepareCommandUploads, readCommandAttachment, uploadCommandAttachments } from "./command-attachments";
import type { VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";

afterEach(() => vi.useRealTimers());
const file = (name: string) => new File(["sample"], name);
const item = (id: string, status = "ready") => ({ schemaVersion: 1, id: `library:capture_asset:${id}`, tenantId: "tenant", kind: "file",
  sourceAuthority: "capture_asset", sourceId: id, title: id, summary: "", sourceLabel: "Capture", status, tags: [],
  scope: { visibility: "user_private", ownerActorId: "actor", workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
  currentVersion: { versionId: `version:capture_asset:${id}:hash`, versionNumber: 1, contentSha256: "a".repeat(64), byteCount: 6, mediaType: "text/plain", sourceRevisionId: null, createdAt: "2026-10-21T00:00:00.000Z" },
  versionCount: 1, citationRefs: [`capture-asset:${id}`], links: [], openHref: "/app/capture", createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z" });

describe("command upload receipts", () => {
  it("validates every selected file before any upload is admitted", () => {
    const oversized = { name: "large", size: 6 * 1024 * 1024 + 1 } as File;
    const key = vi.fn();
    expect(() => prepareCommandUploads([file("first"), oversized], key)).toThrow("large is larger");
    expect(key).not.toHaveBeenCalled();
  });
  it("retains a successful first file and reuses the second file's exact key after a transport failure", async () => {
    const attempts = prepareCommandUploads([file("first.txt"), file("second.txt")]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ asset: { id: "first" } })).mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(Response.json({ asset: { id: "second" } }));
    const stored = vi.fn(); const signal = new AbortController().signal;
    const result = await uploadCommandAttachments({ attempts, signal, onStored: stored, fetchImpl });
    expect(stored).toHaveBeenCalledExactlyOnceWith({ assetId: "first", label: "first.txt" });
    expect(result.remaining).toEqual([attempts[1]]);
    const retry = await uploadCommandAttachments({ attempts: result.remaining, signal, onStored: stored, fetchImpl });
    expect(retry.remaining).toEqual([]); expect(stored).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].headers).toEqual(fetchImpl.mock.calls[2][1].headers);
  });
  it("never starts a second upload after owner cancellation", async () => {
    const controller = new AbortController(); const attempts = prepareCommandUploads([file("one"), file("two")]);
    const fetchImpl = vi.fn(async () => { controller.abort(); return Response.json({ asset: { id: "one" } }); });
    const stored = vi.fn(); const result = await uploadCommandAttachments({ attempts, signal: controller.signal, onStored: stored, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(stored).not.toHaveBeenCalled(); expect(result.remaining).toEqual(attempts);
  });
});

describe("exact attachment readiness", () => {
  it("opens the exact uploaded Library item without six unrelated catalogs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ item: item("old-outside-first-sixty") }));
    const result = await readCommandAttachment({ assetId: "old-outside-first-sixty", label: "old" }, new AbortController().signal, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/library/library%3Acapture_asset%3Aold-outside-first-sixty");
    expect(result.reference).toMatchObject({ id: "library:capture_asset:old-outside-first-sixty", selectable: true, bindingSha256: "a".repeat(64) });
  });
  it("rejects a mismatched receipt instead of attaching another file", async () => {
    await expect(readCommandAttachment({ assetId: "wanted", label: "wanted" }, new AbortController().signal,
      vi.fn().mockResolvedValue(Response.json({ item: item("other") })))).rejects.toThrow("did not match");
  });
  it("uses bounded serial reads, pauses hidden tabs, and resumes exact outstanding IDs", async () => {
    vi.useFakeTimers();
    let visible = true; const listeners = new Set<() => void>();
    const environment: VisibleRefreshEnvironment = { isVisible: () => visible,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimer: clearTimeout,
      addFocusListener: () => {}, removeFocusListener: () => {}, addVisibilityListener: fn => { listeners.add(fn); }, removeVisibilityListener: fn => { listeners.delete(fn); } };
    const read = vi.fn().mockResolvedValue({ state: "processing" });
    const paused = vi.fn();
    const stop = followCommandAttachments({ attachments: [{ assetId: "one", label: "one" }], read, environment,
      onReady: vi.fn(), onFailed: vi.fn(), onPaused: paused });
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(3);
    visible = false; listeners.forEach(fn => fn());
    await vi.advanceTimersByTimeAsync(600_000); expect(read).toHaveBeenCalledTimes(3);
    visible = true; listeners.forEach(fn => fn());
    await vi.advanceTimersByTimeAsync(240_000);
    expect(read).toHaveBeenCalledTimes(24); expect(paused).toHaveBeenCalledTimes(1);
    stop();
  });
});
