import { withDatabaseRequestScope } from "@/lib/db/client";
import { foldTrustProfile } from "@/lib/events/projections";
import { listStreamEvents } from "@/lib/events/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { listTrustProfiles } from "@/lib/trust/ledger";
import { graduationThreshold, isGraduatedAutonomyEnabled } from "@/lib/trust/policy";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "trust_profile",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  // ?replay=<actionClass> rebuilds the profile by folding its event stream —
  // verifiable proof that the stored profile matches its event history.
  const replayClass =
    url.searchParams.get("replay")?.trim().slice(0, 160) || undefined;
  if (replayClass) {
    const events = await listStreamEvents(`trust:${replayClass}`, { tenantId: context.tenantId });
    const replayed = foldTrustProfile(events, { actionClass: replayClass, tenantId: context.tenantId });
    const stored = (await listTrustProfiles({ tenantId: context.tenantId })).find(
      (profile) => profile.actionClass === replayClass,
    );
    const consistent =
      Boolean(replayed && stored) &&
      replayed?.total === stored?.total &&
      replayed?.cleanStreak === stored?.cleanStreak &&
      replayed?.successes === stored?.successes &&
      replayed?.failures === stored?.failures;
    return Response.json({
      actionClass: replayClass,
      eventCount: events.length,
      replayed,
      stored,
      consistent,
    });
  }

  const profiles = await listTrustProfiles({ tenantId: context.tenantId });
  const graduated = profiles.filter((profile) => profile.autonomyMode === "auto_with_alert");

  return Response.json({
    enabled: isGraduatedAutonomyEnabled(),
    threshold: graduationThreshold(),
    profiles,
    stats: {
      tracked: profiles.length,
      graduated: graduated.length,
      gating: profiles.length - graduated.length,
    },
  });
}
