import { z } from "zod";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import {
  getOpenApiConnector,
  recordOpenApiConnectorError,
  saveOpenApiImport,
} from "@/lib/connectors/openapi-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";

const importOpenApiSchema = z.object({
  specUrl: z.string().url().optional(),
  specText: z.string().min(1).max(2_000_000).optional(),
  baseUrl: z.string().url().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestBody = await request.json().catch(() => ({}));
  const parsed = importOpenApiSchema.safeParse(requestBody);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid OpenAPI import request", details: parsed.error.flatten() },
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
      metadata: requestBody,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const connector = await getOpenApiConnector(id, { tenantId: securityContext.tenantId });

  if (!connector) {
    return Response.json({ error: "OpenAPI connector not found." }, { status: 404 });
  }

  try {
    const specUrl = parsed.data.specUrl || connector.specUrl;
    if (specUrl) {
      await assertPublicHttpUrl(specUrl, "OpenAPI spec URL");
    }
    if (parsed.data.baseUrl) {
      await assertPublicHttpUrl(parsed.data.baseUrl, "OpenAPI base URL");
    }

    const specText = parsed.data.specText || (specUrl ? await loadOpenApiSpec(specUrl) : undefined);

    if (!specText) {
      throw new Error("OpenAPI import requires a saved spec URL or specText.");
    }

    const imported = importOpenApiSpec({
      connector: {
        ...connector,
        specUrl,
      },
      specText,
      baseUrlOverride: parsed.data.baseUrl,
    });
    await assertPublicHttpUrl(imported.baseUrl, "OpenAPI base URL");

    const saved = await saveOpenApiImport({
      connector: {
        ...connector,
        specUrl,
      },
      operations: imported.operations,
      specHash: imported.specHash,
      baseUrl: imported.baseUrl,
      info: imported.info,
    });
    return Response.json({ ...saved, connector: redactOpenApiConnector(saved.connector) });
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
