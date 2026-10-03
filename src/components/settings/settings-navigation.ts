import { Bot, BrainCircuit, Cloud, Code2, Settings2, ShieldCheck } from "lucide-react";

export type SettingsSection = "general" | "overview" | "providers" | "models" | "agents" | "api" | "data";

export const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "General", description: "Companion and home", icon: Settings2 },
  { id: "overview", label: "Workspace", description: "Readiness and defaults", icon: Settings2 },
  { id: "providers", label: "AI providers", description: "Credentials and catalogs", icon: Cloud },
  { id: "models", label: "Model routing", description: "Assign work by role", icon: BrainCircuit },
  { id: "agents", label: "Agent control", description: "Releases and grants", icon: Bot },
  { id: "api", label: "API & MCP", description: "Programmatic access", icon: Code2 },
  { id: "data", label: "Data & privacy", description: "Ownership and recovery", icon: ShieldCheck },
];
