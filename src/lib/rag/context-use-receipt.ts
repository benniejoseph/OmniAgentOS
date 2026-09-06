import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContextSelectionLockBinding } from "@/lib/rag/context-selection-lock";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?:memory|knowledge|graph):[^\s]+$/);
const evidenceIdsSchema = z.array(evidenceIdSchema)
  .max(24)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Context receipt evidence IDs must be unique.",
  });

const contextUseReceiptBodySchema = z.object({
  schemaVersion: z.literal(1),
  receiptType: z.literal("context_use"),
  runId: z.string().min(1).max(240),
  lockId: z.string().uuid(),
  previewId: z.string().uuid(),
  querySha256: sha256Schema,
  candidateSetSha256: sha256Schema,
  contextPackSha256: sha256Schema,
  previewReceiptSha256: sha256Schema,
  selectionSha256: sha256Schema,
  candidateEvidenceIds: evidenceIdsSchema,
  userInclusionIds: evidenceIdsSchema,
  userExclusionIds: evidenceIdsSchema,
  actualEvidenceIds: evidenceIdsSchema,
  droppedEvidenceIds: evidenceIdsSchema,
  candidateCount: z.number().int().min(0).max(24),
  includedCount: z.number().int().min(0).max(24),
  excludedCount: z.number().int().min(0).max(24),
  actualCount: z.number().int().min(0).max(24),
  droppedCount: z.number().int().min(0).max(24),
  retrievalTraceId: z.string().min(1).max(240).nullable(),
  contextManifestSha256: sha256Schema.nullable(),
  compiledContextSha256: sha256Schema,
  contextBudgetSha256: sha256Schema,
  recordedAt: z.string().datetime(),
}).strict();

export const contextUseReceiptV1Schema = contextUseReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict();

export type ContextUseReceiptV1 = z.infer<typeof contextUseReceiptV1Schema>;

export function buildContextUseReceiptV1(input: {
  runId: string;
  selection: ContextSelectionLockBinding;
  actualEvidenceIds: readonly string[];
  retrievalTraceId?: string;
  contextManifestSha256?: string;
  compiledContext: string;
  contextBudget: unknown;
  recordedAt?: string;
}): ContextUseReceiptV1 {
  const actualEvidenceIds = evidenceIdsSchema.parse(uniqueInOrder(input.actualEvidenceIds));
  const included = new Set(input.selection.evidenceIds);
  if (actualEvidenceIds.some((id) => !included.has(id))) {
    throw new Error("Actual context contains evidence outside the locked selection.");
  }
  const actual = new Set(actualEvidenceIds);
  const droppedEvidenceIds = input.selection.evidenceIds.filter((id) => !actual.has(id));
  const body = contextUseReceiptBodySchema.parse({
    schemaVersion: 1,
    receiptType: "context_use",
    runId: input.runId,
    lockId: input.selection.lockId,
    previewId: input.selection.previewId,
    querySha256: input.selection.querySha256,
    candidateSetSha256: input.selection.candidateSetSha256,
    contextPackSha256: input.selection.contextPackSha256,
    previewReceiptSha256: input.selection.previewReceiptSha256,
    selectionSha256: input.selection.selectionSha256,
    candidateEvidenceIds: input.selection.candidateEvidenceIds,
    userInclusionIds: input.selection.evidenceIds,
    userExclusionIds: input.selection.excludedEvidenceIds,
    actualEvidenceIds,
    droppedEvidenceIds,
    candidateCount: input.selection.candidateEvidenceIds.length,
    includedCount: input.selection.evidenceIds.length,
    excludedCount: input.selection.excludedEvidenceIds.length,
    actualCount: actualEvidenceIds.length,
    droppedCount: droppedEvidenceIds.length,
    retrievalTraceId: input.retrievalTraceId || null,
    contextManifestSha256: input.contextManifestSha256 || null,
    compiledContextSha256: sha256(input.compiledContext),
    contextBudgetSha256: sha256CanonicalJson(input.contextBudget),
    recordedAt: input.recordedAt || new Date().toISOString(),
  });
  return contextUseReceiptV1Schema.parse({
    ...body,
    receiptSha256: sha256CanonicalJson(body),
  });
}

export function parseContextUseReceiptV1(value: unknown): ContextUseReceiptV1 {
  const receipt = contextUseReceiptV1Schema.parse(value);
  const { receiptSha256, ...body } = receipt;
  if (sha256CanonicalJson(body) !== receiptSha256) {
    throw new Error("Context use receipt digest is invalid.");
  }
  if (
    receipt.candidateCount !== receipt.candidateEvidenceIds.length ||
    receipt.includedCount !== receipt.userInclusionIds.length ||
    receipt.excludedCount !== receipt.userExclusionIds.length ||
    receipt.actualCount !== receipt.actualEvidenceIds.length ||
    receipt.droppedCount !== receipt.droppedEvidenceIds.length
  ) {
    throw new Error("Context use receipt counts are invalid.");
  }
  const included = new Set(receipt.userInclusionIds);
  const excluded = new Set(receipt.userExclusionIds);
  const actual = new Set(receipt.actualEvidenceIds);
  if (
    receipt.candidateEvidenceIds.some((id) => !included.has(id) && !excluded.has(id)) ||
    receipt.userInclusionIds.some((id) => !receipt.candidateEvidenceIds.includes(id) || excluded.has(id)) ||
    receipt.userExclusionIds.some((id) => !receipt.candidateEvidenceIds.includes(id)) ||
    receipt.actualEvidenceIds.some((id) => !included.has(id)) ||
    receipt.droppedEvidenceIds.some((id) => !included.has(id) || actual.has(id))
  ) {
    throw new Error("Context use receipt evidence partition is invalid.");
  }
  return receipt;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256CanonicalJson(value: unknown) {
  return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function uniqueInOrder(values: readonly string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}
