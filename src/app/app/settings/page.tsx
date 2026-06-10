import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <DomainConsole domain="settings" />;
}
