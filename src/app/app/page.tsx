import type { Metadata } from "next";
import { TodayWorkspace } from "@/components/today-workspace";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showCohesiveTodayService } from "@/lib/app-services/cohesive-today";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const metadata: Metadata = {
  title: "Today",
};

export default async function AppDashboardPage() {
  const session = await getServerWorkspaceSession();
  const context = session.context;
  if (!context) {
    return <TodayWorkspace />;
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);

  const initial = await runWithDatabaseActorScope(
    context.tenantId,
    actorBinding?.readableOwnerActorIds || [context.actorId],
    () => showCohesiveTodayService(
      createAppServiceCaller({ context }),
      {},
    ),
  );

  return <TodayWorkspace initialProjection={initial.data.projection} />;
}
