import { connectionCatalog } from "@/lib/connectors/catalog";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "connection_catalog",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    connectors: connectionCatalog,
    stats: {
      total: connectionCatalog.length,
      mcp: connectionCatalog.filter((connector) => connector.adapter === "mcp").length,
      openapi: connectionCatalog.filter((connector) => connector.adapter === "openapi").length,
      planned: connectionCatalog.filter((connector) => connector.status === "planned").length,
    },
  });
}
