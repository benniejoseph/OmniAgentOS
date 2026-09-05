import { describe, expect, it } from "vitest";
import {
  buildMemoryDeletionPreviewV1,
  memoryDeletionPreviewV1Schema,
} from "@/lib/memory/deletion-preview";

describe("memory deletion preview", () => {
  it("enumerates descendants canonically and binds the future receipt manifest", () => {
    const preview = buildMemoryDeletionPreviewV1({
      tenantId: "tenant-a",
      guarantee: "rollback_proof_barrier",
      memory: { id: "memory-root", title: "Root", type: "fact" },
      descendantMemories: [
        { id: "memory-z", title: "Later", type: "decision" },
        { id: "memory-a", title: "Earlier", type: "knowledge" },
      ],
      retrievalTraceIds: ["trace-b", "trace-a"],
      graphNodeIds: ["node-a"],
      graphEdgeIds: ["edge-b", "edge-a"],
      pendingAgentRunIds: ["run-a"],
      pendingWorkflowRunIds: ["workflow-a", "workflow-b"],
      generatedAt: "2026-09-05T00:00:00.000Z",
    });

    expect(preview.descendantMemories.map((memory) => memory.id)).toEqual([
      "memory-a",
      "memory-z",
    ]);
    expect(preview.impact).toEqual({
      rootMemoryCount: 1,
      descendantMemoryCount: 2,
      retrievalTraceCount: 2,
      graphNodeCount: 1,
      graphEdgeCount: 2,
      pendingAgentRunCount: 1,
      pendingWorkflowRunCount: 2,
    });
    expect(preview.expectedReceiptManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a preview that does not enumerate its declared impact", () => {
    const preview = buildMemoryDeletionPreviewV1({
      tenantId: "tenant-a",
      guarantee: "best_effort",
      memory: { id: "memory-root", title: "Root", type: "fact" },
      descendantMemories: [],
      retrievalTraceIds: [],
      graphNodeIds: [],
      graphEdgeIds: [],
      generatedAt: "2026-09-05T00:00:00.000Z",
    });

    expect(() => memoryDeletionPreviewV1Schema.parse({
      ...preview,
      impact: { ...preview.impact, descendantMemoryCount: 1 },
    })).toThrow("enumerate every descendant");
  });
});
