import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import { memoryLifecycleActionSchema } from "@/lib/memory/lifecycle";

export const MEMORY_LIFECYCLE_MUTATION_CONTRACT = "asael-memory-lifecycle-mutation:1" as const;
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const memoryLifecycleTargetIdSchema = id;
const tenant = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.string().datetime({ offset: true });

export const memoryLifecycleTargetIdentitySchema = z.object({
  tenantId: tenant,
  ownerActorId: actor,
  memoryId: id,
  visibility: z.literal("user_private"),
  claimStatus: z.enum(["active", "candidate", "superseded", "contradicted"]),
  targetRevision: revision.min(1),
  lifecycleRevision: revision,
}).strict();

export const memoryLifecycleMutationRequestSchema = z.object({
  contract: z.literal(MEMORY_LIFECYCLE_MUTATION_CONTRACT),
  action: memoryLifecycleActionSchema,
  expectedTargetToken: digest,
}).strict();

export const memoryLifecycleSnapshotSchema = z.object({
  policyVersion: z.literal(1),
  pinnedAt: timestamp.nullable(),
  archivedAt: timestamp.nullable(),
  archiveReason: z.enum(["manual", "exact_duplicate", "retention_expired"]).nullable(),
  duplicateOfMemoryId: id.nullable(),
  updatedAt: timestamp.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.pinnedAt && value.archivedAt) ||
    ((value.archivedAt === null) !== (value.archiveReason === null)) ||
    ((value.archiveReason === "exact_duplicate") !== (value.duplicateOfMemoryId !== null))) {
    context.addIssue({ code: "custom", message: "Lifecycle state is inconsistent." });
  }
});

export const memoryLifecycleReadSchema = z.object({
  contract: z.literal("asael-memory-lifecycle-read:1"),
  target: memoryLifecycleTargetIdentitySchema.extend({ token: digest }),
  lifecycle: memoryLifecycleSnapshotSchema,
}).strict();

export const memoryLifecycleAcceptanceSchema = z.object({
  contract: z.literal("asael-memory-lifecycle-acceptance:1"),
  id: z.string().regex(/^memory-lifecycle-acceptance:[a-f0-9]{64}$/),
  tenantId: tenant,
  ownerActorId: actor,
  memoryId: id,
  action: memoryLifecycleActionSchema,
  idempotencyKeySha256: digest,
  requestSha256: digest,
  expectedTargetToken: digest,
  acceptedAt: timestamp,
  targetRevision: revision.min(1),
  beforeLifecycleRevision: revision,
  afterLifecycleRevision: revision.min(1),
  lifecycle: memoryLifecycleSnapshotSchema,
  historicalTruthChanged: z.literal(false),
  permanentDeletion: z.literal(false),
}).strict().refine((value) => value.afterLifecycleRevision === value.beforeLifecycleRevision + 1, {
  message: "Acceptance must bind one lifecycle transition.",
}).refine((value) => {
  if (value.action === "pin") return value.lifecycle.pinnedAt !== null && value.lifecycle.archivedAt === null;
  if (value.action === "archive") return value.lifecycle.archivedAt !== null && value.lifecycle.archiveReason === "manual" && value.lifecycle.pinnedAt === null;
  return value.lifecycle.pinnedAt === null && value.lifecycle.archivedAt === null;
}, {
  message: "Accepted lifecycle state must match the exact action.",
});

export type MemoryLifecycleMutationRequest = z.infer<typeof memoryLifecycleMutationRequestSchema>;
export type MemoryLifecycleTargetIdentity = z.infer<typeof memoryLifecycleTargetIdentitySchema>;
export type MemoryLifecycleAcceptance = z.infer<typeof memoryLifecycleAcceptanceSchema>;
export type MemoryLifecycleRead = z.infer<typeof memoryLifecycleReadSchema>;

export class MemoryLifecycleMutationError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "MemoryLifecycleMutationError";
  }
}

/** This token attests lifecycle/semantic counters, never content or a usage score. */
export function memoryLifecycleTargetToken(input: MemoryLifecycleTargetIdentity) {
  const value = memoryLifecycleTargetIdentitySchema.parse(input);
  return memoryContentDigest(value.tenantId, JSON.stringify(["memory-lifecycle-target:1", value]));
}

export function lifecycleTokensEqual(left: string, right: string) {
  if (!digest.safeParse(left).success || !digest.safeParse(right).success) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function memoryLifecycleIntent(input: {
  tenantId: string; ownerActorId: string; memoryId: string;
  idempotencyKey: string; request: MemoryLifecycleMutationRequest;
}) {
  tenant.parse(input.tenantId); actor.parse(input.ownerActorId); id.parse(input.memoryId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) {
    throw new MemoryLifecycleMutationError("memory_lifecycle_key_invalid", 400, "A valid Idempotency-Key is required.");
  }
  const request = memoryLifecycleMutationRequestSchema.parse(input.request);
  const keySha256 = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const requestSha256 = memoryContentDigest(input.tenantId, JSON.stringify([
    MEMORY_LIFECYCLE_MUTATION_CONTRACT, input.ownerActorId, input.memoryId, request.action, request.expectedTargetToken,
  ]));
  const acceptanceId = `memory-lifecycle-acceptance:${createHash("sha256").update(JSON.stringify([
    "memory-lifecycle-acceptance:1", input.tenantId, input.ownerActorId, keySha256,
  ])).digest("hex")}`;
  return { request, keySha256, requestSha256, acceptanceId };
}
