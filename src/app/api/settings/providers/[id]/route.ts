import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { revokeProviderConnection, updateProviderConnection } from "@/lib/settings/store";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const updateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "A change is required.");

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid provider update", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, metadata: { operation: "update", fields: Object.keys(parsed.data) } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json({ connection: await updateProviderConnection({ ...context, connectionId: id, ...parsed.data }) });
  } catch (error) { return settingsErrorResponse(error); }
}

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, riskLevel: 2, metadata: { operation: "revoke_and_scrub" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json({ connection: await revokeProviderConnection({ ...context, connectionId: id }) });
  } catch (error) { return settingsErrorResponse(error); }
}
