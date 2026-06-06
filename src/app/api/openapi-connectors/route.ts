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
import { validateSecretEnvName } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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

export async function GET() {
  return Response.json({
    connectors: await listOpenApiConnectors(),
    operations: await listOpenApiOperations(),
    stats: await getOpenApiConnectorStats(),
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

  if (!validateSecretEnvName(parsed.data.authTokenEnv)) {
    return Response.json(
      { error: "Invalid secret env var", message: "Secret env vars must be uppercase server-only names and cannot use NEXT_PUBLIC_." },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
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
    return Response.json({ connector, operations: [] }, { status: 201 });
  }

  try {
    const specText = parsed.data.specText || (await loadOpenApiSpec(parsed.data.specUrl!));
    const imported = importOpenApiSpec({
      connector,
      specText,
      baseUrlOverride: parsed.data.baseUrl,
    });
    return Response.json(
      await saveOpenApiImport({
        connector,
        operations: imported.operations,
        specHash: imported.specHash,
        baseUrl: imported.baseUrl,
        info: imported.info,
      }),
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAPI import failed.";
    return Response.json(
      {
        connector: await recordOpenApiConnectorError(connector, message),
        operations: [],
        error: message,
      },
      { status: 202 },
    );
  }
}
