import type { ReactNode } from "react";
import styles from "./access-recovery.module.css";

export function RecoveryFrame({
  id, title, eyebrow, standalone = false, children,
}: {
  id: string;
  title: string;
  eyebrow: string;
  standalone?: boolean;
  children: ReactNode;
}) {
  const Element = standalone ? "main" : "section";
  return <Element className={`${styles.recovery} ${standalone ? styles.standalone : styles.inset}`} aria-labelledby={id}>
    <div className={styles.recoveryContent}>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- This frame also runs outside the failed root layout and router. */}
      {standalone ? <a href="/" className={styles.brand} aria-label="Asael home">Asael</a> : null}
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 id={id} className={styles.title}>{title}</h1>
      {children}
    </div>
  </Element>;
}

export function RecoveryReference({ digest }: { digest?: string }) {
  return typeof digest === "string" && digest.length > 0
    ? <p className={styles.support}>Error reference: <code className={styles.identifier}>{digest}</code></p>
    : null;
}

export function RecoveryLoading({ title, description }: { title: string; description: string }) {
  return <section className={styles.loading} role="status" aria-busy="true">
    <h1 className={styles.title}>{title}</h1>
    <p className={styles.reading}>{description}</p>
    <div className={styles.loadingLines} aria-hidden="true"><span /><span /><span /></div>
  </section>;
}
