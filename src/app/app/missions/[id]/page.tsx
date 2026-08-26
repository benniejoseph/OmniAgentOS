import type { Metadata } from "next";
import { MissionWorkspace } from "@/components/missions/mission-workspace";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { toMissionDetailView, toMissionSummaryView } from "@/lib/missions/public";
import { getMissionDetail, listMissions } from "@/lib/missions/store";

export const metadata: Metadata = { title: "Mission" };

export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerWorkspaceSession();
  const tenantId = session.context?.tenantId;
  const actorId = session.context?.actorId;
  if (!tenantId || !actorId) {
    return <MissionWorkspace initialMissionId={id} initialMissions={[]} initialCapabilities={[]} />;
  }
  const initial = await runWithDatabaseTenantScope(tenantId, async () => {
    const eventCursorPromise = listStreamEvents(`mission:${id}`, {
      tenantId,
      actorId,
      limit: 1,
      order: "desc",
    });
    const detailPromise = eventCursorPromise.then(() =>
      getMissionDetail(id, { tenantId, actorId }, { tasks: 30, attempts: 100, artifacts: 50 })
    );
    const [missions, capabilityResult, latestEvents, detail] = await Promise.all([
      listMissions(50, { tenantId, actorId }),
      searchCapabilities({ tenantId, limit: 50 }),
      eventCursorPromise,
      detailPromise,
    ]);
    return {
      initialMissions: missions.map(toMissionSummaryView),
      initialCapabilities: capabilityResult.capabilities,
      initialDetail: detail ? toMissionDetailView(detail) : undefined,
      initialEventCursor: latestEvents[0]?.seq || 0,
    };
  });
  return <MissionWorkspace initialMissionId={id} {...initial} />;
}
