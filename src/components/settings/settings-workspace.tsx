"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CompanionPreferences } from "@/components/companion-preferences";
import { PersonalContextProfile } from "@/components/personal-context-profile";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { isAdvancedSettingsSection, settingsHref, settingsSection, settingsSections, type AdvancedSettingsSection, type SettingsSection } from "./settings-navigation";
import styles from "./settings-workspace.module.css";

// Provider, grant and recovery controllers load only after an advanced category
// is requested. Once opened they remain mounted across local category changes.
const AdvancedSettingsWorkspace = dynamic(() => import("./settings-advanced-workspace").then((module) => module.AdvancedSettingsWorkspace), {
  loading: () => <p role="status">Loading workspace controls…</p>,
});
const QualityWorkspace = dynamic(() => import("@/components/operations-console/quality-workspace").then((module) => module.QualityWorkspace), {
  loading: () => <p role="status">Loading quality checks…</p>,
});
const MonitoringWorkspace = dynamic(() => import("@/components/operations-console/monitoring-workspace").then((module) => module.MonitoringWorkspace), {
  loading: () => <p role="status">Loading monitoring…</p>,
});

export function SettingsWorkspace() {
  const { session } = useWorkspaceSession();
  return <ScopedSettingsWorkspace key={JSON.stringify([session?.context?.tenantId, session?.context?.actorId, session?.membership?.role ?? session?.context?.role])} />;
}

function ScopedSettingsWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = settingsSection(searchParams.get("section"));
  const isAdvanced = isAdvancedSettingsSection(section);
  const [advancedSection, setAdvancedSection] = useState<AdvancedSettingsSection | undefined>(isAdvanced ? section : undefined);
  const [profileOpened, setProfileOpened] = useState(section === "about-me");
  // Keep in-flight configuration actions and drafts across category changes.
  // Operational views are mounted only while their category is selected.
  if (isAdvanced && advancedSection !== section) setAdvancedSection(section);
  if (section === "about-me" && !profileOpened) setProfileOpened(true);
  const navigate = (next: SettingsSection) => {
    router.push(settingsHref(next), { scroll: false });
  };
  return <section className={styles.generalShell}>
      <header className={styles.generalHeader}><h1>Settings</h1><p>Manage your preferences, workspace configuration, quality checks, and system health.</p></header>
      <div className={styles.generalLayout}>
        <nav className={styles.generalNavigation} aria-label="Settings categories">
          {settingsSections.map((item) => {
            const Icon = item.icon;
            return <Link key={item.id} href={settingsHref(item.id)} scroll={false} prefetch={false} className={styles.generalNavItem} aria-current={item.id === section ? "page" : undefined}>
              <Icon size={17} aria-hidden="true" /><span><span className="block text-sm font-semibold">{item.label}</span><span className="mt-0.5 hidden text-xs text-muted xl:block">{item.description}</span></span>
            </Link>;
          })}
        </nav>
        <div className={styles.content}>
          <div hidden={section !== "general"}><CompanionPreferences /></div>
          {profileOpened ? <div hidden={section !== "about-me"}><PersonalContextProfile /></div> : null}
          {advancedSection ? <div hidden={!isAdvanced}><AdvancedSettingsWorkspace section={advancedSection} onNavigate={navigate} embedded /></div> : null}
          {section === "quality" ? <QualityWorkspace embedded /> : null}
          {section === "monitoring" ? <MonitoringWorkspace embedded /> : null}
        </div>
      </div>
    </section>;
}
