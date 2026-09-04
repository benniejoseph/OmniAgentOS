import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import {
  getMcpExportConfiguration,
  getMcpExportConfigurationForRequest,
  McpExportConfigurationReadConflictError,
  saveMcpExportConfiguration,
} from "@/lib/settings/store";
import { SERVICE_API_SCOPES } from "@/lib/settings/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PUT = withDatabaseRequestScope(PUTHandler);

const configSchema = z.object({
  enabled: z.boolean(),
  serverName: z.string().trim().min(1).max(120),
  allowedScopes: z.array(z.enum(SERVICE_API_SCOPES)).max(SERVICE_API_SCOPES.length),
  exposeResources: z.boolean().default(false),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "mcp_export" }); }
  catch (error) { return forbiddenResponse(error); }
  const readable = new URL(request.url).searchParams.get("ownerScope") === "readable";
  try {
    const exactOwner = { tenantId: context.tenantId, actorId: context.actorId };
    const mcp = readable
      ? await getMcpExportConfigurationForRequest({
          ...exactOwner,
          requestActorBinding:
            canonicalRequestActorBindingFromSecurityContext(context),
        })
      : {
          ...(await getMcpExportConfiguration(exactOwner)),
          manageable: true,
        };
    return Response.json({
      mcp,
      requestReadContracts: {
        mcpExportConfiguration: readable ? "readable_v1" : "exact_v1",
      },
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return readable
      ? mcpConfigurationReadErrorResponse(error)
      : settingsErrorResponse(error);
  }
}

async function PUTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid MCP export configuration", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "mcp_export", riskLevel: 2, metadata: { operation: "update", enabled: parsed.data.enabled, allowedScopes: parsed.data.allowedScopes, exposeResources: parsed.data.exposeResources } });
  } catch (error) { return forbiddenResponse(error); }
  try { return Response.json({ mcp: await saveMcpExportConfiguration({ ...context, ...parsed.data }) }); }
  catch (error) { return settingsErrorResponse(error); }
}

function mcpConfigurationReadErrorResponse(error: unknown) {
  const conflict = error instanceof McpExportConfigurationReadConflictError;
  if (!conflict) {
    console.error(
      "MCP export configuration metadata read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  return Response.json(
    {
      error: conflict
        ? "MCP export configuration metadata could not be resolved safely."
        : "MCP export configuration is temporarily unavailable.",
    },
    {
      status: conflict ? 409 : 503,
      headers: { "cache-control": "no-store, private" },
    },
  );
}
