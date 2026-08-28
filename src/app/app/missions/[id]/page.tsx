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
    // These reads share a deliberately single-slot serverless database pool.
    // Keep them sequential so queued work does not burn its own acquisition
    // deadline while an earlier reservation is still active.
    const missions = await listMissions(50, { tenantId, actorId });
    const capabilityResult = await searchCapabilities({ tenantId, limit: 50 });
    const latestEvents = await listStreamEvents(`mission:${id}`, {
      tenantId,
      actorId,
      limit: 1,
      order: "desc",
    });
    const detail = await getMissionDetail(id, { tenantId, actorId }, {
      tasks: 100,
      attempts: 250,
      artifacts: 150,
    });
    return {
      initialMissions: missions.map(toMissionSummaryView),
      initialCapabilities: capabilityResult.capabilities,
      initialDetail: detail ? toMissionDetailView(detail) : undefined,
      initialEventCursor: latestEvents[0]?.seq || 0,
    };
  });
  return <MissionWorkspace initialMissionId={id} {...initial} />;
}
