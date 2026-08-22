import { z } from "zod";
import { openApiContractReviewSummary } from "@/lib/connectors/contract-review";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  createOpenApiConnectorRecord,
  getOpenApiConnectorStats,
  listOpenApiConnectors,
  listOpenApiConnectorsRequiringReview,
  listOpenApiOperations,
  recordOpenApiConnectorError,
  saveOpenApiConnector,
  saveOpenApiImport,
} from "@/lib/connectors/openapi-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const envNameSchema = z.string().regex(/^[A-Z0-9_]+$/).max(120);

const registerOpenApiConnectorSchema = z
  .object({
    name: z.string().min(1).max(120),
    specUrl: z.string().url().max(2048).optional(),
    specText: z.string().min(1).max(2_000_000).optional(),
    baseUrl: z.string().url().max(2048).optional(),
    authType: z.enum(["none", "bearer_env", "api_key_header_env"]).optional(),
    authTokenEnv: envNameSchema.optional(),
    authHeaderName: z.string().min(1).max(80).optional(),
    defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    approvalRequired: z.boolean().optional(),
    importSpec: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.importSpec || value.specUrl || value.specText, {
    message: "Import requires specUrl or specText.",
    path: ["specUrl"],
  })
  .refine((value) => value.importSpec || value.baseUrl, {
    message: "Registration without import requires baseUrl.",
    path: ["baseUrl"],
  })
  .refine((value) => value.authType !== "bearer_env" || value.authTokenEnv, {
    message: "Bearer auth requires authTokenEnv.",
    path: ["authTokenEnv"],
  })
  .refine((value) => value.authType !== "api_key_header_env" || (value.authTokenEnv && value.authHeaderName), {
    message: "API key header auth requires authTokenEnv and authHeaderName.",
    path: ["authTokenEnv"],
  });

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "openapi_connector",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const [recentConnectors, reviewConnectors, operations, stats] =
    await Promise.all([
    listOpenApiConnectors(20, { tenantId: context.tenantId }),
    listOpenApiConnectorsRequiringReview({ tenantId: context.tenantId }),
    listOpenApiOperations(undefined, { tenantId: context.tenantId }),
    getOpenApiConnectorStats({ tenantId: context.tenantId }),
  ]);
  const connectors = [
    ...new Map(
      [...reviewConnectors, ...recentConnectors].map((connector) => [
        connector.id,
        connector,
      ]),
    ).values(),
  ];

  return Response.json({
    connectors: connectors.map((connector) => ({
      ...redactOpenApiConnector(connector),
      review: openApiContractReviewSummary(
        operations.filter(
          (operation) => operation.connectorId === connector.id,
        ),
        connector,
      ),
    })),
    operations,
    stats: {
      ...stats,
      latest: stats.latest.map(redactOpenApiConnector),
    },
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 4_100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = registerOpenApiConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid OpenAPI connector request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "openapi_connector",
      metadata: {
        name: parsed.data.name,
        hasSpecUrl: Boolean(parsed.data.specUrl),
        hasInlineSpec: Boolean(parsed.data.specText),
        hasBaseUrl: Boolean(parsed.data.baseUrl),
        importSpec: Boolean(parsed.data.importSpec),
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

  if (parsed.data.baseUrl) {
    const secretBinding = evaluateConnectorSecretBinding({
      envName: parsed.data.authTokenEnv,
      tenantId: context.tenantId,
      targetUrl: parsed.data.baseUrl,
      role: context.role,
    });
    if (!secretBinding.allowed) {
      return Response.json(
        { error: "Invalid connector secret binding", message: secretBinding.reason },
        { status: 400 },
      );
    }
  }

  const connector = await saveOpenApiConnector(
    createOpenApiConnectorRecord({
      name: parsed.data.name,
      tenantId: context.tenantId,
      specUrl: parsed.data.specUrl,
      baseUrl: parsed.data.baseUrl || "",
      authType: parsed.data.authType || "none",
      authTokenEnv: parsed.data.authTokenEnv,
      authHeaderName: parsed.data.authHeaderName,
      defaultRiskLevel: parsed.data.defaultRiskLevel ?? 2,
      approvalRequired: parsed.data.approvalRequired ?? true,
    }),
  );

  if (!parsed.data.importSpec) {
    return Response.json({ connector: redactOpenApiConnector(connector), operations: [] }, { status: 201 });
  }

  try {
    const specText = parsed.data.specText || (await loadOpenApiSpec(parsed.data.specUrl!));
    const imported = importOpenApiSpec({
      connector,
      specText,
      baseUrlOverride: parsed.data.baseUrl,
    });
    await assertPublicHttpUrl(imported.baseUrl, "OpenAPI base URL");
    const secretBinding = evaluateConnectorSecretBinding({
      envName: parsed.data.authTokenEnv,
      tenantId: context.tenantId,
      targetUrl: imported.baseUrl,
      role: context.role,
    });
    if (!secretBinding.allowed) {
      throw new Error(secretBinding.reason);
    }
    const saved = await saveOpenApiImport({
      connector,
      operations: imported.operations,
      specHash: imported.specHash,
      baseUrl: imported.baseUrl,
      info: imported.info,
    });
    return Response.json(
      {
        ...saved,
        connector: {
          ...redactOpenApiConnector(saved.connector),
          review: openApiContractReviewSummary(
            saved.operations,
            saved.connector,
          ),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAPI import failed.";
    return Response.json(
      {
        connector: redactOpenApiConnector(await recordOpenApiConnectorError(connector, message)),
        operations: [],
        error: message,
      },
      { status: 202 },
    );
  }
}

function redactOpenApiConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return {
    ...connector,
    authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined,
    lastError: connector.lastError ? "[redacted]" : undefined,
  };
}
