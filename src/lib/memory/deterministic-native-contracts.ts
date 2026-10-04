import { z } from "zod";
import { memoryLifecyclePolicyV1 } from "@/lib/memory/lifecycle";
import { privateActionAcceptanceId, privateActionKeySha256, privateActionScopeSchema, privateActionShaSchema as sha, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeMemoryDeterministicKindSchema = z.enum(["maintenance", "graph"]);
export type NativeMemoryDeterministicKind = z.infer<typeof nativeMemoryDeterministicKindSchema>;
export const NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256 = canonicalJsonSha256({ version: 1, policy: memoryLifecyclePolicyV1, maximumEligibleMemories: 500, purposesUnchanged: true });
export const NATIVE_MEMORY_GRAPH_POLICY_SHA256 = canonicalJsonSha256({ version: 1, algorithm: "existing-private-cohort-graph:1", maximumMemories: 2000,
  maximumTraces: 1000, maximumNodes: 10000, maximumEdges: 20000, sources: "active-unarchived-current-private-memory-and-traces-wholly-within-it" });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const maintenancePin = z.object({ policyVersion: z.literal(1), eligibleMemoryCount: count.max(500), inventorySha256: sha,
  planSha256: sha, policySha256: z.literal(NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256) }).strict();
const graphPin = z.object({ memoryCount: count.max(2000), traceCount: count.max(1000), sourceManifestSha256: sha,
  graphPolicySha256: z.literal(NATIVE_MEMORY_GRAPH_POLICY_SHA256) }).strict();
function digest(value: { reviewSha256: string }, context: z.RefinementCtx) {
  const { reviewSha256, ...body } = value;
  if (reviewSha256 !== canonicalJsonSha256(body)) context.addIssue({ code: "custom", message: "Private Memory review digest differs." });
}
export const nativeMemoryMaintenancePinSchema = maintenancePin.extend({ reviewSha256: sha }).strict().superRefine(digest);
export const nativeMemoryGraphRebuildPinSchema = graphPin.extend({ reviewSha256: sha }).strict().superRefine(digest);
const reason = z.enum(["scope_too_large", "write_permission_required"]);
export const nativeMemoryMaintenanceReviewSchema = z.object({ eligible: z.boolean(), reason: reason.nullable(),
  excludedMemoryCount: count, pin: nativeMemoryMaintenancePinSchema.nullable() }).strict()
  .refine((v) => v.eligible === (v.reason === null && v.pin !== null), "Maintenance requires a complete supported inventory.");
export const nativeMemoryGraphRebuildReviewSchema = z.object({ eligible: z.boolean(), reason: reason.nullable(),
  pin: nativeMemoryGraphRebuildPinSchema.nullable() }).strict()
  .refine((v) => v.eligible === (v.reason === null && v.pin !== null), "Graph rebuild requires a complete supported inventory.");
export const nativeMemoryMaintenanceRequestSchema = z.object({ contract: z.literal("asael-memory-maintenance-run:1"), review: nativeMemoryMaintenancePinSchema }).strict();
export const nativeMemoryGraphRebuildRequestSchema = z.object({ contract: z.literal("asael-memory-graph-rebuild:1"), review: nativeMemoryGraphRebuildPinSchema }).strict();
export const nativeMemoryDeterministicRequestSchema = z.union([nativeMemoryMaintenanceRequestSchema, nativeMemoryGraphRebuildRequestSchema]);
export type NativeMemoryDeterministicRequest = z.infer<typeof nativeMemoryDeterministicRequestSchema>;
export const nativeMemoryDeterministicOperation = (kind: NativeMemoryDeterministicKind) => kind === "maintenance" ? "memory.maintenance.run" as const : "memory.graph.rebuild" as const;
export function nativeMemoryDeterministicResourceId(scope: PrivateActionScope, kind: NativeMemoryDeterministicKind) {
  return `private-memory-action:${canonicalJsonSha256({ scope, operation: nativeMemoryDeterministicOperation(kind) })}`;
}
const intentBase = { contract: z.literal("asael-private-memory-action-intent:1"), scope: privateActionScopeSchema,
  resourceId: z.string().regex(/^private-memory-action:[a-f0-9]{64}$/), keySha256: sha };
export const nativeMemoryDeterministicIntentSchema = z.discriminatedUnion("operation", [
  z.object({ ...intentBase, operation: z.literal("memory.maintenance.run"), request: nativeMemoryMaintenanceRequestSchema }).strict(),
  z.object({ ...intentBase, operation: z.literal("memory.graph.rebuild"), request: nativeMemoryGraphRebuildRequestSchema }).strict(),
]).superRefine((v, c) => {
  if (v.resourceId !== nativeMemoryDeterministicResourceId(v.scope, v.operation === "memory.maintenance.run" ? "maintenance" : "graph")) c.addIssue({ code: "custom", message: "Private Memory intent resource differs." });
});
const maintenanceResult = z.object({ policyVersion: z.literal(1), scanned: count.max(500), eligible: count.max(500), exactDuplicateGroups: count.max(250),
  autoArchivedDuplicates: count.max(500), pinnedDuplicateConflicts: count.max(500), promotionReviewsCreated: count.max(250), expiredArchived: count.max(500),
  duplicateRateBefore: z.number().min(0).max(1), duplicateRateAfter: z.number().min(0).max(1), duplicateRateTarget: z.literal(0.01) }).strict();
const graphResult = z.object({ memoryCount: count.max(2000), traceCount: count.max(1000), nodeCount: count.max(10000), edgeCount: count.max(20000) }).strict();
const acceptanceBase = { id: z.string().regex(/^private-action-acceptance:[a-f0-9]{64}$/), scope: privateActionScopeSchema,
  resourceId: intentBase.resourceId, keySha256: sha, requestSha256: sha, reviewSha256: sha, acceptedAt: z.string().datetime(), acceptanceSha256: sha };
function acceptedDigest(v: { acceptanceSha256: string; id: string; scope: PrivateActionScope; keySha256: string; resourceId: string; operation: string }, c: z.RefinementCtx) {
  const { acceptanceSha256, ...body } = v;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== privateActionAcceptanceId(v.scope, v.keySha256) ||
    v.resourceId !== nativeMemoryDeterministicResourceId(v.scope, v.operation === "memory.maintenance.run" ? "maintenance" : "graph")) {
    c.addIssue({ code: "custom", message: "Private Memory acceptance identity or digest differs." });
  }
}
export const nativeMemoryMaintenanceAcceptanceSchema = z.object({ ...acceptanceBase, contract: z.literal("asael-memory-maintenance-acceptance:1"),
  operation: z.literal("memory.maintenance.run"), result: maintenanceResult }).strict().superRefine(acceptedDigest);
export const nativeMemoryGraphRebuildAcceptanceSchema = z.object({ ...acceptanceBase, contract: z.literal("asael-memory-graph-rebuild-acceptance:1"),
  operation: z.literal("memory.graph.rebuild"), result: graphResult }).strict().superRefine(acceptedDigest);
export const nativeMemoryDeterministicAcceptanceSchema = z.union([nativeMemoryMaintenanceAcceptanceSchema, nativeMemoryGraphRebuildAcceptanceSchema]);
export type NativeMemoryDeterministicAcceptance = z.infer<typeof nativeMemoryDeterministicAcceptanceSchema>;
export function buildNativeMemoryDeterministicIntent(input: { scope: PrivateActionScope; kind: NativeMemoryDeterministicKind; request: NativeMemoryDeterministicRequest; idempotencyKey: string }) {
  return nativeMemoryDeterministicIntentSchema.parse({ contract: "asael-private-memory-action-intent:1", operation: nativeMemoryDeterministicOperation(input.kind),
    scope: input.scope, resourceId: nativeMemoryDeterministicResourceId(input.scope, input.kind), keySha256: privateActionKeySha256(input.scope, input.idempotencyKey), request: input.request });
}
export function sealNativeMemoryMaintenancePin(input: z.input<typeof maintenancePin>) {
  const body = maintenancePin.parse(input); return nativeMemoryMaintenancePinSchema.parse({ ...body, reviewSha256: canonicalJsonSha256(body) });
}
export function sealNativeMemoryGraphRebuildPin(input: z.input<typeof graphPin>) {
  const body = graphPin.parse(input); return nativeMemoryGraphRebuildPinSchema.parse({ ...body, reviewSha256: canonicalJsonSha256(body) });
}
