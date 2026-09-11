import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MissionWorkspace } from "@/components/missions/mission-workspace";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listMissionsService,
  showMissionService,
} from "@/lib/app-services/missions";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";

export const metadata: Metadata = { title: "Missions" };

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (query.legacy !== "1") redirect("/app/projects?view=execution");
  const initial = await loadMissionWorkspace();
  return <MissionWorkspace legacyHistory {...initial} />;
}

async function loadMissionWorkspace() {
  const session = await getServerWorkspaceSession();
  const tenantId = session.context?.tenantId;
  const actorId = session.context?.actorId;
  if (!tenantId || !actorId) {
    return { initialMissions: [], initialCapabilities: [] };
  }
  return runWithDatabaseTenantScope(tenantId, async () => {
    // Vercel intentionally runs each tenant-scoped database client with one
    // connection. Start each independent read only after the prior one has
    // released its reservation instead of making their acquisition deadlines
    // race one another during a cold render.
    const caller = createAppServiceCaller({ context: session.context! });
    const missionResult = await listMissionsService(caller, {
      limit: 50,
      ownerScope: "readable",
    });
    let missions = missionResult.data.missions;
    const capabilityResult = await searchCapabilities({ tenantId, limit: 50 });
    const selected = missions[0];
    let detail;
    let initialEventCursor = 0;
    if (selected?.detailAvailable === true) {
      const detailResult = await showMissionService(caller, {
        missionId: selected.id,
        view: "detail",
        tasks: 100,
        attempts: 200,
        artifacts: 150,
      });
      detail = detailResult.data && "tasks" in detailResult.data
        ? detailResult.data
        : undefined;
      if (!detail) {
        missions = missions.filter((mission) => mission.id !== selected.id);
      }
      const latest = detail ? await listStreamEvents(`mission:${selected.id}`, {
        tenantId,
        actorId,
        limit: 1,
        order: "desc",
      }) : [];
      initialEventCursor = latest[0]?.seq || 0;
    }
    return {
      initialMissions: missions,
      initialCapabilities: capabilityResult.capabilities,
      initialDetail: detail,
      initialMissionReadContract: "readable_v1" as const,
      initialEventCursor,
    };
  });
}
