"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { useCompanionPreferences } from "@/components/use-companion-preferences";
import { effectiveCompanionMotion } from "@/lib/companion/model";
import { companionPresentation, type CompanionWork } from "@/lib/companion/presentation";
import styles from "./companion-presence.module.css";

type PresenceProps = {
  work?: CompanionWork;
  microphoneActive?: boolean;
  playbackActive?: boolean;
  speechPreparing?: boolean;
  showHome?: boolean;
  onOpenHome?: (threadId: string) => void;
  homeDisabledReason?: string;
};

export function CompanionPresence(props: PresenceProps) {
  const { session, status } = useWorkspaceSession();
  const tenantId = session?.context?.tenantId;
  const actorId = session?.context?.actorId;
  const scope = status === "ready" && tenantId && actorId ? JSON.stringify([tenantId, actorId]) : undefined;
  return <ScopedPresence key={scope ?? "unavailable"} {...props} scope={scope} />;
}

function ScopedPresence({ scope, showHome = true, onOpenHome, homeDisabledReason, ...input }: PresenceProps & { scope?: string }) {
  const read = useCompanionPreferences(scope);
  const [assetFailed, setAssetFailed] = useState(false);
  const pageVisible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => false);
  const reduced = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const presentation = companionPresentation(input);
  const preferences = read.response?.snapshot.preferences;
  const motion = effectiveCompanionMotion(preferences?.motion ?? "off", reduced);
  const intensity = preferences?.intensity ?? "quiet";
  const showPortrait = Boolean(read.state === "ready" && preferences?.visible && pageVisible && !assetFailed);
  const home = read.response?.home;
  return (
    <section className={styles.presence} aria-label="ATLAS companion status" data-testid="companion-presence"
      data-companion-state={presentation.state} data-companion-motion={motion} data-companion-intensity={intensity}
      data-companion-preferences={read.state} data-companion-portrait={showPortrait ? "visible" : assetFailed ? "unavailable" : "hidden"}>
      <span className={styles.portrait} aria-hidden="true">
        {showPortrait ? <Image src="/companion/atlas-neutral.png" alt="" width={108} height={108} unoptimized loading="lazy"
          className={styles.image} onError={() => setAssetFailed(true)} /> : null}
      </span>
      <div className={styles.copy}>
        <p className={styles.status}><span className={styles.name}>ATLAS</span><span>{presentation.label}</span></p>
        <p className={styles.detail}>{presentation.detail}</p>
        {(input.microphoneActive || input.playbackActive || input.speechPreparing) && input.work && input.work.state !== "available" ? <p className={styles.detail}>Work: {input.work.label}. {input.work.detail}</p> : null}
        {!input.microphoneActive && !input.playbackActive && !input.speechPreparing && presentation.work.label !== presentation.label ? <p className={styles.detail}>{presentation.work.label}</p> : null}
        {presentation.work.runId ? <p className={styles.identity}>Run <code>{presentation.work.runId}</code></p> : null}
        {intensity !== "quiet" ? <p className={styles.caption}>Presentation companion{intensity === "expressive" ? " · Static portrait" : ""}</p> : null}
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
    </section>
  );
}

function subscribeVisibility(notify: () => void) { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); }
function visibleSnapshot() { return document.visibilityState === "visible"; }
function subscribeMotion(notify: () => void) { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); }
function motionSnapshot() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
