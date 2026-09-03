import {
  CaptureAssetError,
  deleteCaptureAsset,
  getCaptureAsset,
  getCaptureAssetContent,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { CaptureFileError, captureTitle, extractCaptureFile } from "@/lib/capture/files";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import {
  cancelOperationJobByDedupeKey,
  getOperationJob,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { z } from "zod";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const indexAssetSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  note: z.string().trim().max(20_000).optional(),
}).strict();

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "capture_asset", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    if (new URL(request.url).searchParams.get("content") === "1") {
      const { asset, bytes } = await getCaptureAssetContent(id, context);
      const requestedDownload = new URL(request.url).searchParams.get("download") === "1";
      const disposition = requestedDownload || !safeInlineMediaType(asset.mediaType) ? "attachment" : "inline";
      return new Response(bytes, { headers: {
        "content-type": asset.mediaType,
        "content-length": String(asset.byteCount),
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "etag": `"${asset.contentSha256}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      } });
    }
    const asset = await getCaptureAsset(id, context);
    if (!asset) return Response.json({ error: "Captured file not found." }, { status: 404 });
    return Response.json({ asset }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return assetErrorResponse(error);
  }
}

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_asset", resourceId: id, riskLevel: 3, metadata: { operation: "delete" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.asset.delete",
  );
  try {
    const asset = await getCaptureAsset(id, context);
    if (!asset) return Response.json({ error: "Captured file not found." }, { status: 404 });
    await cancelIngestJob(asset.ingestJobId, context.tenantId);
    const forgotten = await deleteKnowledgeDocumentsBySourcePrefix(`capture:asset:${asset.id}`, { tenantId: context.tenantId });
    await deleteCaptureAsset(id, { ...context, executionScope });
    return Response.json({ deleted: true, forgotten }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return assetErrorResponse(error);
  }
}

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_asset", resourceId: id, metadata: { operation: "index_stored_asset" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.asset.index",
  );
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = indexAssetSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid indexing details.", details: parsed.error.flatten() }, { status: 400 });
  try {
    const { asset, bytes } = await getCaptureAssetContent(id, context);
    if (asset.ingestJobId && asset.status === "queued") {
      return Response.json({ asset, job: { id: asset.ingestJobId }, duplicate: true }, { status: 202, headers: { location: `/api/operations/jobs/${asset.ingestJobId}`, "retry-after": "2", "cache-control": "private, no-store" } });
    }
    const note = parsed.data.note?.trim() || "";
    let title = parsed.data.title || captureTitle(asset.filename);
    let content = "";
    let contentOrigin: "extracted" | "supplied_note" = "extracted";
    try {
      const extracted = await extractCaptureFile(
        new File([bytes], asset.filename, { type: asset.mediaType }),
        {
          tenantId: context.tenantId,
          actorId: context.actorId,
          sourceStreamId: `capture-asset:${asset.id}`,
          operation: "ocr",
          purpose: "capture.asset.extract",
          correlationId: executionScope.correlationId,
          executionScope,
          credentialSource: "deployment_environment",
        },
      );
      title = parsed.data.title || extracted.title;
      content = extracted.content;
    } catch (error) {
      if (!note || !(error instanceof CaptureFileError)) throw error;
      contentOrigin = "supplied_note";
    }
    if (note) {
      const separator = content ? "\n\n---\nCapture note:\n" : "";
      content = `${content.slice(0, Math.max(0, 900_000 - separator.length - note.length))}${separator}${note}`;
    }
    if (!content.trim()) throw new CaptureFileError("The stored asset has no extractable or supplied text to index.", 400, "no_readable_text", asset.extension);
    const job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      idempotencyKey: request.headers.get("idempotency-key")?.trim().slice(0, 200) || `capture-asset:${asset.id}`,
      request: {
        title,
        content,
        source: `capture:asset:${asset.id}`,
        sourceType: "file",
        tags: ["capture", "asset", ...(parsed.data.tags || asset.tags)],
        metadata: { captureAssetId: asset.id, actorId: asset.actorId, filename: asset.filename, mediaType: asset.mediaType, byteCount: asset.byteCount, contentOrigin },
        evidenceRefs: [`capture-asset:${asset.id}`],
      },
    });
    const updated = await updateCaptureAssetStatus(asset.id, { ...context, executionScope }, { status: "queued", extractionStatus: "completed", ingestJobId: job.id });
    return Response.json({ asset: updated, job: projectOperationJobStatus(job) }, { status: 202, headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CaptureFileError) {
      const existing = await getCaptureAsset(id, context);
      const asset = existing ? await updateCaptureAssetStatus(id, { ...context, executionScope }, {
        status: error.status === 415 ? "unsupported" : "failed",
        extractionStatus: error.status === 415 ? "unsupported" : "failed",
        error: error.message,
      }) : undefined;
      return Response.json({ asset, ingestion: { status: asset?.extractionStatus || "failed", code: error.code, reason: error.message } }, { status: 202, headers: { "cache-control": "private, no-store" } });
    }
    return assetErrorResponse(error);
  }
}

function assetErrorResponse(error: unknown) {
  if (error instanceof CaptureAssetError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: error instanceof Error ? error.message : "Captured file request failed." }, { status: 500 });
}

function safeInlineMediaType(mediaType: string) {
  return ["image/png", "image/jpeg", "image/webp", "application/pdf", "audio/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"].includes(mediaType);
}

async function cancelIngestJob(jobId: string | undefined, tenantId: string) {
  if (!jobId) return;
  const job = await getOperationJob(jobId, { tenantId });
  if (job?.dedupeKey) await cancelOperationJobByDedupeKey(job.dedupeKey, "Captured file deleted by its owner.", { tenantId });
}
