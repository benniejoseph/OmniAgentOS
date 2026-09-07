import type { Metadata } from "next";
import { TodayWorkspace } from "@/components/today-workspace";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showCohesiveTodayService } from "@/lib/app-services/cohesive-today";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";

export const metadata: Metadata = {
  title: "Today",
};

export default async function AppDashboardPage() {
  const session = await getServerWorkspaceSession();
  const context = session.context;
  if (!context) {
    return <TodayWorkspace />;
  }
  const initial = await showCohesiveTodayService(
    createAppServiceCaller({ context }),
    {},
  );

  return <TodayWorkspace initialProjection={initial.data.projection} />;
}
