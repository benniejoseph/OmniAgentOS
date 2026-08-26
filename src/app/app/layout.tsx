import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell/app-shell";
import { WorkspaceSessionProvider } from "@/components/app-shell/session-context";
import { StorageWarning } from "@/components/app-shell/storage-warning";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";

export const metadata: Metadata = {
  title: "App",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const initialSession = await getServerWorkspaceSession();
  if (initialSession.authEnabled && !initialSession.authenticated) {
    redirect("/login");
  }
  return (
    <WorkspaceSessionProvider initialSession={initialSession}>
      <AppShell banner={<StorageWarning />}>{children}</AppShell>
    </WorkspaceSessionProvider>
  );
}
