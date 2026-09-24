import { withDatabaseRequestScope } from "@/lib/db/client";
import { getOperationJob } from "@/lib/operations/job-queue";
import { projectReadableOperationJob } from "@/lib/operations/job-visibility";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
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
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    securityContext,
  );
  const readableOwnerActorIds = new Set([
    securityContext.actorId,
    ...(actorBinding?.readableOwnerActorIds || []),
  ]);
  const projectedJob = projectReadableOperationJob(job, readableOwnerActorIds);
  if (!projectedJob) {
    return Response.json(
      { error: "Operation job not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  return Response.json(
    { job: projectedJob },
    { headers: { "cache-control": "private, no-store" } },
  );
}
