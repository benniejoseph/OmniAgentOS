"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { CompanionPreferences } from "@/components/companion-preferences";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { settingsSections, type SettingsSection } from "./settings-navigation";
import styles from "./settings-workspace.module.css";

// Provider, grant and recovery controllers load only after an advanced category
// is requested. Once opened they remain mounted across local category changes.
const AdvancedSettingsWorkspace = dynamic(() => import("./settings-advanced-workspace").then((module) => module.AdvancedSettingsWorkspace), {
  loading: () => <p className={styles.generalShell} role="status">Loading workspace controls…</p>,
});

export function SettingsWorkspace() {
  const { session } = useWorkspaceSession();
  return <ScopedSettingsWorkspace key={JSON.stringify([session?.context?.tenantId, session?.context?.actorId, session?.membership?.role ?? session?.context?.role])} />;
}

function ScopedSettingsWorkspace() {
  const [section, setSection] = useState<SettingsSection>("general");
  const [advancedSection, setAdvancedSection] = useState<Exclude<SettingsSection, "general">>();
  const navigate = (next: SettingsSection) => {
    if (next !== "general") setAdvancedSection(next);
    setSection(next);
  };
  return <>
    <section className={styles.generalShell} hidden={section !== "general"}>
      <header className={styles.generalHeader}><h1>Settings</h1><p>General preferences for your account. Advanced workspace controls remain available below.</p></header>
      <div className={styles.generalLayout}>
        <nav className={styles.generalNavigation} aria-label="Settings categories">
          {settingsSections.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} type="button" onClick={() => navigate(item.id)} className={styles.generalNavItem} aria-current={item.id === "general" ? "page" : undefined}>
              <Icon size={17} aria-hidden="true" /><span><span className="block text-sm font-semibold">{item.label}</span><span className="mt-0.5 hidden text-xs text-muted xl:block">{item.description}</span></span>
            </button>;
          })}
        </nav>
        <div className={styles.content}><CompanionPreferences /></div>
      </div>
    </section>
    {advancedSection ? <div hidden={section === "general"}><AdvancedSettingsWorkspace section={advancedSection} onNavigate={navigate} /></div> : null}
  </>;
}
