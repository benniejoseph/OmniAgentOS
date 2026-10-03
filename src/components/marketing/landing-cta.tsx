import Link from "next/link";
import { marketingActions } from "@/lib/marketing-content";
import styles from "./public-surface.module.css";

export function PrivateWorkspaceCta() {
  return <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
    <div className={styles.stack}><h2>Open your private workspace.</h2><p className={styles.reading}>Approved private accounts · Google or password access · No public registration</p></div>
    <div className={styles.actions}><Link href={marketingActions.signIn.href} prefetch={false} className={styles.primaryButton}>{marketingActions.signIn.label}</Link>
      <Link href={marketingActions.demo.href} prefetch={false} className={styles.button}>Explore simulated demo</Link></div>
  </div></section>;
}
