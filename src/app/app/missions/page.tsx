import type { Metadata } from "next";
import { MissionWorkspace } from "@/components/missions/mission-workspace";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { toMissionDetailView } from "@/lib/missions/public";
import {
  getMissionDetail,
  listMissionSummariesForRequest,
} from "@/lib/missions/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

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
  const requestActorBinding = session.context
    ? canonicalRequestActorBindingFromSecurityContext(session.context)
    : undefined;
  return runWithDatabaseTenantScope(tenantId, async () => {
    // Vercel intentionally runs each tenant-scoped database client with one
    // connection. Start each independent read only after the prior one has
    // released its reservation instead of making their acquisition deadlines
    // race one another during a cold render.
    let missions = await listMissionSummariesForRequest(50, {
      tenantId,
      actorId,
      requestActorBinding,
    });
    const capabilityResult = await searchCapabilities({ tenantId, limit: 50 });
    const selected = missions[0];
    let detail: Awaited<ReturnType<typeof getMissionDetail>> | undefined;
    let initialEventCursor = 0;
    if (selected?.detailAvailable === true) {
      detail = await getMissionDetail(selected.id, { tenantId, actorId }, {
        tasks: 100,
        attempts: 250,
        artifacts: 150,
      });
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
      initialDetail: detail ? toMissionDetailView(detail) : undefined,
      initialMissionReadContract: "readable_v1" as const,
      initialEventCursor,
    };
  });
}
