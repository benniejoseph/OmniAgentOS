import { extractCaptureFile, CaptureFileError } from "@/lib/capture/files";
import {
  listCaptureAssets,
  saveCaptureAsset,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { BackgroundJobIdempotencyConflictError, enqueueKnowledgeIngestJob } from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
const MAX_MULTIPART_BYTES = 6 * 1024 * 1024;

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "capture_asset" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const limit = parseBoundedInteger(new URL(request.url).searchParams.get("limit"), 50, { max: 100 });
  return Response.json({ assets: await listCaptureAssets(context, limit) }, { headers: { "cache-control": "private, no-store" } });
}

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
  const note = String(form.get("content") || "").trim().slice(0, 20_000);
  const requestedTitle = String(form.get("title") || "").trim().slice(0, 240);
  const tags = String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 50);

  let document: { title: string; content: string; source: string; sourceType: "file" | "manual" };
  let asset: Awaited<ReturnType<typeof saveCaptureAsset>> | undefined;
  let contentOrigin: "extracted" | "supplied_note" = "extracted";
  try {
    if (file instanceof File && file.size) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      asset = await saveCaptureAsset({
        ...context,
        filename: file.name,
        mediaType: file.type,
        bytes,
        tags,
        metadata: { requestedTitle, note },
      });
      document = await extractCaptureFile(new File([bytes], file.name, { type: file.type }));
      document.source = `capture:asset:${asset.id}`;
      if (note) {
        const separator = "\n\n---\nCapture note:\n";
        const availableDocumentCharacters = Math.max(0, 900_000 - separator.length - note.length);
        document.content = `${document.content.slice(0, availableDocumentCharacters)}${separator}${note}`;
      }
    } else {
      document = {
          title: requestedTitle || note.split(/\r?\n/, 1)[0]?.slice(0, 80) || "Quick note",
          content: note,
          source: "capture://quick-note",
          sourceType: "manual" as const,
        };
    }
  } catch (error) {
    if (asset && note && error instanceof CaptureFileError) {
      contentOrigin = "supplied_note";
      document = {
        title: requestedTitle || captureTitleFromAsset(asset.filename),
        content: note,
        source: `capture:asset:${asset.id}`,
        sourceType: "file",
      };
    } else if (asset) {
      const captureError = error instanceof CaptureFileError ? error : undefined;
      const stored = await updateCaptureAssetStatus(asset.id, context, {
        status: captureError?.status === 415 ? "unsupported" : "failed",
        extractionStatus: captureError?.status === 415 ? "unsupported" : "failed",
        error: error instanceof Error ? error.message : "The captured file could not be extracted.",
      });
      return Response.json({
        asset: stored,
        ingestion: {
          status: stored.extractionStatus,
          code: captureError?.code || "extraction_failed",
          reason: stored.error,
        },
      }, { status: 202, headers: { location: `/api/capture/assets/${stored.id}`, "cache-control": "private, no-store" } });
    } else {
      if (error instanceof CaptureFileError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      throw error;
    }
  }
  if (!document.content) return Response.json({ error: "Add a note or choose a supported file." }, { status: 400 });
  if (requestedTitle) document.title = requestedTitle;

  let job;
  try {
    job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      idempotencyKey: request.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined,
      request: {
        ...document,
        tags,
        ...(asset ? {
          metadata: { captureAssetId: asset.id, actorId: asset.actorId, filename: asset.filename, mediaType: asset.mediaType, byteCount: asset.byteCount, contentOrigin },
          evidenceRefs: [`capture-asset:${asset.id}`],
        } : {}),
      },
    });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (asset) {
      asset = await updateCaptureAssetStatus(asset.id, context, {
        status: "failed",
        extractionStatus: "completed",
        error: error instanceof Error ? error.message : "Capture queue failed.",
      });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Capture queue failed.", asset }, { status: 500 });
  }
  if (asset) {
    asset = await updateCaptureAssetStatus(asset.id, context, {
      status: "queued",
      extractionStatus: "completed",
      ingestJobId: job.id,
    });
  }
  return Response.json({ job: projectOperationJobStatus(job), asset, capture: { title: document.title, source: document.source, tags } }, {
    status: 202,
    headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" },
  });
}

function captureTitleFromAsset(filename: string) {
  return filename.trim().replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").slice(0, 240) || "Untitled capture";
}
