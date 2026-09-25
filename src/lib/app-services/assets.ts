import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  CaptureAssetError,
  getCaptureAsset,
  getCaptureAssetForRequest,
  listCaptureAssets,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import { deleteCaptureAssetWithKnowledge, deleteCaptureRecordingWithKnowledge } from "@/lib/capture/deletion";
import {
  captureExtractionReceipt,
  captureRecordingExtraction,
  renderCaptureExtractionUnits,
} from "@/lib/capture/extraction";
import {
  createCaptureRecording,
  getCaptureRecording,
  getCaptureRecordingMetadataForRequest,
  listCaptureRecordingsForRequest,
  markCaptureRecordingIngestQueued,
  prepareCaptureRecordingCompletion,
  updateCaptureRecording,
} from "@/lib/capture/recordings";
import {
  enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import { cancelOperationJobByDedupeKey, getOperationJob, projectOperationJobStatus } from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const kindSchema = z.enum(["asset", "recording"]);
const listSchema = z.object({ kind: kindSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
const targetSchema = z.object({ kind: kindSchema, id: z.string().trim().min(1).max(200) }).strict();
const deleteSchema = targetSchema.extend({ expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const recordingFields = {
  title: z.string().trim().max(240).optional(), language: z.string().trim().max(35).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
};
const recordingStartSchema = z.object({
  ...recordingFields,
  metadata: z.record(z.string().max(80), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()])).optional(),
}).strict();
const recordingUpdateSchema = z.object({ id: z.string().trim().min(1).max(200), ...recordingFields }).strict()
  .refine(({ id: _id, ...change }) => Object.values(change).some((value) => value !== undefined), { message: "A recording change is required." });
const recordingCompleteSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const assetIndexSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  note: z.string().trim().max(20_000).optional(),
}).strict();

export async function listAssetsService(caller: AppServiceCaller, input: z.input<typeof listSchema>) {
  const value = listSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.list"));
  const owner = readOwner(caller);
  const [assets, recordings] = await Promise.all([
    value.kind === "recording" ? Promise.resolve([]) : listCaptureAssets(owner, value.limit),
    value.kind === "asset" ? Promise.resolve([]) : listCaptureRecordingsForRequest(owner, value.limit),
  ]);
  return completeAppServiceCall(authorized, { assets, recordings }, { resourceCount: assets.length + recordings.length });
}

export async function showAssetService(caller: AppServiceCaller, input: z.input<typeof targetSchema>) {
  const value = targetSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.show"));
  const item = value.kind === "asset"
    ? await getCaptureAssetForRequest(value.id, readOwner(caller))
    : await getCaptureRecordingMetadataForRequest(value.id, readOwner(caller));
  return completeAppServiceCall(authorized, { kind: value.kind, item: item || null }, { resourceCount: item ? 1 : 0 });
}

export async function startRecordingService(caller: AppServiceCaller, input: z.input<typeof recordingStartSchema>) {
  const value = redactSensitive(recordingStartSchema.parse(input)) as z.output<typeof recordingStartSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.recordings.start"));
  const recording = await createCaptureRecording({ ...exactOwner(caller), ...value, executionScope: caller.executionScope! });
  return completeAppServiceCall(authorized, { recording });
}

export async function updateRecordingService(caller: AppServiceCaller, input: z.input<typeof recordingUpdateSchema>) {
  const value = redactSensitive(recordingUpdateSchema.parse(input)) as z.output<typeof recordingUpdateSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.recordings.update"));
  const { id, ...change } = value;
  const recording = await updateCaptureRecording(id, { ...exactOwner(caller), executionScope: caller.executionScope! }, change);
  return completeAppServiceCall(authorized, { recording });
}

export async function completeRecordingService(caller: AppServiceCaller, input: z.input<typeof recordingCompleteSchema>) {
  const value = recordingCompleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.recordings.complete"));
  const owner = { ...exactOwner(caller), executionScope: caller.executionScope! };
  const recording = await prepareCaptureRecordingCompletion(value.id, owner);
  if (recording.ingestJobId) return completeAppServiceCall(authorized, { recording, job: { id: recording.ingestJobId }, duplicate: true });
  const extraction = captureRecordingExtraction({ durationMs: recording.durationMs, segments: recording.segments });
  const extractionReceipt = captureExtractionReceipt(extraction);
  const job = await enqueueKnowledgeIngestJob({
    ...exactOwner(caller), executionScope: caller.executionScope!, idempotencyKey: `capture-recording:${recording.id}`,
    request: {
      title: recording.title, content: renderCaptureExtractionUnits(extraction.units), source: recording.source,
      sourceType: "file", tags: ["capture", "recording", "conversation", ...recording.tags],
      metadata: {
        captureRecordingId: recording.id, actorId: recording.actorId, durationMs: recording.durationMs,
        segmentCount: recording.segmentCount, failedSegmentCount: recording.segments.filter((segment) => segment.transcriptionStatus === "failed").length,
        completedAt: recording.completedAt || "", transcriptTruncated: extraction.warningCodes.includes("recording_transcript_truncated"),
        structuredSourceKind: extraction.sourceKind, extractionState: extraction.state,
        extractionReceiptSha256: extractionReceipt.receiptSha256,
      },
      evidenceRefs: [`capture-recording:${recording.id}`], structuredUnits: extraction.units,
    },
  });
  const updated = await markCaptureRecordingIngestQueued(recording.id, owner, job.id);
  return completeAppServiceCall(authorized, { recording: updated, job: projectOperationJobStatus(job), extractionReceipt });
}

export async function indexStoredAssetService(caller: AppServiceCaller, input: z.input<typeof assetIndexSchema>) {
  const value = redactSensitive(assetIndexSchema.parse(input)) as z.output<typeof assetIndexSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.index"));
  const owner = { ...exactOwner(caller), executionScope: caller.executionScope! };
  const asset = await getCaptureAsset(value.id, owner);
  if (!asset) throw new CaptureAssetError("Captured file not found.", 404);
  let supersededIngestJobId: string | undefined;
  if (asset.ingestJobId && asset.status === "queued") {
    const linkedJob = await getOperationJob(asset.ingestJobId, {
      tenantId: caller.context.tenantId,
    });
    const ownerBoundJob = linkedJob &&
      linkedJob.payload.actorId === caller.context.actorId &&
      (linkedJob.type === "capture.asset.process" || linkedJob.type === "knowledge.ingest")
      ? linkedJob
      : null;
    if (ownerBoundJob?.status === "queued" || ownerBoundJob?.status === "running") {
      return completeAppServiceCall(authorized, {
        asset,
        job: projectOperationJobStatus(ownerBoundJob),
        duplicate: true,
      });
    }
    const completedDocumentId = captureCompletedDocumentId(ownerBoundJob);
    if (completedDocumentId) {
      const repaired = await updateCaptureAssetStatus(asset.id, owner, {
        status: "indexed",
        extractionStatus: asset.extractionStatus,
        ingestJobId: asset.ingestJobId,
        expectedIngestJobId: asset.ingestJobId,
        knowledgeDocumentId: completedDocumentId,
      });
      return completeAppServiceCall(authorized, {
        asset: repaired,
        job: projectOperationJobStatus(ownerBoundJob!),
        duplicate: true,
        repaired: true,
      });
    }
    supersededIngestJobId = asset.ingestJobId;
  }
  const job = await enqueueCaptureAssetProcessJob({
    ...exactOwner(caller),
    executionScope: caller.executionScope!,
    idempotencyKey: supersededIngestJobId
      ? captureAssetRetryIdempotencyKey(caller, asset.id, supersededIngestJobId)
      : caller.idempotencyKey,
    request: {
      assetId: asset.id,
      ...(value.title ? { title: value.title } : {}),
      ...(value.note ? { note: value.note } : {}),
      ...(value.tags?.length ? { tags: value.tags } : {}),
    },
  });
  if (asset.ingestJobId === job.id) {
    if (supersededIngestJobId) {
      throw new Error("Capture asset retry did not create a fresh processing job.");
    }
    return completeAppServiceCall(authorized, {
      asset,
      job: projectOperationJobStatus(job),
      duplicate: true,
    });
  }
  const updated = await updateCaptureAssetStatus(asset.id, owner, {
    status: "queued",
    extractionStatus: "pending",
    ingestJobId: job.id,
    ...(asset.ingestJobId ? { expectedIngestJobId: asset.ingestJobId } : {}),
    clearExtractionReceipt: true,
  });
  return completeAppServiceCall(authorized, { asset: updated, job: projectOperationJobStatus(job) });
}

export async function previewAssetDeleteService(caller: AppServiceCaller, input: z.input<typeof targetSchema>) {
  const value = targetSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.delete.preview"));
  const owner = exactOwner(caller);
  let target: Record<string, unknown> | null;
  if (value.kind === "asset") {
    const item = await getCaptureAsset(value.id, owner);
    target = item ? {
      kind: value.kind, id: item.id, filename: item.filename,
      contentSha256: item.contentSha256, knowledgeDocumentId: item.knowledgeDocumentId,
      ingestJobId: item.ingestJobId,
    } : null;
  } else {
    const item = await getCaptureRecording(value.id, owner);
    target = item ? {
      kind: value.kind, id: item.id, title: item.title, source: item.source,
      segmentIds: item.segments.map((segment) => segment.id).sort(),
      knowledgeDocumentId: item.knowledgeDocumentId, ingestJobId: item.ingestJobId,
    } : null;
  }
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target), irreversible: true as const }, { resourceCount: target ? 1 : 0 });
}

export async function deleteAssetService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.assets.delete"));
  const preview = await previewAssetDeleteService(caller, { kind: value.kind, id: value.id });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) throw new Error("Asset deletion target changed after preview; review the exact target again.");
  const owner = { ...exactOwner(caller), executionScope: caller.executionScope! };
  let forgotten;
  if (value.kind === "asset") {
    const item = await getCaptureAsset(value.id, owner);
    if (!item) return completeAppServiceCall(authorized, { deleted: false }, { resourceCount: 0 });
    await cancelIngestJob(item.ingestJobId, caller.context.tenantId);
    forgotten = await deleteCaptureAssetWithKnowledge(item, owner);
  } else {
    const item = await getCaptureRecording(value.id, owner);
    if (!item) return completeAppServiceCall(authorized, { deleted: false }, { resourceCount: 0 });
    await cancelIngestJob(item.ingestJobId, caller.context.tenantId);
    forgotten = await deleteCaptureRecordingWithKnowledge(item, owner);
  }
  return completeAppServiceCall(authorized, { deleted: true, forgotten, target: preview.data.target, targetSha256: preview.data.targetSha256 });
}

async function cancelIngestJob(jobId: string | undefined, tenantId: string) {
  if (!jobId) return;
  const job = await getOperationJob(jobId, { tenantId });
  if (job?.dedupeKey) await cancelOperationJobByDedupeKey(job.dedupeKey, "Captured content deleted by its owner.", { tenantId });
}

function captureCompletedDocumentId(
  job: Awaited<ReturnType<typeof getOperationJob>>,
) {
  if (job?.status !== "completed") return undefined;
  const result = job.payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const documentId = (result as Record<string, unknown>).documentId;
  return typeof documentId === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(documentId)
    ? documentId
    : undefined;
}

function captureAssetRetryIdempotencyKey(
  caller: AppServiceCaller,
  assetId: string,
  previousIngestJobId: string,
) {
  return `capture-asset-retry:${canonicalJsonSha256({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    assetId,
    previousIngestJobId,
    requestId: caller.idempotencyKey || "",
  })}`;
}

function exactOwner(caller: AppServiceCaller) { return { tenantId: caller.context.tenantId, actorId: caller.context.actorId }; }
function readOwner(caller: AppServiceCaller) { return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) }; }
