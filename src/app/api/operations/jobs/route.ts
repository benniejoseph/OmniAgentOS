import { withDatabaseRequestScope } from "@/lib/db/client";
import { getOperationJobStatusesByIds } from "@/lib/operations/job-queue";
import { projectReadableOperationJob } from "@/lib/operations/job-visibility";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const MAX_JOB_IDS = 100;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,200}$/;

async function GETHandler(request: Request) {
  const parsedIds = parseRequestedJobIds(request);
  if (!parsedIds.ok) {
    return Response.json(
      { error: parsedIds.error },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "operation_job",
      metadata: { requestedJobCount: parsedIds.ids.length },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const jobs = await getOperationJobStatusesByIds(parsedIds.ids, {
    tenantId: securityContext.tenantId,
  });
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    securityContext,
  );
  const readableOwnerActorIds = new Set([
    securityContext.actorId,
    ...(actorBinding?.readableOwnerActorIds || []),
  ]);
  const projectedById = new Map(
    jobs.flatMap((job) => {
      const projected = projectReadableOperationJob(
        job,
        readableOwnerActorIds,
      );
      return projected ? [[job.id, projected] as const] : [];
    }),
  );

  return Response.json(
    {
      jobs: parsedIds.ids.flatMap((id) => {
        const job = projectedById.get(id);
        return job ? [job] : [];
      }),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

function parseRequestedJobIds(request: Request):
  | { ok: true; ids: string[] }
  | { ok: false; error: string } {
  const values = new URL(request.url).searchParams
    .getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const ids = [...new Set(values)];
  if (!ids.length) {
    return { ok: false, error: "At least one operation job id is required." };
  }
  if (ids.length > MAX_JOB_IDS) {
    return {
      ok: false,
      error: `No more than ${MAX_JOB_IDS} operation jobs can be read at once.`,
    };
  }
  if (ids.some((id) => !SAFE_JOB_ID.test(id))) {
    return { ok: false, error: "One or more operation job ids are invalid." };
  }
  return { ok: true, ids };
}
