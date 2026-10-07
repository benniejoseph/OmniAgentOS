"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LottieComponentProps, LottieRefCurrentProps } from "lottie-react";
import type { AtlasTheme } from "@/lib/companion/atlas-assets";
import type { CompanionState } from "@/lib/companion/presentation";
import { atlasLottieAsset, fetchAtlasLottie } from "@/lib/companion/atlas-lottie";

const LottiePlayer = dynamic<LottieComponentProps>(() => import("lottie-react").then((module) => module.default), { ssr: false });

/** A decorative, finite reaction. Still SVGs do not load the Lottie runtime.
 * Consumed reactions never replay after visibility or motion settings change. */
export function AtlasLottie({ state, theme, playbackKey, motionAllowed, size = "100%", onUnavailable }: {
  state: CompanionState;
  theme: AtlasTheme;
  playbackKey?: object;
  motionAllowed: boolean;
  size?: string;
  onUnavailable?: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const player = useRef<LottieRefCurrentProps | null>(null);
  const consumed = useRef<object | undefined>(undefined);
  const [onScreen, setOnScreen] = useState<boolean>();
  const [clip, setClip] = useState<{ key: object; data: Record<string, unknown> }>();
  const [playing, setPlaying] = useState<object>();
  const permitted = useSyncExternalStore(subscribeAtlasEnvironment, atlasEnvironmentAllowsMotion, () => false);
  const allowed = motionAllowed && permitted && onScreen === true;
  const currentRequest = useRef({ playbackKey, allowed });
  currentRequest.current = { playbackKey, allowed };

  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting);
      if (!visible) player.current?.stop();
      setOnScreen(visible);
    });
    observer.observe(element);
    return () => { observer.disconnect(); player.current?.stop(); };
  }, []);

  useEffect(() => {
    player.current?.stop();
    setClip(undefined);
    setPlaying(undefined);
    if (!playbackKey || consumed.current === playbackKey) return;
    // The parent can observe its container before this inner element receives
    // its first observer entry. Unknown visibility is not an offscreen event.
    if (onScreen === undefined && motionAllowed && permitted) return;
    consumed.current = playbackKey;
    if (!allowed) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    void fetchAtlasLottie(state, theme, controller.signal).then((data) => {
      if (data && !controller.signal.aborted && currentRequest.current.allowed && currentRequest.current.playbackKey === playbackKey) setClip({ key: playbackKey, data });
    }).catch(() => undefined).finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); player.current?.stop(); };
  }, [allowed, motionAllowed, onScreen, permitted, playbackKey, state, theme]);

  const active = Boolean(allowed && playbackKey && clip?.key === playbackKey);
  return <span ref={host} aria-hidden="true" data-atlas-lottie data-atlas-state={state} style={{ display: "block", position: "relative", width: size, height: size }}>
    <Image src={atlasLottieAsset(state, theme, "svg")} alt="" width={256} height={256} unoptimized loading="lazy"
      onError={onUnavailable} style={{ display: "block", width: "100%", height: "100%", opacity: active && playing === playbackKey ? 0 : 1 }} />
    {active && clip ? <span style={{ position: "absolute", inset: 0, opacity: playing === playbackKey ? 1 : 0 }}>
      <LottiePlayer key={`${state}-${theme}`} lottieRef={player} animationData={clip.data} autoplay={false} loop={false} renderer="svg"
        onDOMLoaded={() => {
          if (!currentRequest.current.allowed || currentRequest.current.playbackKey !== clip.key) return;
          player.current?.animationItem?.setSubframe(false);
          player.current?.goToAndPlay(0, true);
          setPlaying(clip.key);
        }}
        onComplete={() => { player.current?.pause(); setPlaying(undefined); }}
        onDataFailed={() => setPlaying(undefined)}
        rendererSettings={{ preserveAspectRatio: "xMidYMid meet", progressiveLoad: false }} style={{ width: "100%", height: "100%" }} />
    </span> : null}
  </span>;
}

type DataConnection = EventTarget & { saveData?: boolean };
function dataConnection() { return (navigator as Navigator & { connection?: DataConnection }).connection; }
export function atlasEnvironmentAllowsMotion() {
  return document.visibilityState === "visible" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && dataConnection()?.saveData !== true;
}
export function subscribeAtlasEnvironment(notify: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const connection = dataConnection();
  query.addEventListener("change", notify);
  document.addEventListener("visibilitychange", notify);
  connection?.addEventListener("change", notify);
  return () => { query.removeEventListener("change", notify); document.removeEventListener("visibilitychange", notify); connection?.removeEventListener("change", notify); };
}
export function atlasThemeSnapshot(): AtlasTheme { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
export function subscribeAtlasTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
