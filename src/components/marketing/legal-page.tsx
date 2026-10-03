import { PublicFrame } from "./public-frame";
import styles from "./public-surface.module.css";

type LegalSection = { title: string; paragraphs: string[] };

export function LegalPage({ eyebrow, title, summary, sections }: {
  eyebrow: string; title: string; summary: string; sections: LegalSection[];
}) {
  return <PublicFrame>
    <header className={styles.hero}>
      <div className={styles.container}><div className={styles.heroContent}>
        <p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1>
        <p className={styles.reading}>{summary}</p><p className={styles.support}>Effective August 25, 2026</p>
      </div></div>
    </header>
    <div className={styles.section}><div className={`${styles.container} ${styles.readingLayout}`}>
      <nav aria-label={`${title} sections`} className={styles.contents}><h2>On this page</h2><ol>
        {sections.map((section, index) => <li key={section.title}><a href={`#legal-section-${index + 1}`}>{section.title}</a></li>)}
      </ol></nav>
      <article aria-label={title} className={styles.legalSections}>
        {sections.map((section, index) => <section key={section.title} id={`legal-section-${index + 1}`} className={styles.legalSection}>
          <h2>{section.title}</h2>{section.paragraphs.map((paragraph) => <p className={styles.reading} key={paragraph}>{paragraph}</p>)}
        </section>)}
      </article>
    </div></div>
  </PublicFrame>;
}
