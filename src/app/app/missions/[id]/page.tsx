import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MissionWorkspace } from "@/components/missions/mission-workspace";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { toMissionDetailView, toMissionSummaryView } from "@/lib/missions/public";
import {
  getMissionDetail,
  getMissionSummaryForRequest,
  listMissionSummariesForRequest,
} from "@/lib/missions/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

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
  const requestActorBinding = session.context
    ? canonicalRequestActorBindingFromSecurityContext(session.context)
    : undefined;
  const initial = await runWithDatabaseTenantScope(tenantId, async () => {
    // These reads share a deliberately single-slot serverless database pool.
    // Keep them sequential so queued work does not burn its own acquisition
    // deadline while an earlier reservation is still active.
    let missions = await listMissionSummariesForRequest(50, {
      tenantId,
      actorId,
      requestActorBinding,
    });
    const capabilityResult = await searchCapabilities({ tenantId, limit: 50 });
    let selected = missions.find((mission) => mission.id === id);
    let detail: Awaited<ReturnType<typeof getMissionDetail>> | undefined;
    if (!selected) {
      // The bounded catalog is not proof that an absent deep link is missing.
      // Re-resolve only its public summary across the request-readable owner
      // pair before deciding whether an exact full-detail read is permitted.
      selected = await getMissionSummaryForRequest(id, {
        tenantId,
        actorId,
        requestActorBinding,
      });
      if (!selected) return undefined;
      missions = [selected, ...missions.filter((mission) => mission.id !== id)];
    }
    if (selected.detailAvailable === true) {
      detail = await getMissionDetail(id, { tenantId, actorId }, {
        tasks: 100,
        attempts: 250,
        artifacts: 150,
      });
      if (!detail) return undefined;
      selected = toMissionSummaryView(detail.mission);
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
      initialDetail: detail ? toMissionDetailView(detail) : undefined,
      initialMissionReadContract: "readable_v1" as const,
      initialEventCursor: latestEvents[0]?.seq || 0,
    };
  });
  if (!initial) redirect("/app/missions");
  return <MissionWorkspace initialMissionId={id} {...initial} />;
}
