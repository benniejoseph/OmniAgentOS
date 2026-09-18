import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  installPluginService,
  pluginInstallServiceInputSchema,
} from "@/lib/app-services/plugins";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  PluginConflictError,
  PluginNotFoundError,
  PluginPreviewExpiredError,
  PluginUnavailableError,
} from "@/lib/plugins/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "plugin",
      riskLevel: 1,
      metadata: { operation: "install_exact_preview" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request, 8_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = pluginInstallServiceInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid plugin install request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  try {
    const result = await installPluginService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "plugin.install",
        causationId: parsed.data.previewId,
      }),
      parsed.data,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { status: 201, headers: privateNoStoreHeaders },
    );
  } catch (error) {
    return pluginFailure(error, "install");
  }
}

function pluginFailure(error: unknown, operation: string) {
  if (error instanceof PluginNotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: privateNoStoreHeaders });
  }
  if (error instanceof PluginPreviewExpiredError || error instanceof PluginConflictError) {
    return Response.json({ error: error.message }, { status: 409, headers: privateNoStoreHeaders });
  }
  if (error instanceof PluginUnavailableError) {
    return Response.json({ error: error.message }, { status: 503, headers: privateNoStoreHeaders });
  }
  console.error(`Plugin ${operation} failed.`, error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: `Plugin ${operation} is temporarily unavailable.` },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
