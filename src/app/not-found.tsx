import type { Metadata } from "next";
import Link from "next/link";
import { RecoveryFrame } from "@/components/access-recovery/recovery-frame";
import styles from "@/components/access-recovery/access-recovery.module.css";

export const metadata: Metadata = { title: { absolute: "Page not found | Asael" } };

export default function NotFound() {
  return <RecoveryFrame standalone id="not-found-title" eyebrow="404 · Page not found" title="This address has no page">
    <p className={styles.reading}>Check the link for a missing or extra character, or use one of these destinations.</p>
    <div className={styles.actions}>
      <Link prefetch={false} href="/app" className={styles.primaryButton}>Open workspace</Link>
      <Link prefetch={false} href="/" className={styles.button}>Back to homepage</Link>
    </div>
    <p className={styles.support}>Private workspace pages require an approved account.</p>
  </RecoveryFrame>;
}
