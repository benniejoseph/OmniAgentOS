import { z } from "zod";

import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  pluginLifecycleServiceInputSchema,
  transitionPluginService,
} from "@/lib/app-services/plugins";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  PluginConflictError,
  PluginNotFoundError,
  PluginUnavailableError,
} from "@/lib/plugins/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";

export const runtime = "nodejs";
export const maxDuration = 30;
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const patchSchema = z.object({
  action: z.enum(["enable", "disable"]),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const deleteSchema = z.object({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

async function PATCHHandler(request: Request, context: RouteContext<"/api/plugins/[id]">) {
  const { id } = await context.params;
  const authorized = await authorizeLifecycleRequest(request, id, "change_state");
  if (authorized instanceof Response) return authorized;
  const parsed = await parseBody(request, patchSchema);
  if (parsed instanceof Response) return parsed;
  return lifecycle(request, authorized, id, parsed.action, parsed.expectedRevision);
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/plugins/[id]">) {
  const { id } = await context.params;
  const authorized = await authorizeLifecycleRequest(request, id, "uninstall");
  if (authorized instanceof Response) return authorized;
  const parsed = await parseBody(request, deleteSchema);
  if (parsed instanceof Response) return parsed;
  return lifecycle(request, authorized, id, "uninstall", parsed.expectedRevision);
}

async function lifecycle(
  request: Request,
  securityContext: SecurityContext,
  installationId: string,
  action: "enable" | "disable" | "uninstall",
  expectedRevision: number,
) {
  const parsed = pluginLifecycleServiceInputSchema.safeParse({
    installationId,
    action,
    expectedRevision,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid plugin lifecycle request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  try {
    const result = await transitionPluginService(
      createRequestMutationAppServiceCaller(request, securityContext, {
        purpose: `plugin.${action}`,
        causationId: installationId,
      }),
      parsed.data,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof PluginNotFoundError) {
      return Response.json({ error: error.message }, { status: 404, headers: privateNoStoreHeaders });
    }
    if (error instanceof PluginConflictError) {
      return Response.json({ error: error.message }, { status: 409, headers: privateNoStoreHeaders });
    }
    if (error instanceof PluginUnavailableError) {
      return Response.json({ error: error.message }, { status: 503, headers: privateNoStoreHeaders });
    }
    console.error(`Plugin ${action} failed.`, error instanceof Error ? error.name : "UnknownError");
    return Response.json(
      { error: `Plugin ${action} is temporarily unavailable.` },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

async function authorizeLifecycleRequest(
  request: Request,
  installationId: string,
  operation: "change_state" | "uninstall",
) {
  try {
    return await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "plugin",
      resourceId: installationId,
      riskLevel: 1,
      metadata: { operation },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

async function parseBody<T extends z.ZodType>(request: Request, schema: T) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 8_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? parsed.data as z.infer<T>
    : Response.json(
        { error: "Invalid plugin lifecycle request.", details: parsed.error.flatten() },
        { status: 400, headers: privateNoStoreHeaders },
      );
}
