import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_MANIFEST_PATH, ATLAS_STATES, atlasFrameAt, createAtlasPlaybackGate, fetchAtlasManifest, parseAtlasManifest,
  type AtlasManifest,
} from "./atlas-assets";
import { companionWork, type CompanionState, type CompanionWork } from "./presentation";

function manifest(): AtlasManifest {
  return {
    schemaVersion: 1, creativeRevision: "sculpt-02", frameSize: 256, fps: 20, columns: 4,
    states: Object.fromEntries(ATLAS_STATES.map((state) => [state, {
      durationMs: 650, frameCount: 14,
      light: { poster: `${state}-light-poster.webp`, sprite: `${state}-light-sprite.webp`, posterSha256: "a".repeat(64), spriteSha256: "b".repeat(64) },
      dark: { poster: `${state}-dark-poster.webp`, sprite: `${state}-dark-sprite.webp`, posterSha256: "c".repeat(64), spriteSha256: "d".repeat(64) },
    }])) as AtlasManifest["states"],
  };
}

describe("public ATLAS manifest", () => {
  it("retains only a complete exact state/theme matrix with bounded fixed geometry", () => {
    const value = manifest();
    const result = parseAtlasManifest(value);
    expect(result).toEqual(value);
    expect(Object.isFrozen(result?.states.completed.light)).toBe(true);
    expect(result?.states.completed.light).not.toBe(value.states.completed.light);
    const longest = { ...value, states: { ...value.states, working: { ...value.states.working, durationMs: 1200, frameCount: 25 } } };
    expect(parseAtlasManifest(longest)?.states.working.frameCount).toBe(25);
  });

  it.each([
    { schemaVersion: 2 }, { frameSize: 512 }, { fps: 60 }, { columns: 8 }, { privateContent: "untrusted" },
    { creativeRevision: "" }, { creativeRevision: "a".repeat(161) }, { creativeRevision: " revised " }, { creativeRevision: "revision\n1" },
  ])("rejects unsupported or extra manifest fields %j", (change) => {
    expect(parseAtlasManifest({ ...manifest(), ...change })).toBeUndefined();
  });

  it.each([
    { durationMs: 1201, frameCount: 26 }, { durationMs: 0, frameCount: 1 }, { durationMs: 650.5 },
    { frameCount: 13 }, { frameCount: 25.5 }, { loop: true },
  ])("rejects malformed clip timing %j", (change) => {
    const value = manifest();
    expect(parseAtlasManifest({ ...value, states: { ...value.states, available: { ...value.states.available, ...change } } })).toBeUndefined();
  });

  it("rejects missing/extra states, path traversal, remote URLs, wrong state/theme and invalid digests", () => {
    const value = manifest();
    const { paused: _paused, ...missing } = value.states;
    expect(parseAtlasManifest({ ...value, states: missing })).toBeUndefined();
    expect(parseAtlasManifest({ ...value, states: { ...value.states, excited: value.states.available } })).toBeUndefined();
    for (const change of [
      { poster: "../secret.webp" }, { poster: "https://example.com/available-light-poster.webp" },
      { poster: "available-dark-poster.webp" }, { sprite: "completed-light-sprite.webp" },
      { poster: "available-light-poster.webp?token=secret" }, { spriteSha256: "x".repeat(64) }, { extra: true },
    ]) {
      expect(parseAtlasManifest({ ...value, states: { ...value.states, available: { ...value.states.available, light: { ...value.states.available.light, ...change } } } })).toBeUndefined();
    }
  });

  it("fetches only the public manifest without credentials and accepts no oversized/invalid response", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    fetcher.mockResolvedValueOnce(Response.json(manifest()));
    await expect(fetchAtlasManifest(controller.signal, fetcher)).resolves.toEqual(manifest());
    expect(fetcher).toHaveBeenCalledWith(ATLAS_MANIFEST_PATH, {
      credentials: "omit", cache: "no-cache", signal: controller.signal, headers: { accept: "application/json" },
    });
    fetcher.mockResolvedValueOnce(new Response(" ".repeat(16_385)));
    await expect(fetchAtlasManifest(controller.signal, fetcher)).resolves.toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response("not json"));
    await expect(fetchAtlasManifest(controller.signal, fetcher)).resolves.toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(fetchAtlasManifest(controller.signal, fetcher)).resolves.toBeUndefined();
  });

  it("does not accept a manifest from an aborted generation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => { controller.abort(); return Response.json(manifest()); });
    await expect(fetchAtlasManifest(controller.signal, fetcher)).resolves.toBeUndefined();
  });

  it("keeps a successful awaiting-review response unavailable without accepting artwork", async () => {
    const placeholder = { schemaVersion: 1, status: "awaiting-art-review" };
    expect(parseAtlasManifest(placeholder)).toBeUndefined();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(placeholder));
    await expect(fetchAtlasManifest(new AbortController().signal, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(ATLAS_MANIFEST_PATH, expect.objectContaining({ cache: "no-cache", credentials: "omit" }));
  });

  it("uses elapsed time, preserves the partial final interval and ends once", () => {
    const clip = { durationMs: 675, frameCount: 15 };
    expect(atlasFrameAt(clip, -1)).toEqual({ index: 0, done: false });
    expect(atlasFrameAt(clip, 49)).toEqual({ index: 0, done: false });
    expect(atlasFrameAt(clip, 50)).toEqual({ index: 1, done: false });
    expect(atlasFrameAt(clip, 510)).toEqual({ index: 10, done: false });
    expect(atlasFrameAt(clip, 674)).toEqual({ index: 13, done: false });
    expect(atlasFrameAt(clip, 675)).toEqual({ index: 14, done: true });
    expect(atlasFrameAt(clip, 9000)).toEqual({ index: 14, done: true });
  });
});

function completed(runId: string, receiptId = "receipt-a"): CompanionWork {
  // The caller supplies only the verified projection from companionWork; its
  // receipt validation already has independent domain regressions.
  return { state: "completed", label: "Completed", detail: "Verified", runId, completionIdentity: JSON.stringify([runId, receiptId]) };
}
function observe(gate: ReturnType<typeof createAtlasPlaybackGate>, work: CompanionWork, options: { eligible?: boolean; hasConversation?: boolean; state?: CompanionState } = {}) {
  return gate.observe({ state: options.state ?? work.state, work, eligible: options.eligible ?? true, hasConversation: options.hasConversation ?? true });
}

describe("one-shot ATLAS admission", () => {
  it("primes a mounted receipt and an asynchronously loaded historical receipt without celebrating", () => {
    const mounted = createAtlasPlaybackGate();
    expect(observe(mounted, completed("run-a"))).toBe(false);
    expect(observe(mounted, completed("run-a"))).toBe(false);
    const loading = createAtlasPlaybackGate();
    expect(observe(loading, companionWork({}))).toBe(false);
    expect(observe(loading, companionWork({ runId: "run-a" }))).toBe(true);
    expect(observe(loading, completed("run-a"))).toBe(false);
  });

  it("admits only a new verified receipt for an observed exact active run and conversation", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, completed("other-run"))).toBe(false);
    expect(observe(gate, completed("run-a"))).toBe(true);
    expect(observe(gate, completed("run-a"))).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"), { hasConversation: false })).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"))).toBe(false);
    const otherOwner = createAtlasPlaybackGate();
    expect(observe(otherOwner, completed("run-a", "receipt-b"))).toBe(false);
  });

  it("consumes hidden/quiet/reduced/offscreen or unavailable-asset receipts permanently", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, completed("run-a"), { eligible: false })).toBe(false);
    expect(observe(gate, completed("run-a"))).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"), { state: "responding" })).toBe(true);
    expect(observe(gate, completed("run-a", "receipt-b"))).toBe(false);
  });

  it("does not replay a state when visibility, theme, manifest, preferences or audio return", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({}));
    const working = companionWork({ status: "running", runId: "run-a" });
    expect(observe(gate, working)).toBe(true);
    expect(observe(gate, working)).toBe(false);
    expect(observe(gate, working, { eligible: false })).toBe(false);
    expect(observe(gate, working)).toBe(false);
    expect(observe(gate, working, { state: "listening", eligible: false })).toBe(false);
    expect(observe(gate, working, { state: "listening" })).toBe(false);
  });

  it("cannot celebrate legacy done/completed text or an unverified work projection", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, companionWork({ status: "completed", runId: "run-a" }))).toBe(true); // Available state only.
    expect(observe(gate, { state: "completed", label: "Done", detail: "HTTP 200", runId: "run-a" })).toBe(false);
  });
});
