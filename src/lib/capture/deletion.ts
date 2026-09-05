import {
  CaptureAssetError,
  deleteCaptureAsset,
} from "@/lib/capture/assets";
import {
  CaptureRecordingError,
  deleteCaptureRecording,
} from "@/lib/capture/recordings";
import type {
  CaptureAsset,
  CaptureRecordingDetail,
} from "@/lib/capture/types";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";

type CaptureDeletionOwner = {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
};

export async function deleteCaptureAssetWithKnowledge(
  asset: CaptureAsset,
  owner: CaptureDeletionOwner,
) {
  const source = `capture:asset:${asset.id}`;
  if (!hasDatabaseUrl()) {
    const forgotten = await deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId: owner.tenantId,
    });
    await deleteCaptureAsset(asset.id, owner, { asset });
    return forgotten;
  }

  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const deleted = await deleteCaptureAsset(asset.id, owner, { sql, asset });
    if (!deleted) {
      throw new CaptureAssetError("Captured file not found.", 404);
    }
    return deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId: owner.tenantId,
      invalidationScope: owner.executionScope,
      sql,
    });
  });
}

export async function deleteCaptureRecordingWithKnowledge(
  recording: CaptureRecordingDetail,
  owner: CaptureDeletionOwner,
) {
  if (!hasDatabaseUrl()) {
    const forgotten = await deleteKnowledgeDocumentsBySourcePrefix(
      recording.source,
      { tenantId: owner.tenantId },
    );
    await deleteCaptureRecording(recording.id, owner, { recording });
    return forgotten;
  }

  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const deleted = await deleteCaptureRecording(recording.id, owner, {
      sql,
      recording,
    });
    if (!deleted) {
      throw new CaptureRecordingError("Recording not found.", 404);
    }
    return deleteKnowledgeDocumentsBySourcePrefix(recording.source, {
      tenantId: owner.tenantId,
      invalidationScope: owner.executionScope,
      sql,
    });
  });
}
