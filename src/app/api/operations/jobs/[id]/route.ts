import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getOperationJob,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
      resourceType: "operation_job",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const job = await getOperationJob(id, {
    tenantId: securityContext.tenantId,
  });
  if (!job) {
    return Response.json({ error: "Operation job not found." }, { status: 404 });
  }
  return Response.json(
    { job: projectOperationJobStatus(job) },
    { headers: { "cache-control": "private, no-store" } },
  );
}
