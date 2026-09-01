import Link from "next/link";
import { Cable, ShieldCheck, Wrench } from "lucide-react";
import { DomainConsole } from "@/components/app-shell/domain-console";
import styles from "./integrations-workspace.module.css";

export function IntegrationsWorkspace() {
  return (
    <div className={styles.workspace}>
      <nav className={styles.sectionNav} aria-label="Capability administration">
        <div className={styles.sectionIdentity}>
          <span><Cable size={17} aria-hidden="true" /></span>
          <div>
            <strong>Connected systems</strong>
            <small>Personal sources, MCP servers, and external APIs</small>
          </div>
        </div>
        <div className={styles.sectionLinks}>
          <Link href="/app/tools"><Wrench size={14} aria-hidden="true" />Tools</Link>
          <span aria-current="page">Integrations</span>
          <Link href="/app/approvals"><ShieldCheck size={14} aria-hidden="true" />Approvals</Link>
        </div>
      </nav>
      <DomainConsole domain="integrations" />
    </div>
  );
}
