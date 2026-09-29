import { ApprovalCursorError } from "@/lib/approvals/order";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import {
  getApprovalQueue,
  getApprovalQueueItem,
  type ApprovalQueueKind,
} from "@/lib/operations/queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const approvalKinds = new Set<ApprovalQueueKind>(["tool", "workflow", "slo_policy"]);
const MAX_APPROVAL_ID_LENGTH = 200;

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 25, { max: 100 });
  const cursor = url.searchParams.get("cursor");
  const id = url.searchParams.get("id")?.trim() || undefined;
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam && approvalKinds.has(kindParam as ApprovalQueueKind)
    ? kindParam as ApprovalQueueKind
    : undefined;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "approval_queue",
      resourceId: id && id.length <= MAX_APPROVAL_ID_LENGTH ? id : undefined,
      metadata: id ? { operation: "read_approval", kind: kind || "any" } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (kindParam !== null && !kind) {
    return Response.json(
      { error: "kind must be tool, workflow, or slo_policy." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  if (id !== undefined) {
    if (id.length > MAX_APPROVAL_ID_LENGTH) {
      return Response.json(
        { error: `id must be at most ${MAX_APPROVAL_ID_LENGTH} characters.` },
        { status: 400, headers: privateNoStoreHeaders },
      );
    }
    const item = await getApprovalQueueItem(id, {
      tenantId: context.tenantId,
      kind,
      actorId: context.actorId,
    });
    return Response.json({ item }, { headers: privateNoStoreHeaders });
  }

  try {
    const queue = await getApprovalQueue(limit, {
      tenantId: context.tenantId,
      cursor,
      actorId: context.actorId,
    });
    return Response.json(queue, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof ApprovalCursorError) {
      return Response.json(
        { error: error.message },
        { status: 400, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
}
