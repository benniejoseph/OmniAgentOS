import { homepageCapabilities, operatingLoop, productFacts } from "@/lib/marketing-content";
import styles from "./public-surface.module.css";

export function ProductFacts() {
  return <section aria-label="Product facts" className={styles.container}><ul className={styles.facts}>
    {productFacts.filter((fact) => fact.value !== "Live").map((fact) => <li key={fact.label}><span className={styles.factValue}>{fact.value}</span><span className={styles.support}>{fact.label}</span></li>)}
    <li><span className={styles.factValue}>Private</span><span className={styles.support}>Approved accounts only</span></li>
  </ul></section>;
}
export function OperatingLoop() {
  return <section id="workflow" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
    <header className={styles.sectionHeader}><p className={styles.eyebrow}>Operating loop</p><h2>From goal to evidence.</h2><p className={styles.reading}>Define the work, follow its progress, and review actions and results in context.</p></header>
    <ol className={styles.steps}>{operatingLoop.map((item) => <li key={item.title}><span className={styles.step}>{item.step}</span><div className={styles.stack}><h3>{item.title}</h3><p className={styles.reading}>{item.body}</p></div></li>)}</ol>
  </div></section>;
}
export function CapabilityGrid() {
  return <section id="platform" className={styles.section}><div className={styles.container}>
    <header className={styles.sectionHeader}><p className={styles.eyebrow}>Platform capabilities</p><h2>Context, action, and review in one workspace.</h2></header>
    <ul className={`${styles.rows} ${styles.columns}`}>{homepageCapabilities.map((item) => <li key={item.title}><div className={styles.stack}><h3>{item.title}</h3><p className={styles.reading}>{item.body}</p></div></li>)}</ul>
  </div></section>;
}
