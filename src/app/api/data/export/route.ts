import { createPortableArchive } from "@/lib/data/portable";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "portable_archive", metadata: { operation: "export" } }); }
  catch (error) { return forbiddenResponse(error); }
  const archive = await createPortableArchive({ tenantId: context.tenantId, actorId: context.actorId });
  const date = new Date().toISOString().slice(0, 10);
  return Response.json(archive, { headers: { "cache-control": "private, no-store", "content-disposition": `attachment; filename=asael-${date}.json`, "x-content-type-options": "nosniff" } });
}
