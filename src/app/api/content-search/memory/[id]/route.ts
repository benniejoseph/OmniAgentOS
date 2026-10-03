import { randomUUID } from "node:crypto";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { getPrivateSearchMemory } from "@/lib/memory/store";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "memory", resourceId: id }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  const access = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: "content.search.inspect", correlationId: randomUUID(),
  });
  if (!access) return Response.json({ error: "A current workspace account is required." }, { status: 403, headers });
  try {
    const memory = await getPrivateSearchMemory({ tenantId: context.tenantId, id, accessScope: access.databaseAccessScope });
    return memory ? Response.json({ memory: publicMemoryServiceRecord(memory) }, { headers }) :
      Response.json({ error: "This private memory is no longer available in search." }, { status: 404, headers });
  } catch { return Response.json({ error: "Private memory could not be opened." }, { status: 503, headers }); }
}
