import Link from "next/link";
import { Cable, ChevronDown, ShieldCheck, Wrench } from "lucide-react";
import { DomainConsole } from "@/components/app-shell/domain-console";
import { IntegrationTruthPanel } from "@/components/integrations/integration-truth-panel";
import { SourceCoveragePanel } from "@/components/source-coverage/source-coverage-panel";
import styles from "./integrations-workspace.module.css";

export function IntegrationsWorkspace() {
  return (
    <div className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div className={styles.pageIdentity}>
          <span className={styles.pageIcon}><Cable size={20} aria-hidden="true" /></span>
          <div>
            <h1>Integrations</h1>
            <p>Control the systems Asael can read from or act in, and see what needs attention.</p>
          </div>
        </div>
        <nav className={styles.pageLinks} aria-label="Integration administration">
          <Link href="/app/tools"><Wrench size={15} aria-hidden="true" />Tools</Link>
          <span aria-current="page"><Cable size={15} aria-hidden="true" />Integrations</span>
          <Link href="/app/approvals"><ShieldCheck size={15} aria-hidden="true" />Approvals</Link>
        </nav>
      </header>

      <IntegrationTruthPanel>
        <section className={styles.coverageSection} aria-labelledby="coverage-disclosure-title">
          <details>
            <summary>
              <span className={styles.coverageSummaryIcon}><ShieldCheck size={18} aria-hidden="true" /></span>
              <span className={styles.coverageSummaryCopy}>
                <strong id="coverage-disclosure-title">Knowledge coverage</strong>
                <small>See which connected content is searchable by Asael, what has been indexed, and why a source may be unknown.</small>
              </span>
              <span className={styles.coverageSummaryAction}>View coverage <ChevronDown size={16} aria-hidden="true" /></span>
            </summary>
            <div className={styles.coverageBody}>
              <SourceCoveragePanel surface="integrations" />
            </div>
          </details>
        </section>

        <DomainConsole domain="integrations" presentation="embedded" />
      </IntegrationTruthPanel>
    </div>
  );
}
