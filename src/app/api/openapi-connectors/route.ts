import { z } from "zod";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import {
  createOpenApiConnectorRecord,
  getOpenApiConnectorStats,
  listOpenApiConnectors,
  listOpenApiOperations,
  recordOpenApiConnectorError,
  saveOpenApiConnector,
  saveOpenApiImport,
} from "@/lib/connectors/openapi-store";
import { validateConnectorSecretEnvName } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";

const envNameSchema = z.string().regex(/^[A-Z0-9_]+$/);

const registerOpenApiConnectorSchema = z
  .object({
    name: z.string().min(1).max(120),
    specUrl: z.string().url().optional(),
    specText: z.string().min(1).max(2_000_000).optional(),
    baseUrl: z.string().url().optional(),
    authType: z.enum(["none", "bearer_env", "api_key_header_env"]).optional(),
    authTokenEnv: envNameSchema.optional(),
    authHeaderName: z.string().min(1).max(80).optional(),
    defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    approvalRequired: z.boolean().optional(),
    importSpec: z.boolean().optional(),
  })
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

export async function GET(request: Request) {
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

  const [connectors, operations, stats] = await Promise.all([
    listOpenApiConnectors(20, { tenantId: context.tenantId }),
    listOpenApiOperations(undefined, { tenantId: context.tenantId }),
    getOpenApiConnectorStats({ tenantId: context.tenantId }),
  ]);

  return Response.json({
    connectors: connectors.map(redactOpenApiConnector),
    operations,
    stats: {
      ...stats,
      latest: stats.latest.map(redactOpenApiConnector),
    },
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = registerOpenApiConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid OpenAPI connector request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!validateConnectorSecretEnvName(parsed.data.authTokenEnv)) {
    return Response.json(
      {
        error: "Invalid connector secret env var",
        message: "Connector secrets must use OMNIAGENT_CONNECTOR_* or OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST and cannot reference platform secrets.",
      },
      { status: 400 },
    );
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

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "openapi_connector",
      metadata: body,
    });
  } catch (error) {
    return forbiddenResponse(error);
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
    const saved = await saveOpenApiImport({
      connector,
      operations: imported.operations,
      specHash: imported.specHash,
      baseUrl: imported.baseUrl,
      info: imported.info,
    });
    return Response.json({ ...saved, connector: redactOpenApiConnector(saved.connector) }, { status: 201 });
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
