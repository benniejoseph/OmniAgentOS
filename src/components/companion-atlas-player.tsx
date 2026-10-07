"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import type { companionPresentation } from "@/lib/companion/presentation";
import { atlasMotionAllowed, createAtlasPlaybackGate } from "@/lib/companion/atlas-assets";
import { AtlasLottie, atlasEnvironmentAllowsMotion, atlasThemeSnapshot, subscribeAtlasEnvironment, subscribeAtlasTheme } from "@/components/companion-atlas-lottie";

/** The mounted owner/conversation owns the reaction ledger. Hidden, historical,
 * reduced-motion and unavailable observations are consumed without playback. */
export function useCompanionAtlasPlayer({ scope, conversationId, presentation, greeting = false }: {
  scope?: string;
  conversationId?: string;
  presentation: ReturnType<typeof companionPresentation>;
  greeting?: boolean;
}) {
  const read = useCompanionPreferences(scope);
  const [assetFailed, setAssetFailed] = useState(false);
  const [playbackKey, setPlaybackKey] = useState<object>();
  const [gate] = useState(createAtlasPlaybackGate);
  const observationRef = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const environmentAllowsMotion = useSyncExternalStore(subscribeAtlasEnvironment, atlasEnvironmentAllowsMotion, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const theme = useSyncExternalStore(subscribeAtlasTheme, atlasThemeSnapshot, () => "light" as const);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const showPortrait = Boolean(read.state === "ready" && preferences?.visible && !assetFailed);
  const eligible = Boolean(!greeting && scope && showPortrait && onScreen && environmentAllowsMotion && motion === "full" && atlasMotionAllowed(intensity, presentation.state));
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
    const admitted = gate.observe({ state, work: { state: workState, runId, completionIdentity, label: "", detail: "" }, eligible, hasConversation: Boolean(conversationId) });
    setPlaybackKey(admitted ? {} : undefined);
  }, [completionIdentity, conversationId, eligible, gate, preferenceIdentity, runId, state, theme, workState]);

  return {
    read, motion, intensity, assetFailed, showPortrait, observationRef,
    portrait: { state, theme, playbackKey, motionAllowed: eligible, showPortrait, onUnavailable: () => setAssetFailed(true) },
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
