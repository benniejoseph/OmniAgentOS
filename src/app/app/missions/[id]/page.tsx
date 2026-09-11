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
    return <MissionWorkspace legacyHistory initialMissionId={id} initialMissions={[]} initialCapabilities={[]} />;
  }
  const initial = await runWithDatabaseTenantScope(tenantId, async () => {
    // These reads share a deliberately single-slot serverless database pool.
    // Keep them sequential so queued work does not burn its own acquisition
    // deadline while an earlier reservation is still active.
    const caller = createAppServiceCaller({ context: session.context! });
    const missionResult = await listMissionsService(caller, {
      limit: 50,
      ownerScope: "readable",
    });
    let missions = missionResult.data.missions;
    const capabilityResult = await searchCapabilities({ tenantId, limit: 50 });
    let selected = missions.find((mission) => mission.id === id);
    let detail;
    if (!selected) {
      // The bounded catalog is not proof that an absent deep link is missing.
      // Re-resolve only its public summary across the request-readable owner
      // pair before deciding whether an exact full-detail read is permitted.
      const summaryResult = await showMissionService(caller, {
        missionId: id,
        view: "readable_summary",
      });
      selected = summaryResult.data && "mission" in summaryResult.data
        ? summaryResult.data.mission || undefined
        : undefined;
      if (!selected) return undefined;
      missions = [selected, ...missions.filter((mission) => mission.id !== id)];
    }
    if (selected.detailAvailable === true) {
      const detailResult = await showMissionService(caller, {
        missionId: id,
        view: "detail",
        tasks: 100,
        attempts: 200,
        artifacts: 150,
      });
      detail = detailResult.data && "tasks" in detailResult.data
        ? detailResult.data
        : undefined;
      if (!detail) return undefined;
      selected = detail.mission;
      missions = [selected, ...missions.filter((mission) => mission.id !== id)];
    }
    const latestEvents = selected?.detailAvailable === true && detail
      ? await listStreamEvents(`mission:${id}`, {
          tenantId,
          actorId,
          limit: 1,
          order: "desc",
        })
      : [];
    return {
      initialMissions: missions,
      initialCapabilities: capabilityResult.capabilities,
      initialDetail: detail,
      initialMissionReadContract: "readable_v1" as const,
      initialEventCursor: latestEvents[0]?.seq || 0,
    };
  });
  if (!initial) redirect("/app/projects?view=execution");
  return <MissionWorkspace legacyHistory initialMissionId={id} {...initial} />;
}
