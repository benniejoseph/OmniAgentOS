import { z } from "zod";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  deleteOpenApiConnector,
  getOpenApiConnector,
  updateOpenApiConnector,
} from "@/lib/connectors/openapi-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const updateOpenApiConnectorSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    specUrl: z.string().url().max(2048).nullable().optional(),
    baseUrl: z.string().url().max(2048).optional(),
    authType: z.enum(["none", "bearer_env", "api_key_header_env"]).optional(),
    authTokenEnv: z.string().regex(/^[A-Z0-9_]+$/).max(120).nullable().optional(),
    authHeaderName: z.string().min(1).max(80).nullable().optional(),
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
  })
  .refine(
    (value) =>
      value.authType !== "api_key_header_env" ||
      (value.authTokenEnv !== null && value.authHeaderName !== null),
    {
      message: "API key header auth requires authTokenEnv and authHeaderName.",
      path: ["authTokenEnv"],
    },
  );

async function PATCHHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "openapi_connector");
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateOpenApiConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid OpenAPI connector update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "openapi_connector",
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
    if (parsed.data.specUrl) {
      await assertPublicHttpUrl(parsed.data.specUrl, "OpenAPI spec URL");
    }
    if (parsed.data.baseUrl) {
      await assertPublicHttpUrl(parsed.data.baseUrl, "OpenAPI base URL");
    }
  } catch (error) {
    return Response.json(
      { error: "Invalid OpenAPI connector URL", message: error instanceof Error ? error.message : "URL is not allowed." },
      { status: 400 },
    );
  }

  try {
    const existing = await getOpenApiConnector(id, { tenantId: securityContext.tenantId });
    if (!existing) {
      return Response.json({ error: "OpenAPI connector not found." }, { status: 404 });
    }
    if (parsed.data.status === "active" && !existing.lastImportedAt) {
      return Response.json(
        {
          error: "OpenAPI connector review required.",
          message:
            "Import this connector's operations before activating its reviewed contract.",
        },
        { status: 409 },
      );
    }
    const nextAuthType = parsed.data.authType || existing.authType;
    const nextEnvName = parsed.data.authTokenEnv === null
      ? undefined
      : parsed.data.authTokenEnv || existing.authTokenEnv;
    const nextHeaderName = parsed.data.authHeaderName === null
      ? undefined
      : parsed.data.authHeaderName || existing.authHeaderName;
    if (nextAuthType !== "none" && !nextEnvName) {
      return Response.json(
        { error: "Invalid OpenAPI connector update", message: "Connector auth requires authTokenEnv." },
        { status: 400 },
      );
    }
    if (nextAuthType === "api_key_header_env" && !nextHeaderName) {
      return Response.json(
        { error: "Invalid OpenAPI connector update", message: "API key auth requires authHeaderName." },
        { status: 400 },
      );
    }
    const secretBinding = evaluateConnectorSecretBinding({
      envName: nextAuthType === "none" ? undefined : nextEnvName,
      tenantId: securityContext.tenantId,
      targetUrl: parsed.data.baseUrl || existing.baseUrl,
      role: securityContext.role,
    });
    if (!secretBinding.allowed) {
      return Response.json(
        { error: "Invalid connector secret binding", message: secretBinding.reason },
        { status: 400 },
      );
    }

    const connector = await updateOpenApiConnector(
      id,
      {
        ...parsed.data,
        specUrl: parsed.data.specUrl === null ? "" : parsed.data.specUrl,
        authTokenEnv: parsed.data.authTokenEnv === null ? "" : parsed.data.authTokenEnv,
        authHeaderName: parsed.data.authHeaderName === null ? "" : parsed.data.authHeaderName,
      },
      { tenantId: securityContext.tenantId },
    );

    if (!connector) {
      await recordConnectorEvent({
        telemetry,
        level: "warn",
        action: "connector.openapi.update_not_found",
        request,
        statusCode: 404,
        durationMs: Date.now() - startedAt,
        tenantId: securityContext.tenantId,
        actorId: securityContext.actorId,
        connectorId: id,
        message: "OpenAPI connector update failed because the connector was not found for this tenant.",
      });
      return Response.json({ error: "OpenAPI connector not found." }, { status: 404 });
    }

    await recordConnectorEvent({
      telemetry,
      action: "connector.openapi.updated",
      request,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: "OpenAPI connector updated.",
      metadata: { status: connector.status },
    });
    return Response.json({ connector: redactOpenApiConnector(connector) });
  } catch (error) {
    await recordConnectorEvent({
      telemetry,
      level: "error",
      action: "connector.openapi.update_failed",
      request,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: error instanceof Error ? error.message : "OpenAPI connector update failed.",
    });
    throw error;
  }
}

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "openapi_connector");
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "openapi_connector",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const deleted = await deleteOpenApiConnector(id, { tenantId: securityContext.tenantId });
    if (!deleted) {
      await recordConnectorEvent({
        telemetry,
        level: "warn",
        action: "connector.openapi.delete_not_found",
        request,
        statusCode: 404,
        durationMs: Date.now() - startedAt,
        tenantId: securityContext.tenantId,
        actorId: securityContext.actorId,
        connectorId: id,
        message: "OpenAPI connector delete failed because the connector was not found for this tenant.",
      });
      return Response.json({ error: "OpenAPI connector not found." }, { status: 404 });
    }

    await recordConnectorEvent({
      telemetry,
      action: "connector.openapi.deleted",
      request,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: "OpenAPI connector deleted.",
    });
    return Response.json({ deleted: true, connector: redactOpenApiConnector(deleted) });
  } catch (error) {
    await recordConnectorEvent({
      telemetry,
      level: "error",
      action: "connector.openapi.delete_failed",
      request,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      connectorId: id,
      message: error instanceof Error ? error.message : "OpenAPI connector delete failed.",
    });
    throw error;
  }
}

function redactOpenApiConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
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
    route: "/api/openapi-connectors/[id]",
    method: input.request.method,
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    requestId: input.telemetry.requestId,
    correlationId: input.telemetry.correlationId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    resourceType: "openapi_connector",
    resourceId: input.connectorId,
    message: input.message,
    metadata: {
      ...(input.level === "error" || input.action.endsWith("_failed") ? { failureType: "connector_failure" } : {}),
      ...input.metadata,
    },
  });
}
