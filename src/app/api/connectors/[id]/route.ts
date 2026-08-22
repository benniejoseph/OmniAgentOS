import { z } from "zod";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { deleteMcpConnector, getMcpConnector, updateMcpConnector } from "@/lib/connectors/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const updateMcpConnectorSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    endpoint: z.string().url().max(2048).optional(),
    authType: z.enum(["none", "bearer_env"]).optional(),
    authTokenEnv: z.string().regex(/^[A-Z0-9_]+$/).max(120).nullable().optional(),
    status: z.enum(["active", "error", "disabled"]).optional(),
    defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one connector field is required.",
  })
  .refine((value) => value.authType !== "bearer_env" || value.authTokenEnv !== null, {
    message: "Bearer auth requires authTokenEnv.",
    path: ["authTokenEnv"],
  });

async function PATCHHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "mcp_connector");
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateMcpConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP connector update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      resourceId: id,
      metadata: {
        changedFields: Object.keys(parsed.data),
        hasSecretBinding: typeof parsed.data.authTokenEnv === "string",
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    if (parsed.data.endpoint) {
      await assertPublicHttpUrl(parsed.data.endpoint, "MCP endpoint");
    }
  } catch (error) {
    return Response.json(
      { error: "Invalid MCP endpoint", message: error instanceof Error ? error.message : "Endpoint is not allowed." },
      { status: 400 },
    );
  }

  try {
    const existing = await getMcpConnector(id, { tenantId: securityContext.tenantId });
    if (!existing) {
      return Response.json({ error: "MCP connector not found." }, { status: 404 });
    }
    if (parsed.data.status === "active" && !existing.lastDiscoveredAt) {
      return Response.json(
        {
          error: "MCP connector review required.",
          message:
            "Discover this connector's tools before activating its reviewed contract.",
        },
        { status: 409 },
      );
    }
    const nextAuthType = parsed.data.authType || existing.authType;
    const nextEnvName = parsed.data.authTokenEnv === null
      ? undefined
      : parsed.data.authTokenEnv || existing.authTokenEnv;
    if (nextAuthType === "bearer_env" && !nextEnvName) {
      return Response.json(
        { error: "Invalid MCP connector update", message: "Bearer auth requires authTokenEnv." },
        { status: 400 },
      );
    }
    const secretBinding = evaluateConnectorSecretBinding({
      envName: nextAuthType === "bearer_env" ? nextEnvName : undefined,
      tenantId: securityContext.tenantId,
      targetUrl: parsed.data.endpoint || existing.endpoint,
      role: securityContext.role,
    });
    if (!secretBinding.allowed) {
      return Response.json(
        { error: "Invalid connector secret binding", message: secretBinding.reason },
        { status: 400 },
      );
    }

    const connector = await updateMcpConnector(
      id,
      {
        ...parsed.data,
        authTokenEnv: parsed.data.authTokenEnv === null ? "" : parsed.data.authTokenEnv,
      },
      { tenantId: securityContext.tenantId },
    );

    if (!connector) {
      await recordConnectorEvent({
        telemetry,
        level: "warn",
        action: "connector.mcp.update_not_found",
        request,
        statusCode: 404,
        durationMs: Date.now() - startedAt,
        tenantId: securityContext.tenantId,
        actorId: securityContext.actorId,
        connectorId: id,
        message: "MCP connector update failed because the connector was not found for this tenant.",
      });
      return Response.json({ error: "MCP connector not found." }, { status: 404 });
    }

    await recordConnectorEvent({
      telemetry,
      action: "connector.mcp.updated",
      request,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: "MCP connector updated.",
      metadata: { status: connector.status },
    });
    return Response.json({ connector: redactMcpConnector(connector) });
  } catch (error) {
    await recordConnectorEvent({
      telemetry,
      level: "error",
      action: "connector.mcp.update_failed",
      request,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: error instanceof Error ? error.message : "MCP connector update failed.",
    });
    throw error;
  }
}

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "mcp_connector");
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

  try {
    const deleted = await deleteMcpConnector(id, { tenantId: securityContext.tenantId });
    if (!deleted) {
      await recordConnectorEvent({
        telemetry,
        level: "warn",
        action: "connector.mcp.delete_not_found",
        request,
        statusCode: 404,
        durationMs: Date.now() - startedAt,
        tenantId: securityContext.tenantId,
        actorId: securityContext.actorId,
        connectorId: id,
        message: "MCP connector delete failed because the connector was not found for this tenant.",
      });
      return Response.json({ error: "MCP connector not found." }, { status: 404 });
    }

    await recordConnectorEvent({
      telemetry,
      action: "connector.mcp.deleted",
      request,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: "MCP connector deleted.",
    });
    return Response.json({ deleted: true, connector: redactMcpConnector(deleted) });
  } catch (error) {
    await recordConnectorEvent({
      telemetry,
      level: "error",
      action: "connector.mcp.delete_failed",
      request,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: error instanceof Error ? error.message : "MCP connector delete failed.",
    });
    throw error;
  }
}

function redactMcpConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return {
    ...connector,
    authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined,
    lastError: connector.lastError ? "[redacted]" : undefined,
  };
}

async function recordConnectorEvent(input: {
  telemetry: ReturnType<typeof createRequestTelemetry>;
  level?: "info" | "warn" | "error";
  action: string;
  request: Request;
  statusCode: number;
  durationMs: number;
  tenantId: string;
  actorId: string;
  connectorId: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  await recordRuntimeEventSafely({
    level: input.level,
    category: "connector",
    action: input.action,
    route: "/api/connectors/[id]",
    method: input.request.method,
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    requestId: input.telemetry.requestId,
    correlationId: input.telemetry.correlationId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    resourceType: "mcp_connector",
    resourceId: input.connectorId,
    message: input.message,
    metadata: {
      ...(input.level === "error" || input.action.endsWith("_failed") ? { failureType: "connector_failure" } : {}),
      ...input.metadata,
    },
  });
}
