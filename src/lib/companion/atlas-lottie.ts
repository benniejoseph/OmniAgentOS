import type { CompanionState } from "./presentation";
import type { AtlasTheme } from "./atlas-assets";

export const ATLAS_LOTTIE_ROOT = "/companion/atlas-lottie";
export const ATLAS_CREATIVE_REVISION = "atlas-scout-20261009-voice";

export function atlasLottieAsset(state: CompanionState, theme: AtlasTheme, format: "json" | "svg") {
  return `${ATLAS_LOTTIE_ROOT}/${state}-${theme}.${format}?v=${ATLAS_CREATIVE_REVISION}`;
}

/** Only small, same-origin, decorative vector compositions are admitted. No
 * conversation, tool output, or remote asset can supply animation instructions. */
export async function fetchAtlasLottie(state: CompanionState, theme: AtlasTheme, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(atlasLottieAsset(state, theme, "json"), { signal, credentials: "omit", cache: "force-cache" });
  if (!response.ok || !response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, source = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) return undefined;
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128 * 1024) return undefined;
      source += decoder.decode(next.value, { stream: true });
    }
    const data: unknown = JSON.parse(source + decoder.decode());
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const value = data as Record<string, unknown>;
    if (value.w !== 256 || value.h !== 256 || value.fr !== 30 || value.ip !== 0
      || typeof value.op !== "number" || value.op < 1 || value.op > 36
      || !Array.isArray(value.assets) || value.assets.length !== 0
      || !Array.isArray(value.layers) || value.layers.length > 32
      || value.layers.some((layer) => !layer || typeof layer !== "object" || layer.ty !== 4)) return undefined;
    return value;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
