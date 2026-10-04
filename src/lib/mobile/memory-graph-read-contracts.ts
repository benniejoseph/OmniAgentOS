import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { NATIVE_MEMORY_GRAPH_READ_CONTRACT, nativeGraphUniverseQuerySchema, nativeGraphTemporalQuerySchema, nativeGraphPathsQuerySchema,
  nativeGraphNodeDetailSchema, nativeGraphEntityDetailSchema, nativeGraphTemporalRelationSchema, nativeGraphPathResultSchema,
  nativeGraphUniverseSchema } from "@/lib/memory/graph-native-read-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const base = { contract: z.literal(NATIVE_MEMORY_GRAPH_READ_CONTRACT), scope: privateActionScopeSchema,
  generatedAt: z.string().datetime({ offset: true }), serviceReceipt: appServiceReceiptSchema };
function receipt(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, view: string, count: number) {
  const { serviceReceipt: r, ...body } = value;
  if (r.operation !== `app.memory.graph.native.${view}` || r.action !== "read" || r.resourceType !== "memory_graph" ||
    r.accessMode !== "read" || r.eventContract !== "read_only:no_domain_mutation" || r.idempotencyKeySha256 !== null ||
    r.resourceCount !== count || r.outcomeSha256 !== canonicalJsonSha256(body)) context.addIssue({ code: "custom", message: "Graph receipt differs from this exact read." });
}
export const nativeMemoryGraphUniverseResponseSchema = z.object({ ...base, view: z.literal("universe"), graph: nativeGraphUniverseSchema }).strict()
  .superRefine((v, c) => receipt(v, c, "universe", v.graph.nodes.length + v.graph.entities.length));
export const nativeMemoryGraphNodeResponseSchema = z.object({ ...base, view: z.literal("node"), node: nativeGraphNodeDetailSchema }).strict()
  .superRefine((v, c) => receipt(v, c, "node", 1));
export const nativeMemoryGraphEntityResponseSchema = z.object({ ...base, view: z.literal("entity"), entity: nativeGraphEntityDetailSchema }).strict()
  .superRefine((v, c) => receipt(v, c, "entity", 1));
export const nativeMemoryGraphTemporalResponseSchema = z.object({ ...base, view: z.literal("temporal"), query: nativeGraphTemporalQuerySchema,
  relations: z.array(nativeGraphTemporalRelationSchema).max(200), limitReached: z.boolean(), total: z.null() }).strict()
  .superRefine((v, c) => { receipt(v, c, "temporal", v.relations.length); if (v.relations.length > v.query.limit) c.addIssue({ code: "custom", message: "Relation read exceeds its bound." }); });
export const nativeMemoryGraphPathsResponseSchema = z.object({ ...base, view: z.literal("paths"), query: nativeGraphPathsQuerySchema,
  result: nativeGraphPathResultSchema, coverage: z.literal("bounded_authorized_paths") }).strict()
  .superRefine((v, c) => { receipt(v, c, "paths", v.result.paths.length); if (v.result.paths.length > v.query.limit || v.result.receipt.maxHops !== v.query.maxHops) c.addIssue({ code: "custom", message: "Path read exceeds its reviewed query." }); });
export const nativeMemoryGraphReadSchemas = Object.freeze({
  NativeMemoryGraphUniverseQuery: nativeGraphUniverseQuerySchema, NativeMemoryGraphTemporalQuery: nativeGraphTemporalQuerySchema,
  NativeMemoryGraphPathsQuery: nativeGraphPathsQuerySchema, NativeMemoryGraphUniverseResponse: nativeMemoryGraphUniverseResponseSchema,
  NativeMemoryGraphNodeResponse: nativeMemoryGraphNodeResponseSchema, NativeMemoryGraphEntityResponse: nativeMemoryGraphEntityResponseSchema,
  NativeMemoryGraphTemporalResponse: nativeMemoryGraphTemporalResponseSchema, NativeMemoryGraphPathsResponse: nativeMemoryGraphPathsResponseSchema,
  NativeMemoryGraphReadError: z.object({ error: z.string().min(1).max(4000), message: z.string().max(4000).optional(), code: z.string().max(200).optional() }).strict(),
});
