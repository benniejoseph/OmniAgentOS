import { randomUUID } from "node:crypto";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { APP_SERVICE_BOUNDARY_VERSION } from "@/lib/app-services/receipt-contracts";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { readNativeGraphEntities } from "@/lib/entities/graph-native-read-store";
import { retrieveGraphRelationshipPaths } from "@/lib/entities/graph-retrieval";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { queryTemporalRelationClaims } from "@/lib/entities/temporal-claim-store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { getMemoryGraphNode, listMemoryGraphEdges, listMemoryGraphNodes } from "@/lib/memory/graph";
import { NATIVE_MEMORY_GRAPH_READ_CONTRACT, nativeGraphIdSchema, nativeGraphUniverseQuerySchema,
  nativeGraphTemporalQuerySchema, nativeGraphPathsQuerySchema } from "@/lib/memory/graph-native-read-contracts";
import { NativePrivateActionError, privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { nativePrivateActionTransaction } from "@/lib/memory/private-action-store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { nativeMemoryGraphUniverseResponseSchema, nativeMemoryGraphNodeResponseSchema, nativeMemoryGraphEntityResponseSchema,
  nativeMemoryGraphTemporalResponseSchema, nativeMemoryGraphPathsResponseSchema } from "@/lib/mobile/memory-graph-read-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type View = "universe" | "node" | "entity" | "temporal" | "paths";
function begin(caller: AppServiceCaller, view: View) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(`app.memory.graph.native.${view}`));
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context), correlationId = `native_graph_${randomUUID()}`;
  if (!canonical || caller.executionScope || caller.idempotencyKey) throw new NativePrivateActionError("memory_graph_authority", 403, "A current private read-only owner is required.");
  const memory = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId: view === "paths" ? MEMORY_PURPOSE_IDS.retrieve : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `api.memory.graph.native.${view}`, correlationId,
  });
  const entity = requestEntityAccessFromSecurityContext(caller.context, { purposeId: "entity.read.v1", correlationId });
  if (!memory || !entity) throw new NativePrivateActionError("memory_graph_authority", 403, "Private graph scope is unavailable.");
  const scope = privateActionScopeSchema.parse({ tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId });
  return { authorized, memory, entity, scope };
}
type Owner = ReturnType<typeof begin>;
async function observe<T>(owner: Owner, work: () => Promise<T>) {
  return runWithDatabaseActorScope(owner.scope.tenantId, [...new Set([owner.scope.ownerActorId, owner.scope.canonicalActorId])], async () => {
    await nativePrivateActionTransaction(owner, false, async () => undefined);
    const data = await work();
    await nativePrivateActionTransaction(owner, false, async () => undefined);
    return data;
  });
}
function complete<T extends Record<string, unknown>>(caller: AppServiceCaller, owner: Owner, data: T, count: number) {
  const result = completeAppServiceCall(owner.authorized, { contract: NATIVE_MEMORY_GRAPH_READ_CONTRACT,
    scope: owner.scope, generatedAt: new Date().toISOString(), ...data }, { resourceCount: count });
  if (result.receipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: owner.scope.tenantId, actorId: caller.context.actorId, role: caller.context.role, executionScope: null })) {
    throw new Error("Private graph response authority differs.");
  }
  return result;
}
function temporal(record: Awaited<ReturnType<typeof queryTemporalRelationClaims>>[number]) {
  const c = record.claim;
  return { claimId: c.claimId, revisionId: c.revisionId, previousRevisionId: c.previousRevisionId, relationTypeId: c.relationTypeId,
    source: { entityId: c.source.entityId, entityTypeId: c.source.entityTypeId }, target: { entityId: c.target.entityId, entityTypeId: c.target.entityTypeId },
    epistemicKind: c.epistemicKind, claimState: c.claimState, confidenceBasisPoints: c.confidenceBasisPoints,
    validFrom: c.validFrom, validTo: c.validTo, recordedAt: c.recordedAt, supersededAt: record.supersededAt, lineageCount: c.lineage.length };
}
export async function readNativeMemoryGraphUniverse(caller: AppServiceCaller, input: unknown) {
  const query = nativeGraphUniverseQuerySchema.parse(input), owner = begin(caller, "universe");
  const graph = await observe(owner, async () => {
    const options = { tenantId: owner.scope.tenantId, accessScope: owner.memory.databaseAccessScope, privateOnly: true };
    // Sequential reads keep the existing one-connection deployment usable.
    const nodes = await listMemoryGraphNodes(query.limit, options);
    const edges = await listMemoryGraphEdges(query.limit * 2, options);
    const entities = await readNativeGraphEntities(owner.entity, { limit: 201 });
    const relations = await queryTemporalRelationClaims({ ...owner.entity, limit: 200 });
    const selectedEntities = entities.slice(0, 200), nodeIds = new Set(nodes.map((n) => n.id)), entityIds = new Set(selectedEntities.map((e) => e.entityId));
    return {
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, weight: n.weight, sourceCount: n.sourceCount, updatedAt: n.updatedAt })),
      edges: edges.filter((e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId)).map((e) => ({ id: e.id, sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId, relation: e.relation, weight: e.weight, evidenceCount: e.evidenceCount })),
      entities: selectedEntities.map((e) => ({ id: e.entityId, kind: e.entityTypeId, sourceCount: e.lineage.length, updatedAt: e.updatedAt })),
      relations: relations.filter((r) => entityIds.has(r.claim.source.entityId) && entityIds.has(r.claim.target.entityId)).map(temporal),
      coverage: { kind: "bounded_private_sample" as const, nodeLimit: query.limit, edgeLimit: query.limit * 2, entityLimit: 200 as const,
        relationLimit: 200 as const, nodeLimitReached: nodes.length >= query.limit, edgeLimitReached: edges.length >= query.limit * 2,
        entityLimitReached: entities.length > 200, relationLimitReached: relations.length >= 200, total: null },
    };
  });
  const result = complete(caller, owner, { view: "universe" as const, graph }, graph.nodes.length + graph.entities.length);
  nativeMemoryGraphUniverseResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }); return result;
}
export async function readNativeMemoryGraphNode(caller: AppServiceCaller, id: string) {
  nativeGraphIdSchema.parse(id); const owner = begin(caller, "node");
  const node = await observe(owner, () => getMemoryGraphNode(id, { tenantId: owner.scope.tenantId, accessScope: owner.memory.databaseAccessScope, privateOnly: true }));
  if (!node) throw new NativePrivateActionError("memory_graph_node_unavailable", 404, "The selected private graph point is unavailable.");
  const result = complete(caller, owner, { view: "node" as const, node: { id: node.id, kind: node.kind,
    weight: node.weight, sourceCount: node.sourceCount, updatedAt: node.updatedAt, label: node.label.slice(0, 500), summary: node.summary.slice(0, 4000),
    tags: node.tags.slice(0, 20).map((tag) => tag.slice(0, 200)), textTruncated: node.label.length > 500 || node.summary.length > 4000 || node.tags.length > 20 || node.tags.some((tag) => tag.length > 200) } }, 1);
  nativeMemoryGraphNodeResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }); return result;
}
export async function readNativeMemoryGraphEntity(caller: AppServiceCaller, id: string) {
  nativeGraphIdSchema.parse(id); const owner = begin(caller, "entity");
  const [entity] = await observe(owner, () => readNativeGraphEntities(owner.entity, { id, limit: 1 }));
  if (!entity) throw new NativePrivateActionError("memory_graph_entity_unavailable", 404, "The selected private entity is unavailable.");
  const result = complete(caller, owner, { view: "entity" as const, entity: { id: entity.entityId, kind: entity.entityTypeId,
    label: entity.canonicalLabel, state: entity.state, sourceCount: entity.lineage.length, updatedAt: entity.updatedAt } }, 1);
  nativeMemoryGraphEntityResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }); return result;
}
export async function readNativeMemoryGraphTemporal(caller: AppServiceCaller, input: unknown) {
  const query = nativeGraphTemporalQuerySchema.parse(input), owner = begin(caller, "temporal");
  const relations = (await observe(owner, () => queryTemporalRelationClaims({ ...owner.entity, entityId: query.entityId,
    relationTypeId: query.relationTypeId, epistemicKinds: query.epistemicKind ? [query.epistemicKind] : [], validAt: query.validAt,
    recordedAt: query.recordedAt, history: query.history, limit: query.limit }))).map(temporal);
  const result = complete(caller, owner, { view: "temporal" as const, query, relations, limitReached: relations.length >= query.limit, total: null }, relations.length);
  nativeMemoryGraphTemporalResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }); return result;
}
export async function readNativeMemoryGraphPaths(caller: AppServiceCaller, input: unknown) {
  const query = nativeGraphPathsQuerySchema.parse(input), owner = begin(caller, "paths");
  const paths = await observe(owner, () => retrieveGraphRelationshipPaths(query.q, { entityAccess: owner.entity,
    memoryAccessScope: owner.memory.databaseAccessScope, contextExecutionScope: owner.memory.executionScope, maxHops: query.maxHops, limit: query.limit }));
  const result = complete(caller, owner, { view: "paths" as const, query, result: paths, coverage: "bounded_authorized_paths" as const }, paths.paths.length);
  nativeMemoryGraphPathsResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }); return result;
}
