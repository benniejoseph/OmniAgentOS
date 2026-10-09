import { Activity, Bot, BrainCircuit, CheckCircle2, Cloud, Code2, Settings2, ShieldCheck, UserRound } from "lucide-react";

export type SettingsSection = "general" | "about-me" | "overview" | "providers" | "models" | "agents" | "api" | "data" | "quality" | "monitoring";
export type AdvancedSettingsSection = Exclude<SettingsSection, "general" | "about-me" | "quality" | "monitoring">;

export const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "General", description: "Companion and home", icon: Settings2 },
  { id: "about-me", label: "About me", description: "What ATLAS knows about you", icon: UserRound },
  { id: "overview", label: "Workspace", description: "Readiness and defaults", icon: Settings2 },
  { id: "providers", label: "AI providers", description: "Credentials and catalogs", icon: Cloud },
  { id: "models", label: "Model routing", description: "Assign work by role", icon: BrainCircuit },
  { id: "agents", label: "Agent control", description: "Releases and grants", icon: Bot },
  { id: "api", label: "API & MCP", description: "Programmatic access", icon: Code2 },
  { id: "quality", label: "Quality Checks", description: "Results and release readiness", icon: CheckCircle2 },
  { id: "monitoring", label: "Monitoring", description: "Health, alerts, and incidents", icon: Activity },
  { id: "data", label: "Data & privacy", description: "Ownership and recovery", icon: ShieldCheck },
];

export function settingsSection(value: string | null): SettingsSection {
  return settingsSections.find((section) => section.id === value)?.id ?? "general";
}

export function isAdvancedSettingsSection(section: SettingsSection): section is AdvancedSettingsSection {
  return section !== "general" && section !== "about-me" && section !== "quality" && section !== "monitoring";
}

export function settingsHref(section: SettingsSection) {
  return section === "general" ? "/app/settings" : `/app/settings?section=${section}`;
}
