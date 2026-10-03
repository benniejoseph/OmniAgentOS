"use client";

import { useEffect } from "react";
import { RecoveryFrame, RecoveryReference } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

/**
 * Replaces the whole document when the root layout itself fails. It carries
 * its own scoped CSS, system fonts, and an OS light/dark fallback palette.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Asael failed to render", error);
  }, [error]);

  return (
    <html lang="en" className={styles.document}>
      <body className={styles.body}>
        <title>Asael is unavailable</title>
        <RecoveryFrame standalone id="global-recovery-title" eyebrow="Asael recovery" title="Asael could not open">
          <p className={styles.reading}>
            Something went wrong while loading the app. Try again at this address, or return to the homepage.
          </p>
          <p className={styles.support}>If you were saving or running work, check its status when the app opens before repeating the action.</p>
          <div className={styles.actions}>
          <button type="button" onClick={() => retry()} className={styles.primaryButton}>
            Try again
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- A full document load can recover a failed client router. */}
          <a href="/" className={styles.button}>Back to homepage</a>
          </div>
          <RecoveryReference digest={error.digest} />
        </RecoveryFrame>
      </body>
    </html>
  );
}
