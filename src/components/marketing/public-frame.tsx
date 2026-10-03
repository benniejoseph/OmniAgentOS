import Link from "next/link";
import type { ReactNode } from "react";
import { PublicHeader } from "./public-header";
import styles from "./public-surface.module.css";

const footerLinks = [
  ["/platform", "Platform"], ["/solutions", "Solutions"], ["/pricing", "Private availability"], ["/security", "Security"],
  ["/docs", "Docs"], ["/changelog", "Changelog"], ["/privacy", "Privacy"], ["/terms", "Terms"], ["/demo", "Simulated demo"],
] as const;

export function PublicFrame({ children }: { children: ReactNode }) {
  return <div className={styles.page} data-testid="public-page">
    <a href="#main-content" className={`${styles.primaryButton} ${styles.skip}`}>Skip to content</a>
    <PublicHeader inFlow />
    <main id="main-content" tabIndex={-1}>{children}</main>
    <footer className={styles.footer}>
      <div className={`${styles.container} ${styles.footerInner}`}>
        <div className={styles.stack}><Link href="/" prefetch={false} className={styles.brand}>Asael</Link><p className={styles.support}>Privately operated. Approved accounts only.</p></div>
        <nav aria-label="Public footer" className={styles.footerLinks}>{footerLinks.map(([href, label]) => <Link key={href} href={href} prefetch={false}>{label}</Link>)}</nav>
      </div>
    </footer>
  </div>;
}
