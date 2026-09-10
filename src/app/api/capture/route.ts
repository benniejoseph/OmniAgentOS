import { captureTitle } from "@/lib/capture/files";
import {
  listCaptureAssets,
  saveCaptureAsset,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import {
  assertOfflineCaptureOwnerBinding,
  OfflineCaptureOwnerBindingError,
} from "@/lib/capture/offline-outbox";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import {
  getOperationJobsByIds,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
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
  const assets = await listCaptureAssets({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(context),
    }, limit);
  const jobIds = assets.flatMap((asset) =>
    asset.manageable && asset.ingestJobId ? [asset.ingestJobId] : []
  );
  const jobById = new Map(
    (await getOperationJobsByIds(jobIds, { tenantId: context.tenantId }))
      .filter((job) =>
        (job.type === "capture.asset.process" || job.type === "knowledge.ingest") &&
        job.payload.actorId === context.actorId
      )
      .map((job) => [job.id, job] as const),
  );
  return Response.json({
    assets,
    processingJobs: assets.flatMap((asset) => {
      if (!asset.manageable || !asset.ingestJobId) return [];
      const job = jobById.get(asset.ingestJobId);
      return job
        ? [{ assetId: asset.id, ...projectOperationJobStatus(job) }]
        : [];
    }),
  }, { headers: { "cache-control": "private, no-store" } });
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
      nativeMutationCapability: "capture.submit",
      metadata: { operation: "capture", declaredBytes },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    assertOfflineCaptureOwnerBinding({
      idempotencyKey: request.headers.get("idempotency-key") || undefined,
      correlationId:
        request.headers.get("x-omni-correlation-id") || undefined,
      ownerSha256:
        request.headers.get("x-asael-capture-owner-sha256") || undefined,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
  } catch (error) {
    if (error instanceof OfflineCaptureOwnerBindingError) {
      return Response.json(
        { error: error.message },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    throw error;
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.asset.ingest",
  );

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

  const idempotencyKey = request.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined;
  if (file instanceof File && file.size) {
    let asset = await saveCaptureAsset({
      ...context,
      executionScope,
      filename: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      tags,
      metadata: { requestedTitle, note },
    });
    try {
      const job = await enqueueCaptureAssetProcessJob({
        tenantId: context.tenantId,
        actorId: context.actorId,
        executionScope,
        idempotencyKey,
        request: {
          assetId: asset.id,
          ...(requestedTitle ? { title: requestedTitle } : {}),
          ...(note ? { note } : {}),
          ...(tags.length ? { tags } : {}),
        },
      });
      if (asset.ingestJobId && asset.ingestJobId !== job.id) {
        throw new BackgroundJobIdempotencyConflictError("capture.asset.process");
      }
      if (asset.ingestJobId !== job.id) {
        asset = await updateCaptureAssetStatus(asset.id, { ...context, executionScope }, {
          status: "queued",
          extractionStatus: "pending",
          ingestJobId: job.id,
          clearExtractionReceipt: true,
        });
      }
      return Response.json({
        job: projectOperationJobStatus(job),
        asset,
        capture: {
          title: requestedTitle || captureTitle(asset.filename),
          source: `capture:asset:${asset.id}`,
          tags,
        },
      }, {
        status: 202,
        headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof BackgroundJobIdempotencyConflictError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      asset = await updateCaptureAssetStatus(asset.id, { ...context, executionScope }, {
        status: "failed",
        extractionStatus: "pending",
        error: error instanceof Error ? error.message : "Capture queue failed.",
      });
      return Response.json({ error: error instanceof Error ? error.message : "Capture queue failed.", asset }, { status: 500 });
    }
  }

  if (!note) {
    return Response.json({ error: "Add a note or choose a supported file." }, { status: 400 });
  }
  const document = {
    title: requestedTitle || note.split(/\r?\n/, 1)[0]?.slice(0, 80) || "Quick note",
    content: note,
    source: "capture://quick-note",
    sourceType: "manual" as const,
  };
  try {
    const job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      idempotencyKey,
      request: { ...document, tags },
    });
    return Response.json({
      job: projectOperationJobStatus(job),
      capture: { title: document.title, source: document.source, tags },
    }, {
      status: 202,
      headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Capture queue failed." }, { status: 500 });
  }
}
