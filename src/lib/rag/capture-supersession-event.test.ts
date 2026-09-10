import { describe, expect, it } from "vitest";

import { buildCaptureKnowledgeSupersessionEvent } from "@/lib/rag/capture-supersession-event";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("Capture knowledge supersession event receipt", () => {
  it("binds identity to the complete metadata receipt and governed scope", () => {
    const first = event({ correlationId: "job-one" });
    const replay = event({ correlationId: "job-one" });
    const otherCaller = event({ correlationId: "job-two" });
    const otherCounts = event({ correlationId: "job-one", retiredMemoryCount: 3 });
    const otherTime = event({
      correlationId: "job-one",
      retiredAt: "2026-09-10T10:01:00.000Z",
    });

    expect(replay).toEqual(first);
    expect(otherCaller.id).not.toBe(first.id);
    expect(otherCounts.id).not.toBe(first.id);
    expect(otherTime.id).not.toBe(first.id);
    expect(first).toMatchObject({
      type: "knowledge.source_generation_retired",
      payload: {
        schemaVersion: 1,
        sourceItemId: "source-item",
        currentDocumentId: "current-document",
        retiredDocumentCount: 1,
        retiredMemoryCount: 2,
        retiredAt: "2026-09-10T10:00:00.000Z",
      },
    });
    expect(Object.keys(first.payload).sort()).toEqual([
      "currentDocumentId",
      "retiredAt",
      "retiredDocumentCount",
      "retiredMemoryCount",
      "schemaVersion",
      "sourceItemId",
    ]);
  });
});

function event({
  correlationId,
  retiredMemoryCount = 2,
  retiredAt = "2026-09-10T10:00:00.000Z",
}: {
  correlationId: string;
  retiredMemoryCount?: number;
  retiredAt?: string;
}) {
  return buildCaptureKnowledgeSupersessionEvent({
    tenantId: "tenant-capture",
    sourceItemId: "source-item",
    keepDocumentId: "current-document",
    retiredDocumentCount: 1,
    retiredMemoryCount,
    retiredAt,
    executionScope: createExecutionScope({
      tenantId: "tenant-capture",
      initiatingActorId: "owner-capture",
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      correlationId,
      causationId: correlationId,
      purpose: "capture.ingest.source.index",
    }),
  });
}
