"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import type { companionPresentation } from "@/lib/companion/presentation";
import {
  ATLAS_ASSET_ROOT, ATLAS_GREETING_POSTER, ATLAS_NEUTRAL_POSTER, atlasFrameAt, atlasMotionAllowed, createAtlasPlaybackGate, fetchAtlasManifest,
  type AtlasManifest, type AtlasTheme,
} from "@/lib/companion/atlas-assets";

/** One decorative player per mounted owner/conversation view. Call this even
 * when the character is hidden: ineligible transitions must still be consumed.
 * The caller keys that exact boundary and keeps the observation element mounted.
 * This player never starts audio, work, or a completed-outcome decision. */
export function useCompanionAtlasPlayer({ scope, conversationId, presentation, greeting = false }: {
  scope?: string;
  conversationId?: string;
  presentation: ReturnType<typeof companionPresentation>;
  greeting?: boolean;
}) {
  const read = useCompanionPreferences(scope);
  const manifest = useAtlasManifest();
  const [assetFailed, setAssetFailed] = useState(false);
  const [failedPosters, setFailedPosters] = useState<ReadonlySet<string>>(() => new Set());
  const playback = useRef(() => {});
  const [gate] = useState(createAtlasPlaybackGate);
  const observationRef = useRef<HTMLElement>(null);
  const posterRef = useRef<HTMLSpanElement>(null);
  const spriteRef = useRef<HTMLSpanElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const pageVisible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, () => "light" as const);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const showPortrait = Boolean(read.state === "ready" && preferences?.visible && pageVisible && !assetFailed);
  const clip = manifest?.states[presentation.state];
  const assets = clip?.[theme];
  const selectedPoster = greeting ? ATLAS_GREETING_POSTER
    : assets ? `${ATLAS_ASSET_ROOT}${assets.poster}?v=${assets.posterSha256}` : ATLAS_NEUTRAL_POSTER;
  const poster = failedPosters.has(selectedPoster) ? ATLAS_NEUTRAL_POSTER : selectedPoster;
  const fullBody = showPortrait && poster === ATLAS_GREETING_POSTER;
  const eligible = Boolean(!greeting && scope && showPortrait && onScreen && motion === "full" && atlasMotionAllowed(intensity, presentation.state) && clip && assets && !failedPosters.has(selectedPoster));
  const preferenceIdentity = JSON.stringify([read.state, read.response?.snapshot.revision, preferences]);
  const { state, work: { state: workState, runId, completionIdentity } } = presentation;

  useEffect(() => {
    const element = observationRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting);
      if (!visible) playback.current();
      setOnScreen(visible);
    });
    observer.observe(element);
    return () => { observer.disconnect(); playback.current(); };
  }, []);

  useLayoutEffect(() => {
    const admitted = gate.observe({ state, work: { state: workState, runId, completionIdentity, label: "", detail: "" }, eligible, hasConversation: Boolean(conversationId) });
    const sprite = spriteRef.current;
    const portrait = posterRef.current;
    if (!admitted || !clip || !assets || !sprite || !portrait) return;
    let current = true;
    let timer: number | undefined;
    const image = new window.Image();
    const url = `${ATLAS_ASSET_ROOT}${assets.sprite}?v=${assets.spriteSha256}`;
    const rows = Math.ceil(clip.frameCount / 4);
    const stop = () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      sprite.style.display = "none";
      sprite.style.backgroundImage = "none";
      portrait.style.display = "block";
    };
    playback.current = stop;
    const interrupt = () => { if (!visibleSnapshot() || motionSnapshot() || themeSnapshot() !== theme) stop(); };
    document.addEventListener("visibilitychange", interrupt);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", interrupt);
    const themeObserver = new MutationObserver(interrupt);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    image.onerror = stop;
    image.onload = () => {
      if (!current || !sprite.isConnected || !visibleSnapshot() || motionSnapshot() || themeSnapshot() !== theme
        || image.naturalWidth !== 1024 || image.naturalHeight !== rows * 256) { stop(); return; }
      const started = performance.now();
      sprite.style.backgroundImage = `url("${url}")`;
      // Percentage frame geometry follows the existing responsive portrait size
      // without starting another clip on a desktop/mobile layout change.
      sprite.style.backgroundSize = `400% ${rows * 100}%`;
      portrait.style.display = "none";
      sprite.style.display = "block";
      const tick = () => {
        if (!current) return;
        const elapsed = performance.now() - started;
        const frame = atlasFrameAt(clip, elapsed);
        if (frame.done) { stop(); return; }
        sprite.style.backgroundPosition = `${(frame.index % 4) * 100 / 3}% ${rows > 1 ? Math.floor(frame.index / 4) * 100 / (rows - 1) : 0}%`;
        timer = window.setTimeout(tick, Math.min(50 - elapsed % 50, clip.durationMs - elapsed));
      };
      tick();
    };
    image.src = url;
    return () => {
      stop();
      document.removeEventListener("visibilitychange", interrupt);
      media.removeEventListener("change", interrupt);
      themeObserver.disconnect();
    };
  }, [assets, clip, completionIdentity, conversationId, eligible, gate, preferenceIdentity, runId, state, theme, workState]);

  return {
    read, motion, intensity, assetFailed, showPortrait, fullBody, poster,
    observationRef, posterRef, spriteRef,
    onPosterError() {
      playback.current();
      if (poster === ATLAS_NEUTRAL_POSTER) setAssetFailed(true);
      else setFailedPosters((current) => new Set([...current, poster]));
    },
  };
}

/** Empty alt text and a hidden wrapper keep decorative playback out of the
 * live transcript. The host supplies the existing portrait dimensions. */
export function CompanionAtlasPortrait({ posterRef, spriteRef, showPortrait, poster, fullBody, onPosterError, className, imageClassName, size }: Pick<ReturnType<typeof useCompanionAtlasPlayer>, "posterRef" | "spriteRef" | "showPortrait" | "poster" | "fullBody" | "onPosterError"> & {
  className: string;
  imageClassName: string;
  size: string;
}) {
  return <span className={className} aria-hidden="true">
    <span ref={posterRef} data-atlas-poster>{showPortrait ? <Image key={poster} src={poster} alt=""
      width={fullBody ? 211 : 108} height={fullBody ? 432 : 108} unoptimized loading="lazy"
      className={imageClassName} onError={onPosterError} /> : null}</span>
    <span ref={spriteRef} data-atlas-sprite style={{ display: "none", width: size, height: size, backgroundRepeat: "no-repeat" }} />
  </span>;
}

function subscribeVisibility(notify: () => void) { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); }
function visibleSnapshot() { return document.visibilityState === "visible"; }
function subscribeMotion(notify: () => void) { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); }
function motionSnapshot() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function subscribeTheme(notify: () => void) { const observer = new MutationObserver(notify); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); return () => observer.disconnect(); }
function themeSnapshot(): AtlasTheme { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }

function useAtlasManifest() {
  const [manifest, setManifest] = useState<AtlasManifest>();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void fetchAtlasManifest(controller.signal).then((result) => {
      if (current && !controller.signal.aborted) setManifest(result);
    }).catch(() => undefined).finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, []);
  return manifest;
}
