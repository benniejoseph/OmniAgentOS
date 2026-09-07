import type { Metadata } from "next";
import { TodayWorkspace } from "@/components/today-workspace";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showCohesiveTodayService } from "@/lib/app-services/cohesive-today";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { runWithDatabaseTenantScope } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "Today",
};

export default async function AppDashboardPage() {
  const session = await getServerWorkspaceSession();
  const tenantId = session.context?.tenantId;
  if (!tenantId || !session.context) {
    return <TodayWorkspace />;
  }

  const initial = await runWithDatabaseTenantScope(
    tenantId,
    () => showCohesiveTodayService(
      createAppServiceCaller({ context: session.context! }),
      {},
    ),
  );

  return <TodayWorkspace initialProjection={initial.data.projection} />;
}
