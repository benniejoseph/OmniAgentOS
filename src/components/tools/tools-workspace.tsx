import Link from "next/link";
import { Cable, ShieldCheck, Wrench } from "lucide-react";
import { DomainConsole } from "@/components/app-shell/domain-console";
import styles from "./tools-workspace.module.css";

export function ToolsWorkspace() {
  return (
    <div className={styles.workspace}>
      <nav className={styles.sectionNav} aria-label="Capability administration">
        <div className={styles.sectionIdentity}>
          <span><Wrench size={17} aria-hidden="true" /></span>
          <div>
            <strong>Capability control</strong>
            <small>What agents can use and how calls are governed</small>
          </div>
        </div>
        <div className={styles.sectionLinks}>
          <span aria-current="page">Tools</span>
          <Link href="/app/connectors"><Cable size={14} aria-hidden="true" />Integrations</Link>
          <Link href="/app/approvals"><ShieldCheck size={14} aria-hidden="true" />Approvals</Link>
        </div>
      </nav>
      <DomainConsole domain="tools" />
    </div>
  );
}
