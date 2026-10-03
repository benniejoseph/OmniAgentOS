import type { ReactNode } from "react";
import Link from "next/link";
import { AsaelMark } from "@/components/brand/asael-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import styles from "./access-recovery.module.css";

/** Login-only frame. The form owns its heading, feedback and request lifecycle. */
export function AccessShell({ children }: { children: ReactNode }) {
  return <div className={styles.access}>
    <a href="#main-content" className={`${styles.button} ${styles.skip}`}>Skip to sign in</a>
    <header className={styles.accessHeader}>
      <Link href="/" prefetch={false} className={styles.brand} aria-label="Asael home">
        <AsaelMark size={36} priority className={styles.mark} /><span>Asael</span>
      </Link>
      <ThemeToggle />
    </header>
    <main id="main-content" tabIndex={-1} className={styles.accessMain}>
      <div className={styles.formRegion}>{children}</div>
    </main>
    <footer className={styles.accessFooter}>
      <p className={styles.support}>Private workspace · Approved accounts only</p>
      <nav aria-label="Sign-in support" className={styles.footerLinks}>
        <Link href="/" prefetch={false}>Back to homepage</Link>
        <Link href="/privacy" prefetch={false}>Privacy</Link>
        <Link href="/terms" prefetch={false}>Terms</Link>
      </nav>
    </footer>
  </div>;
}
