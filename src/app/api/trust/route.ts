import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { listTrustProfiles } from "@/lib/trust/ledger";
import { graduationThreshold, isGraduatedAutonomyEnabled } from "@/lib/trust/policy";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
