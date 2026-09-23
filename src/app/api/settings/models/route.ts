import { withDatabaseRequestScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { buildCommandModelCatalog } from "@/lib/models/command-selection";
import {
  listModelAssignmentsForRequest,
  listModelCatalogForRequest,
  listProviderConnectionsForRequest,
} from "@/lib/settings/store";
import {
  MODEL_ASSIGNMENT_SCOPES,
  type ModelAssignmentScope,
} from "@/lib/settings/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "model_catalog" });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const requestActorBinding =
      canonicalRequestActorBindingFromSecurityContext(context);
    const owner = {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    };
    const models = await listModelCatalogForRequest(owner);
    const requestedScope = new URL(request.url).searchParams.get("commandScope");
    const commandScope = MODEL_ASSIGNMENT_SCOPES.includes(
      requestedScope as ModelAssignmentScope,
    )
      ? requestedScope as ModelAssignmentScope
      : undefined;
    if (!commandScope) {
      return Response.json({ models }, {
        headers: { "cache-control": "no-store, private" },
      });
    }
    const [assignments, providers] = await Promise.all([
      listModelAssignmentsForRequest(owner),
      listProviderConnectionsForRequest({
        ...owner,
        includeDeploymentFallback: false,
      }),
    ]);
    return Response.json({
      models,
      command: buildCommandModelCatalog({
        scope: commandScope,
        assignments,
        models,
        providers,
      }),
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}
