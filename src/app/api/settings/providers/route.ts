import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { settingsErrorResponse } from "@/lib/settings/http";
import { normalizeProviderCredentials, validateAndRefreshProvider } from "@/lib/settings/provider-catalog";
import {
  listProviderConnections,
  listProviderConnectionsForRequest,
  saveProviderConnection,
} from "@/lib/settings/store";
import { MODEL_PROVIDERS } from "@/lib/settings/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  label: z.string().trim().min(1).max(120),
  credentials: z.record(z.string().max(80), z.string().max(8_192)),
  validateNow: z.boolean().optional().default(true),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "provider_connection" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const readable = new URL(request.url).searchParams.get("ownerScope") === "readable";
    const providers = readable
      ? await listProviderConnectionsForRequest({
          tenantId: context.tenantId,
          actorId: context.actorId,
          requestActorBinding:
            canonicalRequestActorBindingFromSecurityContext(context),
          includeDeploymentFallback: true,
        })
      : (await listProviderConnections({
          tenantId: context.tenantId,
          actorId: context.actorId,
          includeDeploymentFallback: true,
        })).map((record) => ({
          ...record,
          manageable: record.source === "tenant_vault" &&
            record.actorId === context.actorId,
        }));
    return Response.json({
      providers,
      requestReadContracts: {
        providerConnections: readable ? "readable_v1" : "exact_v1",
      },
    }, {
      headers: { "cache-control": "no-store, private" },
    });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request, 40_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid provider connection", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({
      request, action: "manage.connector", resourceType: "provider_connection",
      metadata: { provider: parsed.data.provider, operation: "create", validateNow: parsed.data.validateNow },
    });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const connection = await saveProviderConnection({
      ...context,
      provider: parsed.data.provider,
      label: parsed.data.label,
      credentials: normalizeProviderCredentials(parsed.data.provider, parsed.data.credentials),
    });
    if (!parsed.data.validateNow) return Response.json({ connection }, { status: 201 });
    const validated = await validateAndRefreshProvider({ ...context, connectionId: connection.id });
    return Response.json(validated, { status: 201 });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}
