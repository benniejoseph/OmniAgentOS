import { randomUUID } from "node:crypto";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueKnowledgeIngestJob,
  knowledgeIngestJobRequestSchema,
} from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = knowledgeIngestJobRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid document", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      metadata: {
        titleLength: parsed.data.title.length,
        hasSource: Boolean(parsed.data.source),
        sourceType: parsed.data.sourceType,
        tagCount: parsed.data.tags?.length || 0,
        contentLength: parsed.data.content.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let job;
  try {
    job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: `knowledge_ingest_${randomUUID()}`,
        purpose: "knowledge.ingest.api",
      }),
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim().slice(0, 200) ||
        undefined,
      request: parsed.data,
    });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Ingestion queue failed." },
      { status: 500 },
    );
  }
  return Response.json(
    {
      job: projectOperationJobStatus(job),
    },
    {
      status: 202,
      headers: {
        location: `/api/operations/jobs/${job.id}`,
        "retry-after": "2",
        "cache-control": "private, no-store",
      },
    },
  );
}
