import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
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
  let initial: Awaited<ReturnType<typeof showCohesiveTodayService>>;
  try {
    initial = await showCohesiveTodayService(
      createAppServiceCaller({ context }),
      {},
    );
  } catch (error) {
    unstable_rethrow(error);
    // Today still opens and loads itself in the browser, which shows a
    // failure in place and keeps retrying.
    console.error(
      "Today could not be prepared on the server.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return <TodayWorkspace />;
  }

  return <TodayWorkspace initialProjection={initial.data.projection} />;
}
