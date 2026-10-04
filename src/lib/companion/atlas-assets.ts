import { createCompanionReactionLedger, type CompanionState, type CompanionWork } from "./presentation";

export const ATLAS_MANIFEST_PATH = "/companion/atlas-v1/manifest.json";
export const ATLAS_ASSET_ROOT = "/companion/atlas-v1/";
export const ATLAS_NEUTRAL_POSTER = "/companion/atlas-neutral.png";
export const ATLAS_GREETING_POSTER = "/companion/atlas-greeting.png";
export const ATLAS_STATES = ["available", "listening", "responding", "working", "needs_you", "blocked", "completed", "paused"] as const;
export type AtlasTheme = "light" | "dark";
export type AtlasAssets = Readonly<{ poster: string; sprite: string; posterSha256: string; spriteSha256: string }>;
export type AtlasClip = Readonly<{ durationMs: number; frameCount: number; light: AtlasAssets; dark: AtlasAssets }>;
export type AtlasManifest = Readonly<{
  schemaVersion: 1; creativeRevision: string; frameSize: 256; fps: 20; columns: 4;
  states: Readonly<Record<CompanionState, AtlasClip>>;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function assets(value: unknown, state: CompanionState, theme: AtlasTheme): value is AtlasAssets {
  return object(value) && keys(value, ["poster", "sprite", "posterSha256", "spriteSha256"])
    && value.poster === `${state}-${theme}-poster.webp` && value.sprite === `${state}-${theme}-sprite.webp`
    && typeof value.posterSha256 === "string" && /^[a-f0-9]{64}$/.test(value.posterSha256)
    && typeof value.spriteSha256 === "string" && /^[a-f0-9]{64}$/.test(value.spriteSha256);
}

/** Public decorative assets only. Paths, geometry and timing are never taken
 * from a conversation, receipt, connector, or other private response. */
export function parseAtlasManifest(value: unknown): AtlasManifest | undefined {
  if (!object(value) || !keys(value, ["schemaVersion", "creativeRevision", "frameSize", "fps", "columns", "states"])
    || value.schemaVersion !== 1 || value.frameSize !== 256 || value.fps !== 20 || value.columns !== 4
    || typeof value.creativeRevision !== "string" || value.creativeRevision.length < 1 || value.creativeRevision.length > 160
    || value.creativeRevision.trim() !== value.creativeRevision || [...value.creativeRevision].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || !object(value.states) || !keys(value.states, ATLAS_STATES)) return undefined;
  const states = {} as Record<CompanionState, AtlasClip>;
  for (const state of ATLAS_STATES) {
    const clip = value.states[state];
    if (!object(clip) || !keys(clip, ["durationMs", "frameCount", "light", "dark"])
      || typeof clip.durationMs !== "number" || !Number.isInteger(clip.durationMs) || clip.durationMs < 1 || clip.durationMs > 1200
      || typeof clip.frameCount !== "number" || !Number.isInteger(clip.frameCount) || clip.frameCount < 2 || clip.frameCount > 25
      || clip.frameCount !== Math.ceil(clip.durationMs / 50) + 1
      || !assets(clip.light, state, "light") || !assets(clip.dark, state, "dark")) return undefined;
    states[state] = Object.freeze({ durationMs: clip.durationMs, frameCount: clip.frameCount,
      light: Object.freeze({ ...clip.light }), dark: Object.freeze({ ...clip.dark }) });
  }
  return Object.freeze({ schemaVersion: 1, creativeRevision: value.creativeRevision, frameSize: 256, fps: 20, columns: 4, states: Object.freeze(states) });
}

/** The one manifest read is abortable and bounded even without Content-Length. */
export async function fetchAtlasManifest(signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<AtlasManifest | undefined> {
  const response = await fetchImpl(ATLAS_MANIFEST_PATH, { credentials: "omit", cache: "no-cache", signal, headers: { accept: "application/json" } });
  if (!response.ok || signal.aborted || !response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (signal.aborted) return undefined;
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 16_384) return undefined;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return parseAtlasManifest(JSON.parse(text));
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Elapsed time, not accumulated timer ticks, chooses a frame after a slow paint. */
export function atlasFrameAt(clip: Pick<AtlasClip, "durationMs" | "frameCount">, elapsedMs: number) {
  if (elapsedMs >= clip.durationMs) return { index: clip.frameCount - 1, done: true };
  return { index: Math.min(clip.frameCount - 1, Math.floor(Math.max(0, elapsedMs) / 50)), done: false };
}

/** One mounted owner/conversation owns this ledger. Every observation consumes
 * its transition, including hidden/reduced/off/asset-unavailable observations.
 * A first loaded completion is history, not a new completion reaction. */
export function createAtlasPlaybackGate() {
  const receipts = createCompanionReactionLedger();
  const observedActiveRuns = new Set<string>();
  let previousState: CompanionState | undefined;
  return {
    observe(input: { state: CompanionState; work: CompanionWork; eligible: boolean; hasConversation: boolean }) {
      const first = previousState === undefined;
      const changed = input.state !== previousState;
      previousState = input.state;
      const freshReceipt = receipts.accept(input.work);
      const hadActiveRun = Boolean(input.work.runId && observedActiveRuns.has(input.work.runId));
      if (input.work.runId && ["working", "needs_you", "paused"].includes(input.work.state) && observedActiveRuns.size < 128) {
        observedActiveRuns.add(input.work.runId);
      }
      if (first || !input.eligible) return false;
      if (input.state === "completed") return input.hasConversation && freshReceipt && hadActiveRun;
      return changed;
    },
  };
}
