import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
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
      : "api.memory.graph.read",
    correlationId: `memory_graph_read_${randomUUID()}`,
  });

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
    });
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

  return Response.json({ nodes, edges, stats });
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
