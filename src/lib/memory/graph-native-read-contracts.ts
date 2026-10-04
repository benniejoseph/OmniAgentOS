import { z } from "zod";
import { entityRelationTypeIdSchema, entityTypeIdSchema } from "@/lib/entities/ontology";
import { relationEpistemicKindSchema } from "@/lib/entities/temporal-claims";

export const NATIVE_MEMORY_GRAPH_READ_CONTRACT = "asael-private-memory-graph-read:1" as const;
export const nativeGraphIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const at = z.string().min(20).max(100).datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const weight = z.number().finite().min(0);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeGraphUniverseQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict();
export const nativeGraphTemporalQuerySchema = z.object({
  entityId: nativeGraphIdSchema.optional(), relationTypeId: entityRelationTypeIdSchema.optional(),
  epistemicKind: relationEpistemicKindSchema.optional(), validAt: at.optional(), recordedAt: at.optional(),
  history: z.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export const nativeGraphPathsQuerySchema = z.object({ q: z.string().trim().min(1).max(4000),
  maxHops: z.coerce.number().int().min(1).max(3).default(2), limit: z.coerce.number().int().min(1).max(24).default(12),
}).strict();
const node = z.object({ id: nativeGraphIdSchema, kind: z.enum(["concept", "tag", "system", "workflow", "tool", "memory", "trace"]),
  weight, sourceCount: count, updatedAt: at }).strict();
export const nativeGraphNodeDetailSchema = node.extend({ label: z.string().max(500), summary: z.string().max(4000),
  tags: z.array(z.string().max(200)).max(20), textTruncated: z.boolean() }).strict();
const edge = z.object({ id: nativeGraphIdSchema, sourceNodeId: nativeGraphIdSchema, targetNodeId: nativeGraphIdSchema,
  relation: z.enum(["co_occurs", "tagged_with", "mentions", "retrieved_with", "query_about", "supports"]), weight, evidenceCount: count }).strict();
const entity = z.object({ id: nativeGraphIdSchema, kind: entityTypeIdSchema, sourceCount: count, updatedAt: at }).strict();
export const nativeGraphEntityDetailSchema = entity.extend({ label: z.string().min(1).max(320), state: z.literal("active") }).strict();
const endpoint = z.object({ entityId: nativeGraphIdSchema, entityTypeId: entityTypeIdSchema }).strict();
export const nativeGraphTemporalRelationSchema = z.object({ claimId: nativeGraphIdSchema, revisionId: nativeGraphIdSchema,
  previousRevisionId: nativeGraphIdSchema.nullable(), relationTypeId: entityRelationTypeIdSchema, source: endpoint, target: endpoint,
  epistemicKind: relationEpistemicKindSchema, claimState: z.enum(["active", "retracted"]), confidenceBasisPoints: z.number().int().min(0).max(10000),
  validFrom: at, validTo: at.nullable(), recordedAt: at, supersededAt: at.nullable(), lineageCount: count }).strict();
const pathEntity = endpoint.extend({ label: z.string().min(1).max(320) }).strict();
const pathEvidence = z.object({ evidenceId: nativeGraphIdSchema, kind: z.enum(["memory", "canonical_evidence"]),
  title: z.string().max(4000), excerpt: z.string().max(16000), source: z.string().max(4000), observedAt: at }).strict();
const hop = z.object({ claimId: nativeGraphIdSchema, revisionId: nativeGraphIdSchema, relationTypeId: entityRelationTypeIdSchema,
  relationLabel: z.string().max(320), direction: z.enum(["forward", "reverse", "symmetric"]), source: pathEntity, target: pathEntity,
  epistemicKind: relationEpistemicKindSchema, confidenceBasisPoints: z.number().int().min(0).max(10000), validFrom: at,
  validTo: at.nullable(), evidence: z.array(pathEvidence).min(1).max(4) }).strict();
const path = z.object({ pathId: nativeGraphIdSchema, anchor: pathEntity, terminal: pathEntity, hopCount: z.number().int().min(1).max(3),
  score: z.number().finite(), explanation: z.string().max(16000), hops: z.array(hop).min(1).max(3), pathSha256: sha }).strict()
  .refine((v) => v.hopCount === v.hops.length, "Path length must bind its exact hops.");
export const nativeGraphPathResultSchema = z.object({ paths: z.array(path).max(24), receipt: z.object({
  version: z.literal("p5.5-graph-retrieval:1"), querySha256: sha, asOfTime: at, maxHops: z.number().int().min(1).max(3),
  anchorCount: count, authorizedRelationCount: count, rejectedRelationCount: count, pathCount: count, receiptSha256: sha,
}).strict() }).strict().refine((v) => v.receipt.pathCount === v.paths.length, "Path receipt count differs.");
export const nativeGraphUniverseSchema = z.object({
  nodes: z.array(node).max(500), edges: z.array(edge).max(1000), entities: z.array(entity).max(200),
  relations: z.array(nativeGraphTemporalRelationSchema).max(200),
  coverage: z.object({ kind: z.literal("bounded_private_sample"), nodeLimit: z.number().int().min(1).max(500),
    edgeLimit: z.number().int().min(2).max(1000), entityLimit: z.literal(200), relationLimit: z.literal(200),
    nodeLimitReached: z.boolean(), edgeLimitReached: z.boolean(), entityLimitReached: z.boolean(), relationLimitReached: z.boolean(),
    total: z.null() }).strict(),
}).strict().superRefine((v, context) => {
  const ids = new Set(v.nodes.map((n) => n.id)), entities = new Set(v.entities.map((n) => n.id));
  if (ids.size !== v.nodes.length || entities.size !== v.entities.length || new Set(v.edges.map((e) => e.id)).size !== v.edges.length ||
    new Set(v.relations.map((r) => r.revisionId)).size !== v.relations.length || v.nodes.length > v.coverage.nodeLimit ||
    v.edges.length > v.coverage.edgeLimit || v.edges.some((e) => !ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) ||
    v.relations.some((r) => !entities.has(r.source.entityId) || !entities.has(r.target.entityId))) {
    context.addIssue({ code: "custom", message: "Graph sample has duplicate, out-of-window or disconnected identities." });
  }
});
