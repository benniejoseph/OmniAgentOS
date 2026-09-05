import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import {
  knowledgeDeletionTargetId,
} from "@/lib/rag/deletion-events";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocumentsBySourcePrefix,
  listKnowledgeDocuments,
} from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("knowledge deletion events", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-knowledge-delete-"),
    );
  });

  it("deletes matching knowledge and records one metadata-only scoped event", async () => {
    const tenantId = "knowledge-delete";
    const actorId = "owner";
    const source = "google:drive:";
    await createKnowledgeDocument({
      tenantId,
      title: "Private strategy",
      content: "Never retain this private strategy.",
      source: `${source}document-1`,
      chunks: [{ index: 0, content: "Never retain this private strategy." }],
    });
    const mutation = {
      idempotencyKey: "knowledge-delete-1",
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: "knowledge-delete-request-1",
        causationId: knowledgeDeletionTargetId(source),
        purpose: "knowledge.delete_source",
      }),
    } as const;

    await expect(deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId, actorId, mutation,
    })).resolves.toMatchObject({ documents: 1 });
    await expect(deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId, actorId, mutation,
    })).resolves.toMatchObject({ documents: 0 });
    await expect(listKnowledgeDocuments(10, { tenantId })).resolves.toEqual([]);

    const events = await listStreamEvents(knowledgeDeletionTargetId(source), {
      tenantId,
      actorId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "knowledge.source_deleted",
      correlationId: "knowledge-delete-request-1",
      causationId: knowledgeDeletionTargetId(source),
      payload: {
        schemaVersion: 1,
        operation: "delete_source_prefix",
      },
    });
    const serialized = JSON.stringify(events[0].payload);
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain("Private strategy");
  });
});
