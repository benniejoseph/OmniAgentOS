import { getRunBrowserAccessibilitySnapshotContent } from "@/lib/browser/frames";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getAgentRun } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOwnedThread } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string; snapshotId: string }> },
) {
  const { id, snapshotId } = await context.params;
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
  if (!run) return notFound();
  if (run.threadId) {
    const thread = await getOwnedThread(run.threadId, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(auth),
    });
    if (!thread) return notFound();
  } else {
    const binding = canonicalRequestActorBindingFromSecurityContext(auth);
    if (run.ownerActorId !== auth.actorId && run.ownerActorId !== binding?.canonicalActorId) {
      return notFound();
    }
  }

  const snapshot = await getRunBrowserAccessibilitySnapshotContent(
    id,
    snapshotId,
    { tenantId: auth.tenantId, actorId: auth.actorId },
  );
  if (!snapshot) return notFound();

  return new Response(snapshot.bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(snapshot.asset.byteCount),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "text/plain; charset=utf-8",
      etag: `"${snapshot.asset.contentSha256}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

function notFound() {
  return Response.json(
    { error: "Browser accessibility snapshot not found." },
    { status: 404, headers: privateNoStoreHeaders },
  );
}
