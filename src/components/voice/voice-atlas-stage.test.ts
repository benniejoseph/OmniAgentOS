import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANION_PREFERENCES_CONTRACT, DEFAULT_COMPANION_PREFERENCES } from "@/lib/companion/model";
import { ATLAS_NEUTRAL_POSTER } from "@/lib/companion/atlas-assets";
import type { CompanionState } from "@/lib/companion/presentation";
import type { useCompanionAtlasPlayer } from "@/components/companion-atlas-player";

const { usePlayer } = vi.hoisted(() => ({ usePlayer: vi.fn<typeof useCompanionAtlasPlayer>() }));
vi.mock("@/components/companion-atlas-player", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/companion-atlas-player")>(),
  useCompanionAtlasPlayer: usePlayer,
}));

const { VoiceAtlasStage } = await import("./voice-mode");
type StageProps = Parameters<typeof VoiceAtlasStage>[0];
type Player = ReturnType<typeof useCompanionAtlasPlayer>;
let player: Player;

beforeEach(() => {
  usePlayer.mockReset();
  player = {
    read: {
      state: "ready",
      response: {
        schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT,
        snapshot: { revision: 1, persisted: true, updatedAt: "2026-10-04T10:00:00.000Z", preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "expressive" } },
        home: { state: "not_set", preferredThreadId: null, href: null, fallbackHref: "/app/command" },
        destination: { href: "/app/command", state: "configured" },
      },
    },
    motion: "full", intensity: "expressive", assetFailed: false, showPortrait: true, fullBody: false, poster: ATLAS_NEUTRAL_POSTER,
    observationRef: createRef<HTMLElement>(), posterRef: createRef<HTMLSpanElement>(), spriteRef: createRef<HTMLSpanElement>(), onPosterError: vi.fn(),
  };
  usePlayer.mockImplementation(() => player);
});

function stage(props: Partial<StageProps> = {}) {
  return renderToStaticMarkup(createElement(VoiceAtlasStage, {
    scope: "exact-owner-role", conversationId: "11111111-1111-4111-8111-111111111111",
    phase: "consent", microphoneOpen: false, replyAudioPlaying: false, ...props,
  }));
}

describe("expanded Voice ATLAS uses the shared decorative player", () => {
  it.each<[Partial<StageProps>, CompanionState]>([
    [{ phase: "requesting" }, "available"],
    [{ phase: "listening" }, "available"],
    [{ phase: "speaking", microphoneOpen: true }, "listening"],
    [{ phase: "replying" }, "working"],
    [{ phase: "replying", microphoneOpen: true, replyAudioPlaying: true }, "responding"],
    [{ phase: "waiting" }, "working"],
    [{ phase: "approval" }, "needs_you"],
    [{ phase: "reconnecting" }, "blocked"],
    [{ phase: "error" }, "blocked"],
    [{ phase: "resolved" }, "available"],
  ])("projects actual device and work evidence for %j", (props, expected) => {
    const html = stage(props);
    expect(usePlayer).toHaveBeenCalledWith(expect.objectContaining({
      scope: "exact-owner-role", conversationId: "11111111-1111-4111-8111-111111111111",
      presentation: expect.objectContaining({ state: expected }),
    }));
    // A resolved phase is not a terminal receipt, and cannot authorize a reaction.
    expect(usePlayer.mock.calls[0]?.[0].presentation.work.completionIdentity).toBeUndefined();
    expect(html).toContain(`data-companion-state="${expected}"`);
    expect(html).toContain("data-atlas-sprite");
  });

  it("keeps the shared gate and observation host mounted for hidden and unavailable preferences", () => {
    for (const state of ["hidden", "loading", "unavailable"] as const) {
      usePlayer.mockClear();
      player.read = state === "hidden"
        ? { ...player.read, state: "ready", response: { ...player.read.response!, snapshot: { ...player.read.response!.snapshot, preferences: { ...DEFAULT_COMPANION_PREFERENCES, visible: false } } } }
        : { state };
      player.showPortrait = false;
      const html = stage({ phase: "listening", microphoneOpen: true });
      expect(usePlayer).toHaveBeenCalledTimes(1);
      expect(usePlayer.mock.calls[0]?.[0].presentation.state).toBe("listening");
      expect(html).toContain("<aside");
      expect(html).toContain('hidden=""');
      expect(html).toContain('data-voice-portrait="hidden"');
      expect(html).not.toContain("<img");
    }
  });

  it("renders the shared neutral fallback as decoration and exposes its effective policy", () => {
    player.motion = "reduced";
    player.intensity = "balanced";
    const html = stage();
    expect(html).toContain(`src="${ATLAS_NEUTRAL_POSTER}"`);
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-companion-motion="reduced"');
    expect(html).toContain('data-companion-intensity="balanced"');
    expect(html).not.toContain('role="status"');
  });

  it("retains the actual state text if even the neutral portrait is unavailable", () => {
    player.assetFailed = true;
    player.showPortrait = false;
    const html = stage({ phase: "approval" });
    expect(html).toContain("Needs approval");
    expect(html).toContain("Portrait unavailable");
    expect(html).toContain('data-voice-portrait="unavailable"');
    expect(html).not.toContain("<img");
  });
});
