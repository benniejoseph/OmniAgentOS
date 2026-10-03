"use client";

import { useEffect } from "react";
import { RecoveryFrame, RecoveryReference } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

export default function CommandError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Command workspace render failed", error);
  }, [error]);

  return (
    <RecoveryFrame id="command-recovery-title" eyebrow="Assistant recovery" title="This conversation could not open">
        <p className={styles.reading}>
          Retry this view at the same address. A display problem does not confirm whether pending work finished; check the conversation and Activity before sending it again.
        </p>
        <p className={styles.support}>An unsent draft may need to be entered again.</p>
        <div className={styles.actions}>
          <button type="button" onClick={() => retry()} className={styles.primaryButton}>
            Retry Assistant
          </button>
          <a href="/app" className={styles.button}>
            Back to Today
          </a>
        </div>
        <RecoveryReference digest={error.digest} />
    </RecoveryFrame>
  );
}
