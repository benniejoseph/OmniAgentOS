"use client";

import { useEffect } from "react";
import { RecoveryFrame, RecoveryReference } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

/**
 * Catches a workspace view that fails to render, inside the shell, so the
 * navigation stays usable. Retry fetches the view from the server again.
 */
export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Workspace view failed to render", error);
  }, [error]);

  return (
    <RecoveryFrame id="workspace-recovery-title" eyebrow="Workspace recovery" title="This view could not open">
        <p className={styles.reading}>
          Try loading this view again. If you were saving or running work, check its status after reconnecting before repeating the action.
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={() => retry()} className={styles.primaryButton}>
            Try again
          </button>
          <a href="/app" className={styles.button}>
            Back to Today
          </a>
        </div>
        <RecoveryReference digest={error.digest} />
    </RecoveryFrame>
  );
}
