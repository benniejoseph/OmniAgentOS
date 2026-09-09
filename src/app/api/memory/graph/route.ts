import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { retrieveGraphRelationshipPaths } from "@/lib/entities/graph-retrieval";
import { getGraphStorageDecisionReport } from "@/lib/entities/graph-query-telemetry";
import {
  entityRelationTypeIdSchema,
} from "@/lib/entities/ontology";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { queryTemporalRelationClaims } from "@/lib/entities/temporal-claim-store";
import { relationEpistemicKindSchema } from "@/lib/entities/temporal-claims";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  getMemoryGraphStats,
  getMemoryGraphNode,
  listMemoryGraphEdges,
  listMemoryGraphNodes,
  rebuildMemoryGraph,
  searchMemoryGraph,
} from "@/lib/memory/graph";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const rebuildSchema = z.object({
  source: z.string().min(1).max(80).optional(),
  memoryLimit: z.number().int().min(1).max(2000).optional(),
  traceLimit: z.number().int().min(1).max(1000).optional(),
}).strict();

const temporalRelationQuerySchema = z.object({
  entityId: z.string().trim().min(1).max(240).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  ).optional(),
  relationTypeId: entityRelationTypeIdSchema.optional(),
  epistemicKinds: z.array(relationEpistemicKindSchema).max(4),
  validAt: z.string().datetime({ offset: true }).optional(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  history: z.boolean(),
  limit: z.number().int().min(1).max(200),
}).strict();

const relationshipPathQuerySchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  maxHops: z.number().int().min(1).max(3),
  limit: z.number().int().min(1).max(24),
}).strict();

const graphScaleQuerySchema = z.object({
  windowHours: z.number().int().min(1).max(720),
  sampleLimit: z.number().int().min(1).max(5_000),
}).strict();

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view")?.trim();
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: view === "temporal_relations" ? 200 : 100,
  });

  if (view === "temporal_relations") {
    return readTemporalRelations(request, url, limit);
  }
  if (view === "relationship_paths") {
    return readRelationshipPaths(request, query, url, Math.min(limit, 24));
  }
  if (view === "scale_metrics") {
    return readGraphScaleMetrics(request, url);
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: query ? { queryLength: query.length, limit } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: query
      ? MEMORY_PURPOSE_IDS.retrieve
      : MEMORY_PURPOSE_IDS.read,
    auditPurpose: query
      ? "api.memory.graph.search"
      : view === "universe_node"
        ? "api.memory.graph.universe.node"
        : view === "universe"
          ? "api.memory.graph.universe"
          : "api.memory.graph.read",
    correlationId: `memory_graph_read_${randomUUID()}`,
  });

  if (view === "universe_node") {
    const nodeId = url.searchParams.get("id")?.trim() || "";
    try {
      const node = await getMemoryGraphNode(nodeId, {
        tenantId: context.tenantId,
        accessScope: requestAccess?.databaseAccessScope,
      });
      return Response.json({
        version: "memory-universe-node:1",
        node: node ? publicUniverseNodeDetail(node) : null,
      }, {
        status: node ? 200 : 404,
        headers: privateNoStoreHeaders,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error
          ? error.message
          : "Memory graph node could not be loaded.",
      }, { status: 400, headers: privateNoStoreHeaders });
    }
  }

  if (view === "universe") {
    const nodes = await listMemoryGraphNodes(10_000, {
      tenantId: context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    });
    const edges = await listMemoryGraphEdges(20_000, {
      tenantId: context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    });
    const kinds = countValues(nodes.map((node) => node.kind));
    const relations = countValues(edges.map((edge) => edge.relation));
    return Response.json({
      version: "memory-universe:1",
      generatedAt: new Date().toISOString(),
      nodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        weight: node.weight,
        sourceCount: node.sourceCount,
        updatedAt: node.updatedAt,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        relation: edge.relation,
        weight: edge.weight,
        evidenceCount: edge.evidenceCount,
      })),
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        kinds,
        relations,
        latestUpdatedAt: nodes.reduce<string | null>(
          (latest, node) => !latest || node.updatedAt > latest
            ? node.updatedAt
            : latest,
          null,
        ),
      },
      disclosure: {
        labels: "explicit_node_selection",
        summaries: "explicit_node_selection",
      },
    }, { headers: privateNoStoreHeaders });
  }

  if (query) {
    return Response.json({
      results: await searchMemoryGraph(query, {
        tenantId: context.tenantId,
        limit: Math.min(limit, 24),
        accessScope: requestAccess?.databaseAccessScope,
      }),
      stats: await getMemoryGraphStats({
        tenantId: context.tenantId,
        accessScope: requestAccess?.databaseAccessScope,
      }),
    }, { headers: privateNoStoreHeaders });
  }

  const [nodes, edges, stats] = await Promise.all([
    listMemoryGraphNodes(limit, {
      tenantId: context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    }),
    listMemoryGraphEdges(limit * 2, {
      tenantId: context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    }),
    getMemoryGraphStats({
      tenantId: context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    }),
  ]);

  return Response.json({ nodes, edges, stats }, {
    headers: privateNoStoreHeaders,
  });
}

function publicUniverseNodeDetail(
  node: Awaited<ReturnType<typeof getMemoryGraphNode>> & {},
) {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    summary: node.summary,
    tags: node.tags.slice(0, 20),
    weight: node.weight,
    sourceCount: node.sourceCount,
    updatedAt: node.updatedAt,
  };
}

function countValues(values: readonly string[]) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

async function readGraphScaleMetrics(request: Request, url: URL) {
  const parsed = graphScaleQuerySchema.safeParse({
    windowHours: Number(url.searchParams.get("windowHours") || 168),
    sampleLimit: Number(url.searchParams.get("sampleLimit") || 2_000),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid graph scale query", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: {
        view: "scale_metrics",
        windowHours: parsed.data.windowHours,
        sampleLimit: parsed.data.sampleLimit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const entityAccess = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.read.v1",
    correlationId: `entity_graph_scale_${randomUUID()}`,
  });
  if (!entityAccess) {
    return Response.json(
      { error: "Private graph scale metrics are unavailable for this identity." },
      { status: 403, headers: privateNoStoreHeaders },
    );
  }

  try {
    const report = await getGraphStorageDecisionReport({
      accessBinding: entityAccess.accessBinding,
      executionScope: entityAccess.executionScope,
      windowHours: parsed.data.windowHours,
      sampleLimit: parsed.data.sampleLimit,
    });
    return Response.json({
      schemaVersion: 1,
      view: "scale_metrics",
      report,
    }, { headers: privateNoStoreHeaders });
  } catch {
    return Response.json(
      { error: "Graph scale metrics could not be loaded." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}

async function readRelationshipPaths(
  request: Request,
  query: string | undefined,
  url: URL,
  limit: number,
) {
  const parsed = relationshipPathQuerySchema.safeParse({
    query,
    maxHops: Number(url.searchParams.get("maxHops") || 2),
    limit,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid relationship path query", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: {
        view: "relationship_paths",
        queryLength: parsed.data.query.length,
        maxHops: parsed.data.maxHops,
        limit: parsed.data.limit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = `entity_graph_path_${randomUUID()}`;
  const entityAccess = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.read.v1",
    correlationId,
  });
  const memoryAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.retrieve,
    auditPurpose: "api.memory.graph.relationship_paths",
    correlationId,
  });
  if (!entityAccess || !memoryAccess) {
    return Response.json(
      { error: "Private relationship paths are unavailable for this identity." },
      { status: 403, headers: privateNoStoreHeaders },
    );
  }

  try {
    const result = await retrieveGraphRelationshipPaths(parsed.data.query, {
      entityAccess,
      memoryAccessScope: memoryAccess.databaseAccessScope,
      contextExecutionScope: memoryAccess.executionScope,
      maxHops: parsed.data.maxHops,
      limit: parsed.data.limit,
    });
    return Response.json({
      schemaVersion: 1,
      view: "relationship_paths",
      query: parsed.data.query,
      ...result,
    }, { headers: privateNoStoreHeaders });
  } catch {
    return Response.json(
      { error: "Relationship paths could not be loaded." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}

async function readTemporalRelations(
  request: Request,
  url: URL,
  limit: number,
) {
  const epistemicKinds = url.searchParams.getAll("epistemicKind")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = temporalRelationQuerySchema.safeParse({
    entityId: url.searchParams.get("entityId") || undefined,
    relationTypeId: url.searchParams.get("relationTypeId") || undefined,
    epistemicKinds,
    validAt: url.searchParams.get("validAt") || undefined,
    recordedAt: url.searchParams.get("recordedAt") || undefined,
    history: url.searchParams.get("history") === "true",
    limit,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid temporal relation query", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: {
        view: "temporal_relations",
        entityId: parsed.data.entityId,
        relationTypeId: parsed.data.relationTypeId,
        epistemicKinds: parsed.data.epistemicKinds,
        history: parsed.data.history,
        limit: parsed.data.limit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const access = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.read.v1",
    correlationId: `entity_relation_read_${randomUUID()}`,
  });
  if (!access) {
    return Response.json(
      { error: "The private temporal relation graph is unavailable for this identity." },
      { status: 403, headers: privateNoStoreHeaders },
    );
  }

  try {
    const records = await queryTemporalRelationClaims({
      ...access,
      entityId: parsed.data.entityId,
      relationTypeId: parsed.data.relationTypeId,
      epistemicKinds: parsed.data.epistemicKinds,
      validAt: parsed.data.validAt,
      recordedAt: parsed.data.recordedAt,
      history: parsed.data.history,
      limit: parsed.data.limit,
    });
    return Response.json({
      schemaVersion: 1,
      view: "temporal_relations",
      history: parsed.data.history,
      relations: records.map(publicTemporalRelation),
    }, { headers: privateNoStoreHeaders });
  } catch {
    return Response.json(
      { error: "Temporal relation graph could not be loaded." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}

function publicTemporalRelation(
  record: Awaited<ReturnType<typeof queryTemporalRelationClaims>>[number],
) {
  const claim = record.claim;
  return {
    claimId: claim.claimId,
    revisionId: claim.revisionId,
    previousRevisionId: claim.previousRevisionId,
    relationTypeId: claim.relationTypeId,
    source: {
      entityId: claim.source.entityId,
      entityTypeId: claim.source.entityTypeId,
    },
    target: {
      entityId: claim.target.entityId,
      entityTypeId: claim.target.entityTypeId,
    },
    epistemicKind: claim.epistemicKind,
    claimState: claim.claimState,
    confidenceBasisPoints: claim.confidenceBasisPoints,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    recordedAt: claim.recordedAt,
    supersededAt: record.supersededAt,
    lineageCount: claim.lineage.length,
  };
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = rebuildSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory graph rebuild request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_graph",
      metadata: {
        source: parsed.data.source,
        memoryLimit: parsed.data.memoryLimit,
        traceLimit: parsed.data.traceLimit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await rebuildMemoryGraph({
    tenantId: context.tenantId,
    source: parsed.data.source || "api",
    memoryLimit: parsed.data.memoryLimit,
    traceLimit: parsed.data.traceLimit,
  });

  return Response.json(result, { status: 201 });
}
