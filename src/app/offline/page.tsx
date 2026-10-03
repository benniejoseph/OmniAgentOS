import type { Metadata } from "next";
import { RecoveryFrame } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

export const metadata: Metadata = { title: "Connection unavailable", robots: { index: false, follow: false } };

export default function OfflinePage() {
  return <RecoveryFrame standalone id="offline-title" eyebrow="Connection unavailable" title="You are offline.">
    <p className={styles.reading}>This page needs a connection. Reconnect, then try opening the workspace again.</p>
    <p className={styles.reading}>A Capture page that is already open can save notes on this device. Check for its saved confirmation. Queued notes wait to sync for the same account and workspace when the connection returns.</p>
    <p className={styles.support}>This fallback cannot confirm your queue or the status of work already sent. Keep any open Capture page available; the full workspace is not available offline.</p>
    <div className={styles.actions}><a href="/app" className={styles.primaryButton}>Try again</a></div>
  </RecoveryFrame>;
}
