import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { getSettingsSnapshot } from "@/lib/settings/snapshot";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import {
  McpExportConfigurationReadConflictError,
  SettingsStoreError,
} from "@/lib/settings/store";

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
  const readableOwnerScope = new URL(request.url).searchParams.get("ownerScope") === "readable"
    ? "readable" as const
    : undefined;
  try {
    return Response.json(await getSettingsSnapshot({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(context),
      ...(readableOwnerScope
        ? {
            providerOwnerScope: readableOwnerScope,
            modelAssignmentOwnerScope: readableOwnerScope,
            mcpOwnerScope: readableOwnerScope,
          }
        : {}),
    }), {
      headers: { "cache-control": "no-store, private" },
    });
  } catch (error) {
    return readableOwnerScope
      ? settingsSnapshotReadErrorResponse(error)
      : settingsErrorResponse(error);
  }
}

function settingsSnapshotReadErrorResponse(error: unknown) {
  if (error instanceof McpExportConfigurationReadConflictError) {
    return Response.json(
      {
        error: "MCP export configuration metadata could not be resolved safely.",
      },
      {
        status: 409,
        headers: { "cache-control": "no-store, private" },
      },
    );
  }
  if (error instanceof SettingsStoreError) return settingsErrorResponse(error);
  console.error(
    "Settings snapshot read failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "Settings are temporarily unavailable." },
    {
      status: 503,
      headers: { "cache-control": "no-store, private" },
    },
  );
}
