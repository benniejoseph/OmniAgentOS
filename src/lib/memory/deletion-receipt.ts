import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export const MEMORY_DELETION_RECEIPT_SCHEMA_VERSION = 1 as const;

const receiptIdentityIdSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim().length > 0, "IDs cannot be blank.")
  .refine((value) => !value.includes("\0"), "IDs cannot contain NUL bytes.");
const manifestIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "IDs cannot be blank.")
  .refine((value) => !value.includes("\0"), "IDs cannot contain NUL bytes.");
const executionScopeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0, "IDs cannot be blank.")
  .refine((value) => !value.includes("\0"), "IDs cannot contain NUL bytes.");
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase hexadecimal SHA-256 digest.");
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => new Date(value).toISOString() === value,
    "Expected a canonical UTC timestamp with millisecond precision.",
  );
const nullableExecutionScopeIdSchema = executionScopeIdSchema.nullable();
const canonicalOpaqueIdsSchema = z.array(manifestIdSchema)
  .superRefine((ids, context) => {
    const sorted = [...ids].sort(comparePostgresCText);
    ids.forEach((id, index) => {
      if (index > 0 && ids[index - 1] === id) {
        context.addIssue({
          code: "custom",
          message: "IDs must be unique.",
          path: [index],
        });
      }
      if (sorted[index] !== id) {
        context.addIssue({
          code: "custom",
          message: "IDs must use canonical lexical order.",
          path: [index],
        });
      }
    });
  });
const scopeOpaqueIdsSchema = z.array(executionScopeIdSchema).max(256)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: "Execution-scope IDs must be unique.",
          path: [index],
        });
      }
      seen.add(id);
    });
  });
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const executionScopeSchema = z.object({
  version: z.literal(1),
  tenantId: executionScopeIdSchema,
  initiatingActorId: nullableExecutionScopeIdSchema,
  executingPrincipalType: z.enum(["user", "agent", "system"]),
  executingPrincipalId: nullableExecutionScopeIdSchema,
  workspaceId: nullableExecutionScopeIdSchema,
  projectId: nullableExecutionScopeIdSchema,
  missionId: nullableExecutionScopeIdSchema,
  delegationId: nullableExecutionScopeIdSchema,
  correlationId: executionScopeIdSchema,
  causationId: nullableExecutionScopeIdSchema,
  contextGrantIds: scopeOpaqueIdsSchema,
  capabilityGrantIds: scopeOpaqueIdsSchema,
  purpose: z.string().trim().min(1).max(500),
}).strict();

const memoryDeletionReceiptBaseSchema = z.object({
  schemaVersion: z.literal(MEMORY_DELETION_RECEIPT_SCHEMA_VERSION),
  contractKind: z.literal("memory_deletion"),
  id: receiptIdentityIdSchema,
  tenantId: receiptIdentityIdSchema,
  memoryId: receiptIdentityIdSchema,
  attributionKind: z.enum(["scope_bound", "legacy_unattributed"]),
  initiatingActorId: nullableExecutionScopeIdSchema,
  executingPrincipalType: z.enum(["user", "agent", "system"]).nullable(),
  executingPrincipalId: nullableExecutionScopeIdSchema,
  correlationId: nullableExecutionScopeIdSchema,
  causationId: nullableExecutionScopeIdSchema,
  purpose: z.string().trim().min(1).max(500).nullable(),
  executionScope: executionScopeSchema.nullable(),
  executionScopeSha256: sha256Schema.nullable(),
  receiptSha256: sha256Schema.nullable(),
  deleteReason: z.enum(["explicit_forget", "legacy_unattributed"]),
  descendantMemoryIds: canonicalOpaqueIdsSchema,
  retrievalTraceIds: canonicalOpaqueIdsSchema,
  graphNodeIds: canonicalOpaqueIdsSchema,
  graphEdgeIds: canonicalOpaqueIdsSchema,
  descendantMemoryCount: countSchema,
  retrievalTraceCount: countSchema,
  graphNodeCount: countSchema,
  graphEdgeCount: countSchema,
  descendantManifestSha256: sha256Schema.nullable(),
  forgottenAt: canonicalTimestampSchema,
  createdAt: canonicalTimestampSchema,
}).strict();

export const memoryDeletionReceiptV1Schema = memoryDeletionReceiptBaseSchema
  .superRefine((receipt, context) => {
    validateCounts(receipt, context);
    if (receipt.descendantMemoryIds.includes(receipt.memoryId)) {
      context.addIssue({
        code: "custom",
        message: "The forgotten root cannot also be a descendant.",
        path: ["descendantMemoryIds"],
      });
    }

    if (receipt.attributionKind === "scope_bound") {
      validateScopeBoundReceipt(receipt, context);
    } else {
      validateLegacyReceipt(receipt, context);
    }
  });

export type MemoryDeletionReceiptV1 = z.infer<
  typeof memoryDeletionReceiptV1Schema
>;

export type BuildMemoryDeletionReceiptV1Input = {
  tenantId: string;
  memoryId: string;
  executionScope: ExecutionScope;
  descendantMemoryIds: readonly string[];
  retrievalTraceIds: readonly string[];
  graphNodeIds: readonly string[];
  graphEdgeIds: readonly string[];
  forgottenAt?: string;
  createdAt?: string;
};

export function buildMemoryDeletionReceiptV1(
  input: BuildMemoryDeletionReceiptV1Input,
): MemoryDeletionReceiptV1 {
  const executionScope = executionScopeSchema.parse(input.executionScope);
  const tenantId = receiptIdentityIdSchema.parse(input.tenantId);
  const memoryId = receiptIdentityIdSchema.parse(input.memoryId);
  if (executionScope.tenantId !== tenantId) {
    throw new Error("Memory deletion scope tenant does not match the receipt tenant.");
  }
  if (!executionScope.initiatingActorId) {
    throw new Error("Memory deletion requires a non-null initiating actor.");
  }

  const descendantMemoryIds = canonicalizeOpaqueIds(input.descendantMemoryIds);
  const retrievalTraceIds = canonicalizeOpaqueIds(input.retrievalTraceIds);
  const graphNodeIds = canonicalizeOpaqueIds(input.graphNodeIds);
  const graphEdgeIds = canonicalizeOpaqueIds(input.graphEdgeIds);
  const forgottenAt = canonicalTimestampSchema.parse(
    input.forgottenAt || new Date().toISOString(),
  );
  const createdAt = canonicalTimestampSchema.parse(input.createdAt || forgottenAt);
  const descendantManifestSha256 = memoryDeletionManifestSha256({
    tenantId,
    memoryId,
    descendantMemoryIds,
    retrievalTraceIds,
    graphNodeIds,
    graphEdgeIds,
  });

  const body = {
    schemaVersion: MEMORY_DELETION_RECEIPT_SCHEMA_VERSION,
    contractKind: "memory_deletion" as const,
    id: memoryDeletionReceiptId({ tenantId, memoryId }),
    tenantId,
    memoryId,
    attributionKind: "scope_bound",
    initiatingActorId: executionScope.initiatingActorId,
    executingPrincipalType: executionScope.executingPrincipalType,
    executingPrincipalId: executionScope.executingPrincipalId,
    correlationId: executionScope.correlationId,
    causationId: executionScope.causationId,
    purpose: executionScope.purpose,
    executionScope,
    executionScopeSha256: memoryDeletionContractSha256(executionScope),
    deleteReason: "explicit_forget" as const,
    descendantMemoryIds,
    retrievalTraceIds,
    graphNodeIds,
    graphEdgeIds,
    descendantMemoryCount: descendantMemoryIds.length,
    retrievalTraceCount: retrievalTraceIds.length,
    graphNodeCount: graphNodeIds.length,
    graphEdgeCount: graphEdgeIds.length,
    descendantManifestSha256,
    forgottenAt,
    createdAt,
  };
  return memoryDeletionReceiptV1Schema.parse({
    ...body,
    receiptSha256: memoryDeletionContractSha256(body),
  });
}

export function parseMemoryDeletionReceiptV1(
  value: unknown,
): MemoryDeletionReceiptV1 {
  return memoryDeletionReceiptV1Schema.parse(value);
}

export function publicMemoryDeletionReceiptV1(receipt: MemoryDeletionReceiptV1) {
  const parsed = parseMemoryDeletionReceiptV1(receipt);
  return {
    schemaVersion: parsed.schemaVersion,
    contractKind: parsed.contractKind,
    id: parsed.id,
    memoryId: parsed.memoryId,
    attributionKind: parsed.attributionKind,
    deleteReason: parsed.deleteReason,
    forgottenAt: parsed.forgottenAt,
    descendantMemoryCount: parsed.descendantMemoryCount,
    retrievalTraceCount: parsed.retrievalTraceCount,
    graphNodeCount: parsed.graphNodeCount,
    graphEdgeCount: parsed.graphEdgeCount,
    descendantManifestSha256: parsed.descendantManifestSha256,
    receiptSha256: parsed.receiptSha256,
    createdAt: parsed.createdAt,
  };
}

export function memoryDeletionReceiptId(input: {
  tenantId: string;
  memoryId: string;
}) {
  return `memory_deletion_${memoryDeletionContractSha256({
    tenantId: receiptIdentityIdSchema.parse(input.tenantId),
    memoryId: receiptIdentityIdSchema.parse(input.memoryId),
  }).slice(0, 56)}`;
}

export function memoryDeletionManifestSha256(input: {
  tenantId: string;
  memoryId: string;
  descendantMemoryIds: readonly string[];
  retrievalTraceIds: readonly string[];
  graphNodeIds: readonly string[];
  graphEdgeIds: readonly string[];
}) {
  const descendantMemoryIds = canonicalizeOpaqueIds(input.descendantMemoryIds);
  const retrievalTraceIds = canonicalizeOpaqueIds(input.retrievalTraceIds);
  const graphNodeIds = canonicalizeOpaqueIds(input.graphNodeIds);
  const graphEdgeIds = canonicalizeOpaqueIds(input.graphEdgeIds);
  return memoryDeletionContractSha256({
    tenantId: receiptIdentityIdSchema.parse(input.tenantId),
    memoryId: receiptIdentityIdSchema.parse(input.memoryId),
    descendantMemoryIds,
    descendantMemoryCount: descendantMemoryIds.length,
    retrievalTraceIds,
    retrievalTraceCount: retrievalTraceIds.length,
    graphNodeIds,
    graphNodeCount: graphNodeIds.length,
    graphEdgeIds,
    graphEdgeCount: graphEdgeIds.length,
  });
}

export function memoryDeletionContractSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function validateCounts(
  receipt: z.infer<typeof memoryDeletionReceiptBaseSchema>,
  context: z.RefinementCtx,
) {
  const pairs = [
    ["descendantMemoryCount", receipt.descendantMemoryCount, receipt.descendantMemoryIds.length],
    ["retrievalTraceCount", receipt.retrievalTraceCount, receipt.retrievalTraceIds.length],
    ["graphNodeCount", receipt.graphNodeCount, receipt.graphNodeIds.length],
    ["graphEdgeCount", receipt.graphEdgeCount, receipt.graphEdgeIds.length],
  ] as const;
  for (const [field, actual, expected] of pairs) {
    if (actual !== expected) {
      context.addIssue({
        code: "custom",
        message: "Count must equal the canonical ID-list cardinality.",
        path: [field],
      });
    }
  }
}

function validateScopeBoundReceipt(
  receipt: z.infer<typeof memoryDeletionReceiptBaseSchema>,
  context: z.RefinementCtx,
) {
  const scope = receipt.executionScope;
  if (
    !scope ||
    !receipt.initiatingActorId ||
    !receipt.executingPrincipalType ||
    !receipt.correlationId ||
    !receipt.purpose ||
    !receipt.executionScopeSha256 ||
    !receipt.receiptSha256 ||
    !receipt.descendantManifestSha256 ||
    receipt.deleteReason !== "explicit_forget"
  ) {
    context.addIssue({
      code: "custom",
      message: "A scope-bound deletion receipt requires complete attribution and digests.",
    });
    return;
  }
  const expectedScopeFields = {
    tenantId: receipt.tenantId,
    initiatingActorId: receipt.initiatingActorId,
    executingPrincipalType: receipt.executingPrincipalType,
    executingPrincipalId: receipt.executingPrincipalId,
    correlationId: receipt.correlationId,
    causationId: receipt.causationId,
    purpose: receipt.purpose,
  };
  for (const [field, expected] of Object.entries(expectedScopeFields)) {
    if (scope[field as keyof typeof expectedScopeFields] !== expected) {
      context.addIssue({
        code: "custom",
        message: `Execution scope ${field} does not match receipt attribution.`,
        path: ["executionScope", field],
      });
    }
  }
  if (receipt.executionScopeSha256 !== memoryDeletionContractSha256(scope)) {
    context.addIssue({
      code: "custom",
      message: "Execution scope digest does not match the canonical scope.",
      path: ["executionScopeSha256"],
    });
  }
  if (receipt.id !== memoryDeletionReceiptId(receipt)) {
    context.addIssue({
      code: "custom",
      message: "Receipt ID does not match its tenant-scoped memory identity.",
      path: ["id"],
    });
  }
  const { receiptSha256, ...receiptBody } = receipt;
  if (receiptSha256 !== memoryDeletionContractSha256(receiptBody)) {
    context.addIssue({
      code: "custom",
      message: "Receipt digest does not match the canonical receipt body.",
      path: ["receiptSha256"],
    });
  }
  const expectedManifest = memoryDeletionManifestSha256(receipt);
  if (receipt.descendantManifestSha256 !== expectedManifest) {
    context.addIssue({
      code: "custom",
      message: "Descendant manifest digest does not match its opaque ID lists.",
      path: ["descendantManifestSha256"],
    });
  }
}

function validateLegacyReceipt(
  receipt: z.infer<typeof memoryDeletionReceiptBaseSchema>,
  context: z.RefinementCtx,
) {
  if (
    receipt.initiatingActorId !== null ||
    receipt.executingPrincipalType !== null ||
    receipt.executingPrincipalId !== null ||
    receipt.correlationId !== null ||
    receipt.causationId !== null ||
    receipt.purpose !== null ||
    receipt.executionScope !== null ||
    receipt.executionScopeSha256 !== null ||
    receipt.receiptSha256 !== null ||
    receipt.descendantManifestSha256 !== null ||
    receipt.deleteReason !== "legacy_unattributed"
  ) {
    context.addIssue({
      code: "custom",
      message: "A legacy receipt cannot claim scoped attribution or manifest guarantees.",
    });
  }
}

export function canonicalizeMemoryDeletionIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => manifestIdSchema.parse(id)))]
    .sort(comparePostgresCText);
}

function canonicalizeOpaqueIds(ids: readonly string[]) {
  return canonicalizeMemoryDeletionIds(ids);
}

function comparePostgresCText(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical receipt JSON requires finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Memory deletion receipts require JSON-compatible values.");
}
