import { getRunBrowserFrameContent } from "@/lib/browser/frames";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getAgentRun } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getThread } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string; frameId: string }> },
) {
  const { id, frameId } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_run_activity",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) {
    return Response.json({ error: "Browser frame not found." }, { status: 404 });
  }
  if (run.threadId) {
    const thread = await getThread(run.threadId, { tenantId: auth.tenantId });
    if (!thread || thread.actorId !== auth.actorId) {
      return Response.json({ error: "Browser frame not found." }, { status: 404 });
    }
  }

  const frame = await getRunBrowserFrameContent(id, frameId, {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
  });
  if (!frame) {
    return Response.json({ error: "Browser frame not found." }, { status: 404 });
  }

  return new Response(frame.bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(frame.asset.byteCount),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": frame.asset.mediaType,
      etag: `"${frame.asset.contentSha256}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
