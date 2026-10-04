"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "@/components/companion-atlas-player";
import { companionPresentation, type CompanionWork } from "@/lib/companion/presentation";
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
  const tenantId = session?.context?.tenantId;
  const actorId = session?.context?.actorId;
  const scope = status === "ready" && tenantId && actorId
    ? JSON.stringify([tenantId, actorId, session?.user?.id, session?.context?.role, session?.membership?.role]) : undefined;
  const conversationId = props.conversationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.conversationId)
    ? props.conversationId : undefined;
  return <ScopedPresence key={JSON.stringify([scope, conversationId])} {...props} conversationId={conversationId} scope={scope} />;
}

function ScopedPresence({ scope, conversationId, showHome = true, onOpenHome, homeDisabledReason, layout = "compact", ...input }: PresenceProps & { scope?: string }) {
  const presentation = companionPresentation(input);
  const { read, assetFailed, showPortrait, fullBody, motion, intensity, observationRef, posterRef, spriteRef, poster, onPosterError } = useCompanionAtlasPlayer({ scope, conversationId, presentation, greeting: layout === "greeting" && presentation.state === "available" });
  const preferences = read.response?.snapshot.preferences;

  const home = read.response?.home;
  return (
    <section ref={observationRef} className={styles.presence} aria-label="ATLAS companion status" data-testid="companion-presence"
      data-companion-state={presentation.state} data-companion-motion={motion} data-companion-intensity={intensity}
      data-companion-layout={layout}
      data-companion-artwork={fullBody ? "greeting" : "portrait"}
      data-companion-preferences={read.state} data-companion-portrait={showPortrait ? "visible" : assetFailed ? "unavailable" : "hidden"}>
      <details className={styles.disclosure}>
      <summary className={styles.summary}>
      <CompanionAtlasPortrait posterRef={posterRef} spriteRef={spriteRef} showPortrait={showPortrait} poster={poster} fullBody={fullBody} onPosterError={onPosterError}
        className={styles.portrait} imageClassName={styles.image} size={layout === "greeting" ? "72px" : "36px"} />
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
