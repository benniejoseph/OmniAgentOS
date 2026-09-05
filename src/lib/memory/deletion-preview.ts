import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  canonicalizeMemoryDeletionIds,
  memoryDeletionManifestSha256,
} from "@/lib/memory/deletion-receipt";
import type { MemoryType } from "@/lib/memory/types";

export const MEMORY_DELETION_PREVIEW_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const previewMemorySchema = z.object({
  id: z.string().min(1).max(240),
  title: z.string().max(240),
  type: z.enum([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]),
}).strict();

export const memoryDeletionPreviewV1Schema = z.object({
  schemaVersion: z.literal(MEMORY_DELETION_PREVIEW_SCHEMA_VERSION),
  contractKind: z.literal("memory_deletion_preview"),
  state: z.enum(["ready", "already_deleted"]),
  guarantee: z.enum(["rollback_proof_barrier", "best_effort"]),
  memory: previewMemorySchema,
  descendantMemories: z.array(previewMemorySchema),
  impact: z.object({
    rootMemoryCount: z.literal(1),
    descendantMemoryCount: z.number().int().min(0),
    retrievalTraceCount: z.number().int().min(0),
    graphNodeCount: z.number().int().min(0),
    graphEdgeCount: z.number().int().min(0),
    pendingAgentRunCount: z.number().int().min(0),
    pendingWorkflowRunCount: z.number().int().min(0),
  }).strict(),
  expectedReceiptManifestSha256: sha256Schema,
  generatedAt: timestampSchema,
}).strict().superRefine((preview, context) => {
  if (preview.impact.descendantMemoryCount !== preview.descendantMemories.length) {
    context.addIssue({
      code: "custom",
      message: "The deletion preview must enumerate every descendant memory.",
      path: ["descendantMemories"],
    });
  }
  const ids = preview.descendantMemories.map((memory) => memory.id);
  const canonicalIds = canonicalizeMemoryDeletionIds(ids);
  if (
    canonicalIds.length !== ids.length ||
    canonicalIds.some((id, index) => id !== ids[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "Descendant memories must be unique and canonically ordered.",
      path: ["descendantMemories"],
    });
  }
});

export type MemoryDeletionPreviewV1 = z.infer<
  typeof memoryDeletionPreviewV1Schema
>;

type PreviewMemory = {
  id: string;
  title: string;
  type: MemoryType;
};

export function buildMemoryDeletionPreviewV1(input: {
  tenantId: string;
  state?: MemoryDeletionPreviewV1["state"];
  guarantee: MemoryDeletionPreviewV1["guarantee"];
  memory: PreviewMemory;
  descendantMemories: readonly PreviewMemory[];
  retrievalTraceIds: readonly string[];
  graphNodeIds: readonly string[];
  graphEdgeIds: readonly string[];
  pendingAgentRunIds?: readonly string[];
  pendingWorkflowRunIds?: readonly string[];
  generatedAt?: string;
}): MemoryDeletionPreviewV1 {
  const descendantMemories = [...input.descendantMemories]
    .map((memory) => previewMemorySchema.parse(memory))
    .sort((left, right) => comparePostgresCText(left.id, right.id));
  const descendantMemoryIds = canonicalizeMemoryDeletionIds(
    descendantMemories.map((memory) => memory.id),
  );
  const retrievalTraceIds = canonicalizeMemoryDeletionIds(
    input.retrievalTraceIds,
  );
  const graphNodeIds = canonicalizeMemoryDeletionIds(input.graphNodeIds);
  const graphEdgeIds = canonicalizeMemoryDeletionIds(input.graphEdgeIds);
  const pendingAgentRunIds = canonicalizeMemoryDeletionIds(
    input.pendingAgentRunIds || [],
  );
  const pendingWorkflowRunIds = canonicalizeMemoryDeletionIds(
    input.pendingWorkflowRunIds || [],
  );

  return memoryDeletionPreviewV1Schema.parse({
    schemaVersion: MEMORY_DELETION_PREVIEW_SCHEMA_VERSION,
    contractKind: "memory_deletion_preview",
    state: input.state || "ready",
    guarantee: input.guarantee,
    memory: previewMemorySchema.parse(input.memory),
    descendantMemories,
    impact: {
      rootMemoryCount: 1,
      descendantMemoryCount: descendantMemories.length,
      retrievalTraceCount: retrievalTraceIds.length,
      graphNodeCount: graphNodeIds.length,
      graphEdgeCount: graphEdgeIds.length,
      pendingAgentRunCount: pendingAgentRunIds.length,
      pendingWorkflowRunCount: pendingWorkflowRunIds.length,
    },
    expectedReceiptManifestSha256: memoryDeletionManifestSha256({
      tenantId: input.tenantId,
      memoryId: input.memory.id,
      descendantMemoryIds,
      retrievalTraceIds,
      graphNodeIds,
      graphEdgeIds,
    }),
    generatedAt: input.generatedAt || new Date().toISOString(),
  });
}

function comparePostgresCText(left: string, right: string) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
