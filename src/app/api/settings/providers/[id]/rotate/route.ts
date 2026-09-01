import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { normalizeProviderCredentials, validateAndRefreshProvider } from "@/lib/settings/provider-catalog";
import { getProviderConnection, saveProviderConnection, SettingsStoreError } from "@/lib/settings/store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const rotateSchema = z.object({
  credentials: z.record(z.string().max(80), z.string().max(8_192)),
  validateNow: z.boolean().optional().default(true),
}).strict();

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request, 40_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = rotateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid credential rotation", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, riskLevel: 2, metadata: { operation: "rotate_credentials", validateNow: parsed.data.validateNow } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const current = await getProviderConnection({ ...context, connectionId: id });
    if (!current || current.source !== "tenant_vault") throw new SettingsStoreError("Provider connection not found.", 404);
    const connection = await saveProviderConnection({
      ...context,
      provider: current.provider,
      label: current.label,
      credentials: normalizeProviderCredentials(current.provider, parsed.data.credentials),
    });
    if (!parsed.data.validateNow) return Response.json({ connection });
    return Response.json(await validateAndRefreshProvider({ ...context, connectionId: connection.id }));
  } catch (error) { return settingsErrorResponse(error); }
}
