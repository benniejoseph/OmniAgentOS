import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell/app-shell";
import { StorageWarning } from "@/components/app-shell/storage-warning";

export const metadata: Metadata = {
  title: "App",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell banner={<StorageWarning />}>{children}</AppShell>;
}
