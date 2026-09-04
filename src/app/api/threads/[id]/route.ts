import { withDatabaseRequestScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOwnedThread, listThreadTurns } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "thread", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  const thread = await getOwnedThread(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  return Response.json({
    thread,
    turns: await listThreadTurns(thread.id, {
      tenantId: context.tenantId,
      limit: 40,
    }),
  }, { headers: { "cache-control": "private, no-store" } });
}
