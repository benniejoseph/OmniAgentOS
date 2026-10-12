"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import type { companionPresentation } from "@/lib/companion/presentation";
import { atlasMotionAllowed, createAtlasPlaybackGate } from "@/lib/companion/atlas-assets";
import { AtlasLottie, atlasEnvironmentAllowsMotion, atlasThemeSnapshot, subscribeAtlasEnvironment, subscribeAtlasTheme } from "@/components/companion-atlas-lottie";

/** The mounted owner/conversation owns the reaction ledger. Hidden, historical,
 * reduced-motion and unavailable observations are consumed without playback. */
export function useCompanionAtlasPlayer({ scope, conversationId, presentation, greeting = false, voice = false, reaction = 0 }: {
  scope?: string;
  conversationId?: string;
  presentation: ReturnType<typeof companionPresentation>;
  greeting?: boolean;
  /** Explicit live voice may react in Balanced, while normal app presence stays finite. */
  voice?: boolean;
  reaction?: number;
}) {
  const read = useCompanionPreferences(scope);
  const [assetFailed, setAssetFailed] = useState(false);
  const [playbackKey, setPlaybackKey] = useState<object>();
  const [gate] = useState(createAtlasPlaybackGate);
  const voiceObservation = useRef<{ state: typeof presentation.state; reaction: number } | undefined>(undefined);
  const observationRef = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const environmentAllowsMotion = useSyncExternalStore(subscribeAtlasEnvironment, atlasEnvironmentAllowsMotion, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const theme = useSyncExternalStore(subscribeAtlasTheme, atlasThemeSnapshot, () => "light" as const);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const showPortrait = Boolean(read.state === "ready" && preferences?.visible && !assetFailed);
  const eligible = Boolean(!greeting && scope && showPortrait && onScreen && environmentAllowsMotion && motion === "full" && (voice ? intensity === "balanced" || intensity === "expressive" : atlasMotionAllowed(intensity, presentation.state)));
  const preferenceIdentity = JSON.stringify([read.state, read.response?.snapshot.revision, preferences]);
  const { state, work: { state: workState, runId, completionIdentity } } = presentation;

  useEffect(() => {
    const element = observationRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(Boolean(entry?.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (voice) {
      const previous = voiceObservation.current;
      voiceObservation.current = { state, reaction };
      // Consume hidden/reduced observations too. Returning to a tab never
      // replays an old speech turn or invents activity.
      const fresh = Boolean(previous && (previous.state !== state || previous.reaction !== reaction));
      setPlaybackKey(fresh && eligible ? {} : undefined);
      return;
    }
    const admitted = gate.observe({ state, work: { state: workState, runId, completionIdentity, label: "", detail: "" }, eligible, hasConversation: Boolean(conversationId) });
    setPlaybackKey(admitted ? {} : undefined);
  }, [completionIdentity, conversationId, eligible, gate, preferenceIdentity, runId, state, theme, workState, voice, reaction]);

  return {
    read, motion, intensity, assetFailed, showPortrait, observationRef,
    portrait: { state, theme, playbackKey, motionAllowed: eligible, repeatWhileActive: voice && state === "responding", showPortrait, onUnavailable: () => setAssetFailed(true) },
  };
}

/** Decorative only: the host keeps its existing state labels and controls. */
export function CompanionAtlasPortrait({ showPortrait, className, size, ...player }: ReturnType<typeof useCompanionAtlasPlayer>["portrait"] & {
  className: string;
  size: string;
}) {
  return <span className={className} aria-hidden="true">
    {showPortrait ? <AtlasLottie {...player} size={size} /> : null}
  </span>;
}

function subscribeMotion(notify: () => void) { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); }
function motionSnapshot() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
