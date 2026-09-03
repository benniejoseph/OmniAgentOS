import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getWorkflowRunDetail,
  getWorkflowRunStatus,
} from "@/lib/workflows/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  publicWorkflowRunDetail,
  publicWorkflowStatus,
} from "@/lib/workflows/public";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const statusOnly = new URL(request.url).searchParams.get("view") === "status";
  const detail = statusOnly
    ? await getWorkflowRunStatus(id, {
        tenantId: securityContext.tenantId,
      })
    : await getWorkflowRunDetail(id, {
        tenantId: securityContext.tenantId,
      });

  if (!detail) {
    return Response.json({ error: "Workflow run not found." }, { status: 404 });
  }

  return Response.json(
    statusOnly
      ? { run: publicWorkflowStatus(detail) }
      : publicWorkflowRunDetail(detail),
  );
}
