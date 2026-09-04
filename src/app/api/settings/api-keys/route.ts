import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { createServiceApiKey, listServiceApiKeysForRequest } from "@/lib/settings/service-api-keys";
import { SERVICE_API_SCOPES } from "@/lib/settings/types";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  name: z.string().trim().min(1).max(120).refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "API key name contains unsupported characters.",
  ),
  scopes: z.array(z.enum(SERVICE_API_SCOPES)).min(1).max(SERVICE_API_SCOPES.length),
  expiresAt: z.string().datetime().optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "service_api_key" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json({
      apiKeys: await listServiceApiKeysForRequest({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding:
          canonicalRequestActorBindingFromSecurityContext(context),
      }),
    }, { headers: { "cache-control": "no-store, private" } });
  }
  catch (error) { return settingsErrorResponse(error); }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid service API key", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "service_api_key", riskLevel: 2, metadata: { operation: "create", name: parsed.data.name, scopes: parsed.data.scopes, expiresAt: parsed.data.expiresAt } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json(await createServiceApiKey({ ...context, ...parsed.data }), {
      status: 201,
      headers: { "cache-control": "no-store, private" },
    });
  } catch (error) { return settingsErrorResponse(error); }
}
