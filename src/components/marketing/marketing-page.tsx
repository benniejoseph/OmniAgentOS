import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicFrame } from "./public-frame";
import { appNav, marketingPages } from "@/lib/navigation";
import styles from "./public-surface.module.css";

type MarketingPageKey = keyof typeof marketingPages;

export function MarketingPage({ pageKey }: { pageKey: MarketingPageKey }) {
  const page = marketingPages[pageKey];
  return <PublicFrame>
    <header className={styles.hero}><div className={styles.container}><div className={styles.heroContent}>
      <p className={styles.eyebrow}>{page.eyebrow}</p>
      <h1>{pageKey === "changelog" ? "Platform changes and operating notes." : page.headline}</h1>
      <p className={styles.reading}>{page.summary}</p>
      <div className={styles.actions}><Link href="/login" prefetch={false} className={styles.primaryButton}>Sign in<ArrowRight size={16} aria-hidden="true" /></Link><Link href="/demo" prefetch={false} className={styles.button}>Explore simulated demo</Link></div>
      <p className={styles.support}>Privately operated. Approved accounts only. No public registration or checkout.</p>
    </div></div></header>
    <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><h2>{pageKey === "changelog" ? "Recorded changes" : pageKey === "pricing" ? "Current availability" : pageKey === "security" ? "Platform controls" : "What the workspace supports"}</h2>
        {pageKey === "changelog" ? <p className={styles.support}>Notes appear in their recorded order. Release dates are not provided in this public summary.</p> : null}
        {pageKey === "security" ? <p className={styles.reading}>This page describes platform controls. It does not report the live security posture of a private workspace.</p> : null}
      </header>
      <ol className={styles.steps}>{page.sections.map((section, index) => <li key={section}><span className={styles.step}>{String(index + 1).padStart(2, "0")}</span><p className={styles.reading}>{section}</p></li>)}</ol>
    </div></section>
    <section className={styles.section}><div className={styles.container}>
      <header className={styles.sectionHeader}><h2>Continue in the workspace</h2><p className={styles.reading}>These views require private account access. The guide explains how each part fits into a governed workflow.</p><div className={styles.actions}><Link href="/docs" prefetch={false} className={styles.button}>Read the guide</Link></div></header>
      <ul className={`${styles.rows} ${styles.columns}`}>{appNav.slice(2, 10).map((item) => <li key={item.href}><Link href={item.href} prefetch={false} className={styles.rowLink}><span className={styles.stack}><strong>{item.label}</strong><span className={styles.reading}>{item.description}</span></span><ArrowRight size={18} aria-hidden="true" /></Link></li>)}</ul>
    </div></section>
  </PublicFrame>;
}
