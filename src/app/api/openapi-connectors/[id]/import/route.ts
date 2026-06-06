import { z } from "zod";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import {
  getOpenApiConnector,
  recordOpenApiConnectorError,
  saveOpenApiImport,
} from "@/lib/connectors/openapi-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
  const connector = await getOpenApiConnector(id);

  if (!connector) {
    return Response.json({ error: "OpenAPI connector not found." }, { status: 404 });
  }

  const requestBody = await request.json().catch(() => ({}));
  const parsed = importOpenApiSchema.safeParse(requestBody);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid OpenAPI import request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "openapi_connector",
      resourceId: id,
      metadata: { connectorName: connector.name, ...requestBody },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const specUrl = parsed.data.specUrl || connector.specUrl;
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

    return Response.json(
      await saveOpenApiImport({
        connector: {
          ...connector,
          specUrl,
        },
        operations: imported.operations,
        specHash: imported.specHash,
        baseUrl: imported.baseUrl,
        info: imported.info,
      }),
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
