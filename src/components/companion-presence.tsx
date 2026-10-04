"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import { companionPresentation, type CompanionWork } from "@/lib/companion/presentation";
import {
  ATLAS_ASSET_ROOT, ATLAS_GREETING_POSTER, ATLAS_NEUTRAL_POSTER, atlasFrameAt, atlasMotionAllowed, createAtlasPlaybackGate, fetchAtlasManifest,
  type AtlasManifest, type AtlasTheme,
} from "@/lib/companion/atlas-assets";
import styles from "./companion-presence.module.css";

type PresenceProps = {
  /** Exact selected conversation; this is a presentation boundary, not authority. */
  conversationId?: string;
  work?: CompanionWork;
  microphoneActive?: boolean;
  playbackActive?: boolean;
  speechPreparing?: boolean;
  showHome?: boolean;
  onOpenHome?: (threadId: string) => void;
  homeDisabledReason?: string;
  /** A modest greeting before the first message; active conversations stay compact. */
  layout?: "compact" | "greeting";
};

export function CompanionPresence(props: PresenceProps) {
  const { session, status } = useWorkspaceSession();
  const manifest = useAtlasManifest();
  const tenantId = session?.context?.tenantId;
  const actorId = session?.context?.actorId;
  const scope = status === "ready" && tenantId && actorId
    ? JSON.stringify([tenantId, actorId, session?.user?.id, session?.context?.role, session?.membership?.role]) : undefined;
  const conversationId = props.conversationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.conversationId)
    ? props.conversationId : undefined;
  return <ScopedPresence key={JSON.stringify([scope, conversationId])} {...props} conversationId={conversationId} scope={scope} manifest={manifest} />;
}

function ScopedPresence({ scope, conversationId, manifest, showHome = true, onOpenHome, homeDisabledReason, layout = "compact", ...input }: PresenceProps & { scope?: string; manifest?: AtlasManifest }) {
  const read = useCompanionPreferences(scope);
  const [assetFailed, setAssetFailed] = useState(false);
  const [failedPosters, setFailedPosters] = useState<ReadonlySet<string>>(() => new Set());
  const playback = useRef(() => {});
  const [gate] = useState(createAtlasPlaybackGate);
  const sectionRef = useRef<HTMLElement>(null);
  const posterRef = useRef<HTMLSpanElement>(null);
  const spriteRef = useRef<HTMLSpanElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const pageVisible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, () => "light" as const);
  const presentation = companionPresentation(input);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const portraitSize = layout === "greeting" ? 72 : 36;
  const greeting = layout === "greeting" && presentation.state === "available";
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
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting);
      if (!visible) playback.current();
      setOnScreen(visible);
    });
    observer.observe(section);
    return () => { observer.disconnect(); playback.current(); };
  }, [playback]);

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
      sprite.style.backgroundSize = `${portraitSize * 4}px ${rows * portraitSize}px`;
      portrait.style.display = "none";
      sprite.style.display = "block";
      const tick = () => {
        if (!current) return;
        const elapsed = performance.now() - started;
        const frame = atlasFrameAt(clip, elapsed);
        if (frame.done) { stop(); return; }
        sprite.style.backgroundPosition = `${-(frame.index % 4) * portraitSize}px ${-Math.floor(frame.index / 4) * portraitSize}px`;
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
  }, [assets, clip, completionIdentity, conversationId, eligible, gate, playback, portraitSize, preferenceIdentity, runId, state, theme, workState]);

  const home = read.response?.home;
  return (
    <section ref={sectionRef} className={styles.presence} aria-label="ATLAS companion status" data-testid="companion-presence"
      data-companion-state={presentation.state} data-companion-motion={motion} data-companion-intensity={intensity}
      data-companion-layout={layout}
      data-companion-artwork={fullBody ? "greeting" : "portrait"}
      data-companion-preferences={read.state} data-companion-portrait={showPortrait ? "visible" : assetFailed ? "unavailable" : "hidden"}>
      <details className={styles.disclosure}>
      <summary className={styles.summary}>
      <span className={styles.portrait} aria-hidden="true">
        <span ref={posterRef}>{showPortrait ? <Image key={poster} src={poster} alt="" width={fullBody ? 211 : 108} height={fullBody ? 432 : 108} unoptimized loading="lazy"
          className={styles.image} onError={() => {
            playback.current();
            if (poster === ATLAS_NEUTRAL_POSTER) setAssetFailed(true);
            else setFailedPosters((current) => new Set([...current, poster]));
          }} /> : null}</span>
        <span ref={spriteRef} style={{ display: "none", width: portraitSize, height: portraitSize, backgroundRepeat: "no-repeat" }} />
      </span>
      <span className={styles.status}><span className={styles.name}>ATLAS</span><span className={styles.state}>{presentation.label}</span></span>
      <ChevronDown size={13} className={styles.chevron} aria-hidden="true" />
      <span className="sr-only">Status details and companion settings</span>
      </summary>
      <div className={styles.panel}>
      <div className={styles.copy}>
        <p className={styles.detail}>{presentation.detail}</p>
        {(input.microphoneActive || input.playbackActive || input.speechPreparing) && input.work && input.work.state !== "available" ? <p className={styles.detail}>Work: {input.work.label}. {input.work.detail}</p> : null}
        {!input.microphoneActive && !input.playbackActive && !input.speechPreparing && presentation.work.label !== presentation.label ? <p className={styles.detail}>{presentation.work.label}</p> : null}
        {presentation.work.runId ? <p className={styles.identity}>Run <code>{presentation.work.runId}</code></p> : null}
        {read.state === "unavailable" ? <p className={styles.detail}>Companion preferences unavailable. Status and controls remain available.</p> : null}
        {assetFailed && preferences?.visible ? <p className={styles.detail}>Portrait unavailable.</p> : null}
      </div>
      {showHome ? <div className={styles.actions}>
        {home?.state === "available" && home.preferredThreadId && onOpenHome ? <button type="button" className={styles.link}
          disabled={Boolean(homeDisabledReason)} title={homeDisabledReason || home.preferredThreadId}
          onClick={() => onOpenHome(home.preferredThreadId!)}>Home conversation</button> : home ? <Link className={styles.link} href={home.href ?? home.fallbackHref} prefetch={false} title={home.preferredThreadId ?? undefined}>
          {home.state === "available" ? "Home conversation" : "Open Assistant"}
        </Link> : null}
        <Link className={styles.link} href="/app/settings" prefetch={false}>Companion settings</Link>
        {homeDisabledReason && home?.state === "available" ? <p className={styles.detail}>{homeDisabledReason}</p> : null}
        {home?.state === "unavailable" || home?.state === "unconfirmed" ? <p className={styles.detail}>Home conversation {home.state === "unavailable" ? "unavailable" : "not confirmed"}; opens Assistant.</p> : null}
      </div> : null}
      </div>
      </details>
    </section>
  );
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
