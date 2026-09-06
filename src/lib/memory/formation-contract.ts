import { z } from "zod";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { MemoryRecord } from "@/lib/memory/types";

export const MEMORY_FORMATION_SCHEMA_VERSION = 1 as const;

export const memoryFormationOriginSchema = z.enum([
  "user_assertion",
  "source_observation",
  "verified_effect",
  "assistant_inference",
]);

export type MemoryFormationOrigin = z.infer<
  typeof memoryFormationOriginSchema
>;

const memoryFormationEventPayloadSchema = z.object({
  schemaVersion: z.literal(MEMORY_FORMATION_SCHEMA_VERSION),
  payloadKind: z.literal("memory_formation_receipt"),
  memoryId: z.string().trim().min(1).max(200),
  memoryType: z.enum([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]),
  origin: memoryFormationOriginSchema,
  claimStatus: z.enum([
    "active",
    "candidate",
    "superseded",
    "contradicted",
    "forgotten",
  ]),
  assertedBy: z.enum(["user", "agent", "system", "import"]),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  evidenceSetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  formedAt: z.string().datetime({ offset: true }),
  formationReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type MemoryFormationEventPayloadV1 = z.infer<
  typeof memoryFormationEventPayloadSchema
>;

export function buildMemoryFormationEvent(input: {
  record: MemoryRecord;
  origin: MemoryFormationOrigin;
  executionScope: ExecutionScope;
}) {
  const origin = memoryFormationOriginSchema.parse(input.origin);
  const record = input.record;
  const tenantId = record.tenantId?.trim();
  const claimStatus = record.claimStatus || "active";
  const assertedBy = record.assertedBy || "system";
  const evidenceRefs = [...new Set(record.evidenceRefs || [])];
  if (!tenantId || tenantId !== input.executionScope.tenantId) {
    throw new Error("Memory formation scope does not match its record tenant.");
  }
  assertFormationBoundary(record, origin, claimStatus, assertedBy, evidenceRefs);

  const body = {
    schemaVersion: MEMORY_FORMATION_SCHEMA_VERSION,
    payloadKind: "memory_formation_receipt" as const,
    memoryId: record.id,
    memoryType: record.type,
    origin,
    claimStatus,
    assertedBy,
    evidenceRefs,
    evidenceSetSha256: sourceContractSha256(evidenceRefs),
    contentSha256: sourceContractSha256({
      title: record.title,
      content: record.content,
    }),
    formedAt: record.createdAt,
  };
  const payload = memoryFormationEventPayloadSchema.parse({
    ...body,
    formationReceiptSha256: sourceContractSha256(body),
  });
  return {
    id: `memory_formation_${sourceContractSha256({
      tenantId,
      memoryId: record.id,
    })}`,
    streamId: `memory:${record.id}`,
    type: "memory.formation.recorded",
    executionScope: input.executionScope,
    payload,
  } as const;
}

function assertFormationBoundary(
  record: MemoryRecord,
  origin: MemoryFormationOrigin,
  claimStatus: NonNullable<MemoryRecord["claimStatus"]>,
  assertedBy: NonNullable<MemoryRecord["assertedBy"]>,
  evidenceRefs: string[],
) {
  const has = (prefix: string) =>
    evidenceRefs.some((reference) => reference.startsWith(prefix));

  if (origin === "assistant_inference") {
    if (
      claimStatus !== "candidate" ||
      assertedBy !== "agent" ||
      !has("run:")
    ) {
      throw new Error(
        "Assistant-derived memory must remain an evidenced inference candidate.",
      );
    }
    return;
  }
  if (claimStatus !== "active") {
    throw new Error("Evidence-backed memory formation must begin active.");
  }
  if (origin === "user_assertion") {
    if (
      assertedBy !== "user" ||
      record.accessBinding?.visibility !== "user_private" ||
      !has("thread:") ||
      !has("turn:")
    ) {
      throw new Error(
        "User assertions require a private owner binding and source turn.",
      );
    }
    return;
  }
  if (origin === "source_observation") {
    if (
      assertedBy !== "import" ||
      record.type !== "knowledge" ||
      !has("knowledge:") ||
      !has("evidence:")
    ) {
      throw new Error(
        "Source observations require canonical knowledge and evidence lineage.",
      );
    }
    return;
  }
  if (
    assertedBy !== "system" ||
    record.type !== "episode" ||
    !has("run:") ||
    !has("tool-execution:") ||
    !has("effect-receipt:")
  ) {
    throw new Error(
      "Verified-effect episodes require run, execution, and receipt evidence.",
    );
  }
}
