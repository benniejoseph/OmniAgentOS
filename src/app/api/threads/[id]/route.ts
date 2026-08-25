import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getThread, listThreadTurns } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "thread", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  const thread = await getThread(id, { tenantId: context.tenantId });
  if (!thread || thread.actorId !== context.actorId) return Response.json({ error: "Thread not found." }, { status: 404 });
  return Response.json({ thread, turns: await listThreadTurns(id, { tenantId: context.tenantId, limit: 40 }) });
}
