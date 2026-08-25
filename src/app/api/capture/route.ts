import { extractCaptureFile, CaptureFileError } from "@/lib/capture/files";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { BackgroundJobIdempotencyConflictError, enqueueKnowledgeIngestJob } from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const MAX_MULTIPART_BYTES = 6 * 1024 * 1024;

async function POSTHandler(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Response.json({ error: "Capture requests must use multipart form data." }, { status: 415 });
  }
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MULTIPART_BYTES) {
    return Response.json({ error: "Capture payloads must be 6 MB or smaller." }, { status: 413 });
  }

  let context;
  try {
    context = await authorizeRequest({
      request, action: "write.memory", resourceType: "knowledge",
      metadata: { operation: "capture", declaredBytes },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "The capture payload could not be read." }, { status: 400 });
  }
  const file = form.get("file");
  const note = String(form.get("content") || "").trim();
  const requestedTitle = String(form.get("title") || "").trim().slice(0, 240);
  const tags = String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 50);

  let document;
  try {
    document = file instanceof File && file.size
      ? await extractCaptureFile(file)
      : {
          title: requestedTitle || note.split(/\r?\n/, 1)[0]?.slice(0, 80) || "Quick note",
          content: note,
          source: "capture://quick-note",
          sourceType: "manual" as const,
        };
  } catch (error) {
    if (error instanceof CaptureFileError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  if (!document.content) return Response.json({ error: "Add a note or choose a supported file." }, { status: 400 });
  if (requestedTitle) document.title = requestedTitle;

  let job;
  try {
    job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      idempotencyKey: request.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined,
      request: { ...document, tags },
    });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Capture queue failed." }, { status: 500 });
  }
  return Response.json({ job: projectOperationJobStatus(job), capture: { title: document.title, source: document.source, tags } }, {
    status: 202,
    headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" },
  });
}
