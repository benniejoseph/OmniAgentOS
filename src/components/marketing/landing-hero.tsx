import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicHealthBadge } from "./public-health-badge";
import { marketingActions } from "@/lib/marketing-content";
import styles from "./public-surface.module.css";

export function LandingHero() {
  return <section className={styles.hero} aria-labelledby="landing-title">
    <div className={styles.container}><div className={styles.heroContent}>
      <p className={styles.eyebrow}>Asael · Your personal AI partner</p>
      <h1 id="landing-title">Make room for the work that matters.</h1>
      <p className={styles.reading}>Bring your projects, context, and commitments into one place. Ask Asael to help, follow its progress, and review what needs your decision.</p>
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
