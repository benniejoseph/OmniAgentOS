import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell/app-shell";
import {
  DESKTOP_NAV_COLLAPSED_COOKIE,
  desktopNavCollapsedFromCookie,
} from "@/components/app-shell/desktop-nav-preference";
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
  const desktopNavCollapsed = desktopNavCollapsedFromCookie(
    (await cookies()).get(DESKTOP_NAV_COLLAPSED_COOKIE)?.value,
  );
  return (
    <WorkspaceSessionProvider initialSession={initialSession}>
      <AppShell banner={<StorageWarning />} initialDesktopNavCollapsed={desktopNavCollapsed}>
        {children}
      </AppShell>
    </WorkspaceSessionProvider>
  );
}
