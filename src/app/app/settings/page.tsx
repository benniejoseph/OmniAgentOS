import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <Suspense fallback={<p className="p-6 text-muted" role="status">Loading settings…</p>}><SettingsWorkspace /></Suspense>;
}
