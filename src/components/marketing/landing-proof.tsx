import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { marketingFaq, trustControls, walkthroughSteps } from "@/lib/marketing-content";
import styles from "./public-surface.module.css";

const destinations = ["/app/command", "/app/workflows", "/app/approvals", "/app/results"] as const;
export function ProductWalkthrough() {
  return <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
    <header className={styles.sectionHeader}><p className={styles.eyebrow}>Find your work</p><h2>Follow the request through the workspace.</h2><p className={styles.reading}>Open the relevant view to inspect your own work. Private workspace links require an approved account.</p></header>
    <ol className={styles.steps}>{walkthroughSteps.map((item, index) => <li key={item.label}><span className={styles.step}>{item.step}</span>
      <Link href={destinations[index]} prefetch={false} className={styles.rowLink}><span className={styles.stack}><strong>{item.label === "Command" ? "Assistant" : item.label}</strong><span className={styles.reading}>{item.body}</span></span><ArrowRight size={18} aria-hidden="true" /></Link>
    </li>)}</ol>
  </div></section>;
}
export function TrustControls() {
  return <section id="security" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
    <header className={styles.sectionHeader}><p className={styles.eyebrow}>Trust and control</p><h2>Review the boundaries around each action.</h2><p className={styles.reading}>Agent work can reach real data and systems, so identity, policy, evidence, and operator decisions remain visible.</p><Link href="/security" prefetch={false} className={styles.button}>Read about security</Link></header>
    <ul className={styles.rows}>{trustControls.map((control) => <li key={control} className={styles.reading}>{control}</li>)}</ul>
  </div></section>;
}
export function MarketingFaq() {
  return <section id="faq" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
    <header className={styles.sectionHeader}><p className={styles.eyebrow}>Frequently asked</p><h2>Before you enter the workspace.</h2></header>
    <div>{marketingFaq.map((item) => <details key={item.question} className={styles.disclosure}><summary>{item.question}</summary><p className={styles.reading}>{item.answer}</p></details>)}</div>
  </div></section>;
}
