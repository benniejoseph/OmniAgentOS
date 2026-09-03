import { z } from "zod";
import { ConnectorContractReviewConflictError } from "@/lib/connectors/contract-review";
import { promoteMcpContracts } from "@/lib/connectors/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createRequestTelemetry } from "@/lib/observability/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const reviewSchema = z
  .object({
    expectedFingerprint: z.string().min(20).max(200),
  })
  .strict();

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const telemetry = createRequestTelemetry(request, "mcp_connector_contract");
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP contract review", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector_contract",
      resourceId: id,
      metadata: { expectedFingerprint: parsed.data.expectedFingerprint },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const result = await promoteMcpContracts(
      {
        connectorId: id,
        expectedFingerprint: parsed.data.expectedFingerprint,
      },
      {
        executionScope: executionScopeFromSecurityContext(securityContext, {
          correlationId: telemetry.correlationId,
          causationId: id,
          purpose: "connector.mcp.contracts.review",
        }),
      },
    );
    if (!result) {
      return Response.json({ error: "MCP connector not found." }, { status: 404 });
    }
    return Response.json({
      promoted: result.promoted,
      connectorStatus: result.connector.status,
      activationRequired: result.connector.status !== "active",
      tools: result.tools,
    });
  } catch (error) {
    if (error instanceof ConnectorContractReviewConflictError) {
      return Response.json(
        {
          error: "MCP contracts changed during review.",
          message: "Refresh discovery and review the current contracts before approving.",
        },
        { status: 409 },
      );
    }
    throw error;
  }
}
