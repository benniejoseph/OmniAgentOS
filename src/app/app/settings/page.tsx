import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <FeaturePage pageKey="settings" />;
}
