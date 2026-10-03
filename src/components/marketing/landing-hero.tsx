import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicHealthBadge } from "./public-health-badge";
import { marketingActions } from "@/lib/marketing-content";
import styles from "./public-surface.module.css";

export function LandingHero() {
  return <section className={styles.hero} aria-labelledby="landing-title">
    <div className={styles.container}><div className={styles.heroContent}>
      <p className={styles.eyebrow}>Asael · Private AI workspace</p>
      <h1 id="landing-title">Give agents goals. Keep the controls.</h1>
      <p className={styles.reading}>Plan, supervise, approve, and verify AI work in one focused workspace—with durable memory and evidence at every step.</p>
      <div className={styles.actions}>
        <Link href={marketingActions.signIn.href} prefetch={false} className={styles.primaryButton}>{marketingActions.signIn.label}<ArrowRight size={16} aria-hidden="true" /></Link>
        <Link href={marketingActions.demo.href} prefetch={false} className={styles.button}>Explore simulated demo</Link>
        <Link href="/docs" prefetch={false} className={styles.button}>Read the guide</Link>
      </div>
      <p className={styles.support}>Approved private accounts. No public registration. The demo uses sample content.</p>
      <PublicHealthBadge />
    </div></div>
  </section>;
}
