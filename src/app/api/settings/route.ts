import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { getSettingsSnapshot } from "@/lib/settings/snapshot";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "settings" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const readableOwnerScope = new URL(request.url).searchParams.get("ownerScope") === "readable"
      ? "readable" as const
      : undefined;
    return Response.json(await getSettingsSnapshot({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(context),
      ...(readableOwnerScope
        ? {
            providerOwnerScope: readableOwnerScope,
            modelAssignmentOwnerScope: readableOwnerScope,
          }
        : {}),
    }), {
      headers: { "cache-control": "no-store, private" },
    });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}
