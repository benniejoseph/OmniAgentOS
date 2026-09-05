import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CaptureAsset,
  CaptureRecordingDetail,
} from "@/lib/capture/types";
import { createExecutionScope } from "@/lib/security/execution-scope";

const dbMocks = vi.hoisted(() => {
  const sql = vi.fn(async () => []) as ReturnType<typeof vi.fn> & {
    transaction: ReturnType<typeof vi.fn>;
  };
  sql.transaction = vi.fn(
    (callback: (transactionSql: typeof sql) => Promise<unknown>) =>
      callback(sql),
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    sql,
  };
});

const captureMocks = vi.hoisted(() => ({
  deleteCaptureAsset: vi.fn(async () => true),
  deleteCaptureRecording: vi.fn(async () => true),
  deleteKnowledgeDocumentsBySourcePrefix: vi.fn(async () => ({
    documents: 1,
    memories: 2,
  })),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
}));

vi.mock("@/lib/capture/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture/assets")>()),
  deleteCaptureAsset: captureMocks.deleteCaptureAsset,
}));

vi.mock("@/lib/capture/recordings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture/recordings")>()),
  deleteCaptureRecording: captureMocks.deleteCaptureRecording,
}));

vi.mock("@/lib/rag/store", () => ({
  deleteKnowledgeDocumentsBySourcePrefix:
    captureMocks.deleteKnowledgeDocumentsBySourcePrefix,
}));

import {
  deleteCaptureAssetWithKnowledge,
  deleteCaptureRecordingWithKnowledge,
} from "@/lib/capture/deletion";

const owner = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  executionScope: createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "owner-a",
    executingPrincipalType: "user",
    executingPrincipalId: "owner-a",
    correlationId: "capture-delete-request-a",
    causationId: "capture-a",
    purpose: "capture.delete.test",
  }),
};

const asset = {
  id: "asset-a",
  tenantId: owner.tenantId,
  actorId: owner.actorId,
} as CaptureAsset;

const recording = {
  id: "recording-a",
  tenantId: owner.tenantId,
  actorId: owner.actorId,
  source: "capture:recording:recording-a",
} as CaptureRecordingDetail;

describe("atomic capture deletion", () => {
  beforeEach(() => {
    dbMocks.ensureDatabaseSchema.mockClear();
    dbMocks.getSql.mockClear();
    dbMocks.sql.transaction.mockClear();
    captureMocks.deleteCaptureAsset.mockClear().mockResolvedValue(true);
    captureMocks.deleteCaptureRecording.mockClear().mockResolvedValue(true);
    captureMocks.deleteKnowledgeDocumentsBySourcePrefix
      .mockClear()
      .mockResolvedValue({ documents: 1, memories: 2 });
  });

  it("deletes an asset before scrubbing its descendants on one transaction client", async () => {
    await expect(deleteCaptureAssetWithKnowledge(asset, owner)).resolves.toEqual({
      documents: 1,
      memories: 2,
    });

    expect(dbMocks.sql.transaction).toHaveBeenCalledTimes(1);
    expect(captureMocks.deleteCaptureAsset).toHaveBeenCalledWith(
      asset.id,
      owner,
      { sql: dbMocks.sql, asset },
    );
    expect(
      captureMocks.deleteKnowledgeDocumentsBySourcePrefix,
    ).toHaveBeenCalledWith(`capture:asset:${asset.id}`, {
      tenantId: owner.tenantId,
      invalidationScope: owner.executionScope,
      sql: dbMocks.sql,
    });
    expect(
      captureMocks.deleteCaptureAsset.mock.invocationCallOrder[0],
    ).toBeLessThan(
      captureMocks.deleteKnowledgeDocumentsBySourcePrefix.mock
        .invocationCallOrder[0],
    );
  });

  it("deletes a recording before scrubbing its descendants on one transaction client", async () => {
    await expect(
      deleteCaptureRecordingWithKnowledge(recording, owner),
    ).resolves.toEqual({ documents: 1, memories: 2 });

    expect(dbMocks.sql.transaction).toHaveBeenCalledTimes(1);
    expect(captureMocks.deleteCaptureRecording).toHaveBeenCalledWith(
      recording.id,
      owner,
      { sql: dbMocks.sql, recording },
    );
    expect(
      captureMocks.deleteKnowledgeDocumentsBySourcePrefix,
    ).toHaveBeenCalledWith(recording.source, {
      tenantId: owner.tenantId,
      invalidationScope: owner.executionScope,
      sql: dbMocks.sql,
    });
  });
});
