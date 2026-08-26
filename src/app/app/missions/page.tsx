import type { Metadata } from "next";
import { MissionWorkspace } from "@/components/missions/mission-workspace";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { toMissionDetailView, toMissionSummaryView } from "@/lib/missions/public";
import { getMissionDetail, listMissions } from "@/lib/missions/store";

export const metadata: Metadata = { title: "Missions" };

export default async function MissionsPage() {
  const initial = await loadMissionWorkspace();
  return <MissionWorkspace {...initial} />;
}

async function loadMissionWorkspace() {
  const session = await getServerWorkspaceSession();
  const tenantId = session.context?.tenantId;
  const actorId = session.context?.actorId;
  if (!tenantId || !actorId) {
    return { initialMissions: [], initialCapabilities: [] };
  }
  return runWithDatabaseTenantScope(tenantId, async () => {
    const [missions, capabilityResult] = await Promise.all([
      listMissions(50, { tenantId, actorId }),
      searchCapabilities({ tenantId, limit: 50 }),
    ]);
    const selected = missions[0];
    let detail: Awaited<ReturnType<typeof getMissionDetail>>;
    let initialEventCursor = 0;
    if (selected) {
      const latest = await listStreamEvents(`mission:${selected.id}`, {
        tenantId,
        actorId,
        limit: 1,
        order: "desc",
      });
      initialEventCursor = latest[0]?.seq || 0;
      detail = await getMissionDetail(selected.id, { tenantId, actorId }, { tasks: 30, attempts: 100, artifacts: 50 });
    }
    return {
      initialMissions: missions.map(toMissionSummaryView),
      initialCapabilities: capabilityResult.capabilities,
      initialDetail: detail ? toMissionDetailView(detail) : undefined,
      initialEventCursor,
    };
  });
}
