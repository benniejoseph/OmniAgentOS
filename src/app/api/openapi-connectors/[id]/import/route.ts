import { z } from "zod";
import { openApiContractReviewSummary } from "@/lib/connectors/contract-review";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getOpenApiConnector,
  recordOpenApiConnectorError,
  saveOpenApiImport,
} from "@/lib/connectors/openapi-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const importOpenApiSchema = z.object({
  specUrl: z.string().url().max(2_048).optional(),
  specText: z.string().min(1).max(2_000_000).optional(),
  baseUrl: z.string().url().max(2_048).optional(),
}).strict();

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let requestBody: unknown;
  try {
    requestBody = await parseJsonBody(request, 4_100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
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
      metadata: {
        hasSpecUrl: Boolean(parsed.data.specUrl),
        hasInlineSpec: Boolean(parsed.data.specText),
        hasBaseUrl: Boolean(parsed.data.baseUrl),
      },
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
    if (connector.authType !== "none" && !connector.authTokenEnv) {
      throw new Error("Connector auth requires authTokenEnv.");
    }
    const secretBinding = evaluateConnectorSecretBinding({
      envName: connector.authType === "none" ? undefined : connector.authTokenEnv,
      tenantId: securityContext.tenantId,
      targetUrl: imported.baseUrl,
      role: securityContext.role,
    });
    if (!secretBinding.allowed) {
      throw new Error(secretBinding.reason);
    }

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
    return Response.json({
      ...saved,
      connector: {
        ...redactOpenApiConnector(saved.connector),
        review: openApiContractReviewSummary(
          saved.operations,
          saved.connector,
        ),
      },
    });
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
