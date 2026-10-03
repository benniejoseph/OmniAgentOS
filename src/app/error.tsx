"use client";

import { useEffect } from "react";
import { RecoveryFrame, RecoveryReference } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error("Asael page failed to render", error); }, [error]);
  return <RecoveryFrame standalone id="page-recovery-title" eyebrow="Page recovery" title="This page could not open">
    <title>Page unavailable | Asael</title>
    <p className={styles.reading}>Try loading this page again at the same address, or return to the homepage.</p>
    <p className={styles.support}>If an action was in progress, check its status before repeating it.</p>
    <div className={styles.actions}>
      <button type="button" onClick={() => retry()} className={styles.primaryButton}>Try again</button>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- A full document load can recover a failed client router. */}
          <a href="/" className={styles.button}>Back to homepage</a>
    </div>
    <RecoveryReference digest={error.digest} />
  </RecoveryFrame>;
}
