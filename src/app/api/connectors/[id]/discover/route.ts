import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import { mcpContractReviewSummary } from "@/lib/connectors/contract-review";
import { isOfficialGitHubMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getMcpConnector,
  recordMcpConnectorError,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const connector = await getMcpConnector(id, { tenantId: securityContext.tenantId });

  if (!connector) {
    return Response.json({ error: "MCP connector not found." }, { status: 404 });
  }
  if (
    connector.authType === "bearer_vault" &&
    (!connector.credentialConfigured || !connector.credentialOriginMatch)
  ) {
    return Response.json(
      {
        error: "MCP connector credential required.",
        message: "Save an app-managed bearer credential for this exact endpoint origin before discovery.",
      },
      { status: 409 },
    );
  }
  const resetOfficialGitHubPolicy =
    new URL(request.url).searchParams.get("resetPolicy") === "official-github";
  if (
    resetOfficialGitHubPolicy &&
    (
      !isOfficialGitHubMcpEndpoint(connector.endpoint) ||
      new URL(connector.endpoint).pathname.replace(/\/+$/, "") !==
        "/mcp/x/all" ||
      connector.approvalRequired
    )
  ) {
    return Response.json(
      {
        error: "Invalid GitHub policy reset.",
        message:
          "Policy reset is only available for the official all-toolsets GitHub MCP connection.",
      },
      { status: 400 },
    );
  }

  try {
    const discovery = await discoverMcpTools(connector, {
      actorId: securityContext.actorId,
      actorRole: securityContext.role,
    });
    const saved = await saveMcpDiscovery({
      connector,
      tools: discovery.tools,
      capabilities: discovery.capabilities,
      instructions: discovery.instructions,
      serverVersion: discovery.serverVersion,
      resetReviewedPolicy: resetOfficialGitHubPolicy,
    });
    return Response.json({
      ...saved,
      connector: {
        ...redactMcpConnector(saved.connector),
        review: mcpContractReviewSummary(saved.tools, saved.connector),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP discovery failed.";
    return Response.json(
      {
        connector: redactMcpConnector(await recordMcpConnectorError(connector, message)),
        tools: [],
        error: message,
        discoveryFailed: true,
      },
      { status: 502 },
    );
  }
}

function redactMcpConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return {
    ...connector,
    authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined,
    lastError: connector.lastError ? "[redacted]" : undefined,
  };
}
