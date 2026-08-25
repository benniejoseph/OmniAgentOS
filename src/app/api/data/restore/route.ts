import { restorePortableArchive } from "@/lib/data/portable";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "portable_archive", metadata: { operation: "restore" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 10 * 1024 * 1024); } catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const restored = await restorePortableArchive(body, { tenantId: context.tenantId, actorId: context.actorId, abortSignal: request.signal });
    return Response.json({ restored }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Archive restore failed." }, { status: 400 });
  }
}
