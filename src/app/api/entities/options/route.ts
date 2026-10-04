import { randomUUID } from "node:crypto";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { entityOptionsQuerySchema } from "@/lib/entities/options-contracts";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { readEntityOptions } from "@/lib/entities/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "entity_registry" });
  } catch (error) {
    const response = forbiddenResponse(error);
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  }
  const access = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.read.v1", correlationId: `entity_options_${randomUUID()}`,
  });
  if (!access) return Response.json({ error: "Private entity options are unavailable for this identity." }, { status: 403, headers });

  const parameters = new URL(request.url).searchParams;
  const known = new Set(["limit", "after"]);
  if ([...parameters.keys()].some((key) => !known.has(key) || parameters.getAll(key).length !== 1)) {
    return Response.json({ error: "Invalid entity options query." }, { status: 400, headers });
  }
  const rawLimit = parameters.get("limit");
  const parsed = entityOptionsQuerySchema.safeParse({
    ...(rawLimit !== null ? { limit: /^[0-9]{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN } : {}),
    ...(parameters.has("after") ? { after: parameters.get("after") } : {}),
  });
  if (!parsed.success) return Response.json({ error: "Invalid entity options query." }, { status: 400, headers });
  try {
    return Response.json(await readEntityOptions(access, parsed.data), { headers });
  } catch {
    return Response.json({ error: "Entity options are temporarily unavailable." }, { status: 503, headers });
  }
}
