import { getApprovalQueue } from "@/lib/operations/queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 100);

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "approval_queue",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json(await getApprovalQueue(limit));
}
