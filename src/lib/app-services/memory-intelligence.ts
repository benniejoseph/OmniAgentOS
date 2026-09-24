import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  getLatestMemoryGraphBuild,
  getMemoryGraphCounts,
  listMemoryGraphEdges,
  listMemoryGraphNodes,
} from "@/lib/memory/graph";
import {
  buildMemoryIntelligenceOverview,
  filterKnowledgeIndex,
  filterMemoryIndex,
  isSourceKnowledgeMemory,
  knowledgeIndexItem,
  KNOWLEDGE_CATEGORY_IDS,
  memoryIndexItem,
  MEMORY_CATEGORY_IDS,
  sliceIntelligencePage,
} from "@/lib/memory/intelligence";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  countAttributedMemoryDeletionReceipts,
  getMemoryReconciliationStats,
  listMemoryCatalog,
  type MemoryCatalogClass,
} from "@/lib/memory/store";
import {
  buildMemoryCognitionQualityMetrics,
  publicMemoryCognitionQualityMetrics,
} from "@/lib/memory/quality-metrics";
import { listKnowledgeCognitions } from "@/lib/knowledge/cognification-store";
import { getKnowledgeStats, listKnowledgeDocuments } from "@/lib/rag/store";
import { projectPublicRetrievalOutcomeAggregateV1 } from "@/lib/rag/retrieval-outcome";
import { listActorRetrievalOutcomeObservations } from "@/lib/runs/retrieval-outcomes";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { memoryTierSchema } from "@/lib/memory/tier-policy";
import { getLatestScopedStreamEventAt } from "@/lib/events/store";
import { getSemanticSummaryShadowStats } from "@/lib/threads/semantic-summary-store";
import { getDatabasePoolMax } from "@/lib/db/client";

const indexStateSchema = z.enum([
  "active",
  "candidate",
  "superseded",
  "contradicted",
  "archived",
]);

// The memory workspace is a catalogue, not an export. Keep its observation
// window bounded and leave exact record bodies behind the explicit inspect
// route. These limits are deliberately wider than the largest UI page so
// search and category filters still have useful headroom without transferring
// every tenant record on each refresh.
const MEMORY_CATALOG_SCAN_LIMIT = 1_000;
const KNOWLEDGE_CATALOG_SCAN_LIMIT = 500;
const EXISTING_MEMORY_CATALOG_SCAN_LIMIT = 10_000;
const EXISTING_KNOWLEDGE_CATALOG_SCAN_LIMIT = 5_000;
const WORKSPACE_GRAPH_NODE_LIMIT = 100;
const WORKSPACE_GRAPH_EDGE_LIMIT = 200;

export const memoryIntelligenceServiceInputSchema = z.object({
  view: z.enum(["overview", "memory", "knowledge", "workspace"])
    .default("overview"),
  query: z.string().trim().max(4_000).optional(),
  category: z.string().trim().max(80).default("all"),
  tier: z.union([memoryTierSchema, z.literal("all")]).default("all"),
  state: z.union([indexStateSchema, z.literal("all")]).default("all"),
  cursor: z.string().trim().max(1_000).optional(),
  limit: z.number().int().min(1).max(100).default(40),
}).strict();

export async function showMemoryIntelligenceService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryIntelligenceServiceInputSchema>,
) {
  const value = memoryIntelligenceServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.memory.intelligence.show"),
  );
  const requestAccess = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "app.memory.intelligence.show",
    correlationId: caller.executionScope?.correlationId ||
      `memory_intelligence_${randomUUID()}`,
  });

  if (value.view === "memory") {
    const memories = await readMemoryCatalog(caller, requestAccess, "durable");
    const category = MEMORY_CATEGORY_IDS.includes(
        value.category as (typeof MEMORY_CATEGORY_IDS)[number],
      )
      ? value.category as (typeof MEMORY_CATEGORY_IDS)[number]
      : "all";
    const items = filterMemoryIndex(
      memories.filter((memory) => !isSourceKnowledgeMemory(memory))
        .map(memoryIndexItem),
      {
        query: value.query,
        category,
        tier: value.tier,
        state: value.state,
      },
    );
    const page = sliceIntelligencePage(items, value.cursor, value.limit, {
      view: value.view,
      query: value.query || "",
      category,
      tier: value.tier,
      state: value.state,
    });
    return completeAppServiceCall(authorized, { memory: page }, {
      resourceCount: page.items.length,
    });
  }

  if (value.view === "knowledge") {
    const documents = await listKnowledgeDocuments(
      EXISTING_KNOWLEDGE_CATALOG_SCAN_LIMIT,
      { tenantId: caller.context.tenantId },
    );
    const category = KNOWLEDGE_CATEGORY_IDS.includes(
        value.category as (typeof KNOWLEDGE_CATEGORY_IDS)[number],
      )
      ? value.category as (typeof KNOWLEDGE_CATEGORY_IDS)[number]
      : "all";
    const items = filterKnowledgeIndex(documents.map(knowledgeIndexItem), {
      query: value.query,
      category,
    });
    const page = sliceIntelligencePage(items, value.cursor, value.limit, {
      view: value.view,
      query: value.query || "",
      category,
    });
    return completeAppServiceCall(authorized, { knowledge: page }, {
      resourceCount: page.items.length,
    });
  }

  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    caller.context,
  );
  const memoryScanLimit = value.view === "workspace"
    ? MEMORY_CATALOG_SCAN_LIMIT
    : EXISTING_MEMORY_CATALOG_SCAN_LIMIT;
  const knowledgeScanLimit = value.view === "workspace"
    ? KNOWLEDGE_CATALOG_SCAN_LIMIT
    : EXISTING_KNOWLEDGE_CATALOG_SCAN_LIMIT;
  let memories: Awaited<ReturnType<typeof readMemoryCatalog>>;
  let documents: Awaited<ReturnType<typeof listKnowledgeDocuments>>;
  if (getDatabasePoolMax() === 1) {
    memories = await readMemoryCatalog(
      caller,
      requestAccess,
      "durable",
      memoryScanLimit,
    );
    documents = await listKnowledgeDocuments(knowledgeScanLimit, {
      tenantId: caller.context.tenantId,
    });
  } else {
    [memories, documents] = await Promise.all([
      readMemoryCatalog(caller, requestAccess, "durable", memoryScanLimit),
      listKnowledgeDocuments(knowledgeScanLimit, {
        tenantId: caller.context.tenantId,
      }),
    ]);
  }

  if (value.view === "workspace") {
    let nodes: Awaited<ReturnType<typeof listMemoryGraphNodes>>;
    let edges: Awaited<ReturnType<typeof listMemoryGraphEdges>>;
    let graphCounts: Awaited<ReturnType<typeof getMemoryGraphCounts>>;
    let latestGraphBuild: Awaited<
      ReturnType<typeof getLatestMemoryGraphBuild>
    >;
    const graphReadOptions = {
      tenantId: caller.context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    };
    if (getDatabasePoolMax() === 1) {
      nodes = await listMemoryGraphNodes(
        WORKSPACE_GRAPH_NODE_LIMIT,
        graphReadOptions,
      );
      edges = await listMemoryGraphEdges(
        WORKSPACE_GRAPH_EDGE_LIMIT,
        graphReadOptions,
      );
      graphCounts = await getMemoryGraphCounts(graphReadOptions);
      latestGraphBuild = await getLatestMemoryGraphBuild({
        tenantId: caller.context.tenantId,
      });
    } else {
      [nodes, edges, graphCounts, latestGraphBuild] = await Promise.all([
        listMemoryGraphNodes(WORKSPACE_GRAPH_NODE_LIMIT, graphReadOptions),
        listMemoryGraphEdges(WORKSPACE_GRAPH_EDGE_LIMIT, graphReadOptions),
        getMemoryGraphCounts(graphReadOptions),
        getLatestMemoryGraphBuild({ tenantId: caller.context.tenantId }),
      ]);
    }
    const overview = await buildOverviewProjection({
      caller,
      requestAccess,
      actorBinding,
      memories,
      documents,
      graphCounts,
      latestGraphBuild,
      includeQualityMetrics: false,
    });
    const memory = memoryPage(memories, value, "memory");
    const knowledge = knowledgePage(documents, value, "knowledge");
    return completeAppServiceCall(authorized, {
      overview,
      memory,
      knowledge,
      graph: {
        nodes,
        edges,
        stats: workspaceGraphStats(nodes, edges, graphCounts, latestGraphBuild),
      },
    }, {
      resourceCount:
        memory.items.length + knowledge.items.length + nodes.length + edges.length,
    });
  }

  let graphCounts: Awaited<ReturnType<typeof getMemoryGraphCounts>>;
  let latestGraphBuild: Awaited<ReturnType<typeof getLatestMemoryGraphBuild>>;
  if (getDatabasePoolMax() === 1) {
    graphCounts = await getMemoryGraphCounts({
      tenantId: caller.context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    });
    latestGraphBuild = await getLatestMemoryGraphBuild({
      tenantId: caller.context.tenantId,
    });
  } else {
    [graphCounts, latestGraphBuild] = await Promise.all([
      getMemoryGraphCounts({
        tenantId: caller.context.tenantId,
        accessScope: requestAccess?.databaseAccessScope,
      }),
      getLatestMemoryGraphBuild({ tenantId: caller.context.tenantId }),
    ]);
  }
  const overview = await buildOverviewProjection({
    caller,
    requestAccess,
    actorBinding,
    memories,
    documents,
    graphCounts,
    latestGraphBuild,
    includeQualityMetrics: true,
  });
  return completeAppServiceCall(authorized, { overview }, {
    resourceCount: memories.length + documents.length,
  });
}

async function buildOverviewProjection(input: {
  caller: AppServiceCaller;
  requestAccess: ReturnType<typeof requestMemoryAccessFromSecurityContext>;
  actorBinding: ReturnType<
    typeof canonicalRequestActorBindingFromSecurityContext
  >;
  memories: Awaited<ReturnType<typeof readMemoryCatalog>>;
  documents: Awaited<ReturnType<typeof listKnowledgeDocuments>>;
  graphCounts: Awaited<ReturnType<typeof getMemoryGraphCounts>>;
  latestGraphBuild: Awaited<ReturnType<typeof getLatestMemoryGraphBuild>>;
  includeQualityMetrics: boolean;
}) {
  const {
    caller,
    requestAccess,
    actorBinding,
    memories,
    documents,
    graphCounts,
    latestGraphBuild,
    includeQualityMetrics,
  } = input;
  // Vercel intentionally runs with a one-connection database pool. These
  // independent projections therefore execute serially: starting all of them
  // at once only creates an admission queue that can exceed the acquisition
  // timeout while producing no database parallelism.
  const ownerActorIds = actorBinding?.readableOwnerActorIds || [
    caller.context.actorId,
  ];
  const loadBaseOverviewSources = async () => {
    const knowledgeStats = await getKnowledgeStats({
      tenantId: caller.context.tenantId,
    });
    const legacyReviewStats = await getMemoryReconciliationStats({
      tenantId: caller.context.tenantId,
    });
    const privateReviewStats = requestAccess
      ? await getMemoryReconciliationStats({
          tenantId: caller.context.tenantId,
          accessScope: requestAccess.databaseAccessScope,
        })
      : { pending: 0, resolved: 0 };
    const deletionBarriers = await countAttributedMemoryDeletionReceipts({
      tenantId: caller.context.tenantId,
      initiatingActorIds: ownerActorIds,
    });
    const lastMaintenanceAt = await latestMemoryMaintenanceAt(
      caller.context.tenantId,
      ownerActorIds,
    );
    return {
      knowledgeStats,
      legacyReviewStats,
      privateReviewStats,
      deletionBarriers,
      lastMaintenanceAt,
    };
  };
  const baseOverviewSources = getDatabasePoolMax() === 1
    ? await loadBaseOverviewSources()
    : await (async () => {
      const [
        knowledgeStats,
        legacyReviewStats,
        privateReviewStats,
        deletionBarriers,
        lastMaintenanceAt,
      ] = await Promise.all([
        getKnowledgeStats({ tenantId: caller.context.tenantId }),
        getMemoryReconciliationStats({ tenantId: caller.context.tenantId }),
        requestAccess
          ? getMemoryReconciliationStats({
              tenantId: caller.context.tenantId,
              accessScope: requestAccess.databaseAccessScope,
            })
          : Promise.resolve({ pending: 0, resolved: 0 }),
        countAttributedMemoryDeletionReceipts({
          tenantId: caller.context.tenantId,
          initiatingActorIds: ownerActorIds,
        }),
        latestMemoryMaintenanceAt(caller.context.tenantId, ownerActorIds),
      ]);
      return {
        knowledgeStats,
        legacyReviewStats,
        privateReviewStats,
        deletionBarriers,
        lastMaintenanceAt,
      };
    })();
  const {
    knowledgeStats,
    legacyReviewStats,
    privateReviewStats,
    deletionBarriers,
    lastMaintenanceAt,
  } = baseOverviewSources;
  type QualitySources = {
    cognitionRecords: Awaited<ReturnType<typeof listKnowledgeCognitions>>;
    retrievalOutcomeSamples: Awaited<
      ReturnType<typeof listActorRetrievalOutcomeObservations>
    >;
    semanticShadowStats: Awaited<
      ReturnType<typeof getSemanticSummaryShadowStats>
    >;
  };
  const emptyQualitySources: QualitySources = {
    cognitionRecords: [],
    retrievalOutcomeSamples: {
      eligibleRatedRunCount: 0,
      observations: [],
      invalidOrExcludedCount: 0,
    },
    semanticShadowStats: {
      currentEnrichmentCount: 0,
      distinctThreadCount: 0,
    },
  };
  let qualitySources: QualitySources = emptyQualitySources;
  if (includeQualityMetrics && actorBinding) {
    if (getDatabasePoolMax() === 1) {
      const cognitionRecords = await listKnowledgeCognitions({
        tenantId: caller.context.tenantId,
        actorId: caller.context.actorId,
        limit: 250,
      });
      const retrievalOutcomeSamples =
        await listActorRetrievalOutcomeObservations({
          tenantId: caller.context.tenantId,
          ownerActorIds: actorBinding.readableOwnerActorIds,
          limit: 250,
        });
      const semanticShadowStats = await getSemanticSummaryShadowStats({
        tenantId: caller.context.tenantId,
        actorIds: actorBinding.readableOwnerActorIds.length
          ? actorBinding.readableOwnerActorIds
          : [caller.context.actorId],
      });
      qualitySources = {
        cognitionRecords,
        retrievalOutcomeSamples,
        semanticShadowStats,
      };
    } else {
      const [
        cognitionRecords,
        retrievalOutcomeSamples,
        semanticShadowStats,
      ] = await Promise.all([
        listKnowledgeCognitions({
          tenantId: caller.context.tenantId,
          actorId: caller.context.actorId,
          limit: 250,
        }),
        listActorRetrievalOutcomeObservations({
          tenantId: caller.context.tenantId,
          ownerActorIds: actorBinding.readableOwnerActorIds,
          limit: 250,
        }),
        getSemanticSummaryShadowStats({
          tenantId: caller.context.tenantId,
          actorIds: actorBinding.readableOwnerActorIds.length
            ? actorBinding.readableOwnerActorIds
            : [caller.context.actorId],
        }),
      ]);
      qualitySources = {
        cognitionRecords,
        retrievalOutcomeSamples,
        semanticShadowStats,
      };
    }
  }
  const {
    cognitionRecords,
    retrievalOutcomeSamples,
    semanticShadowStats,
  } = qualitySources;
  const generatedAt = new Date().toISOString();
  const readableOwnerActorIdSet = new Set(
    actorBinding?.readableOwnerActorIds || [],
  );
  const qualityMetrics = includeQualityMetrics
    ? publicMemoryCognitionQualityMetrics(
      buildMemoryCognitionQualityMetrics({
        cognition: {
          tenantId: caller.context.tenantId,
          actorId: caller.context.actorId,
          records: cognitionRecords,
        },
        durableMemories: memories.filter((memory) =>
          Boolean(
            memory.accessBinding &&
            readableOwnerActorIdSet.has(memory.accessBinding.ownerActorId),
          )
        ),
        knowledgeCounts: {
          documents: knowledgeStats.documents,
          chunks: knowledgeStats.chunks,
        },
        latestGraphBuild: latestGraphBuild || null,
        retrievalOutcomes: {
          eligibleRatedRunCount:
            retrievalOutcomeSamples.eligibleRatedRunCount,
          invalidOrExcludedCount:
            retrievalOutcomeSamples.invalidOrExcludedCount,
          aggregate: projectPublicRetrievalOutcomeAggregateV1({
            tenantId: caller.context.tenantId,
            actorIds: readableOwnerActorIdSet.size
              ? [...readableOwnerActorIdSet]
              : [caller.context.actorId],
            observations: retrievalOutcomeSamples.observations,
          }),
        },
        generatedAt,
      }),
    )
    : undefined;
  const overview = buildMemoryIntelligenceOverview({
    memories,
    documents,
    knowledgeStats,
    graphStats: {
      ...graphCounts,
      latestBuild: latestGraphBuild,
    },
    pendingReviews: legacyReviewStats.pending + privateReviewStats.pending,
    resolvedReviews: legacyReviewStats.resolved + privateReviewStats.resolved,
    deletionBarriers,
    lastMaintenanceAt,
    ...(qualityMetrics ? { qualityMetrics } : {}),
    ...(includeQualityMetrics ? { semanticShadowStats } : {}),
    generatedAt,
  });
  return overview;
}

function memoryPage(
  memories: Awaited<ReturnType<typeof readMemoryCatalog>>,
  value: z.infer<typeof memoryIntelligenceServiceInputSchema>,
  fingerprintView: "memory",
) {
  const category = MEMORY_CATEGORY_IDS.includes(
      value.category as (typeof MEMORY_CATEGORY_IDS)[number],
    )
    ? value.category as (typeof MEMORY_CATEGORY_IDS)[number]
    : "all";
  const items = filterMemoryIndex(
    memories.filter((memory) => !isSourceKnowledgeMemory(memory))
      .map(memoryIndexItem),
    {
      query: value.query,
      category,
      tier: value.tier,
      state: value.state,
    },
  );
  return sliceIntelligencePage(items, value.cursor, value.limit, {
    view: fingerprintView,
    query: value.query || "",
    category,
    tier: value.tier,
    state: value.state,
  });
}

function knowledgePage(
  documents: Awaited<ReturnType<typeof listKnowledgeDocuments>>,
  value: z.infer<typeof memoryIntelligenceServiceInputSchema>,
  fingerprintView: "knowledge",
) {
  const category = KNOWLEDGE_CATEGORY_IDS.includes(
      value.category as (typeof KNOWLEDGE_CATEGORY_IDS)[number],
    )
    ? value.category as (typeof KNOWLEDGE_CATEGORY_IDS)[number]
    : "all";
  const items = filterKnowledgeIndex(documents.map(knowledgeIndexItem), {
    query: value.query,
    category,
  });
  return sliceIntelligencePage(items, value.cursor, value.limit, {
    view: fingerprintView,
    query: value.query || "",
    category,
  });
}

function workspaceGraphStats(
  nodes: Awaited<ReturnType<typeof listMemoryGraphNodes>>,
  edges: Awaited<ReturnType<typeof listMemoryGraphEdges>>,
  counts: Awaited<ReturnType<typeof getMemoryGraphCounts>>,
  latestBuild: Awaited<ReturnType<typeof getLatestMemoryGraphBuild>>,
) {
  return Object.freeze({
    nodes: counts.nodes,
    edges: counts.edges,
    communities: null,
    sampledCommunities: connectedComponentCount(nodes, edges),
    communityCountScope: "visible_sample" as const,
    averageDegree: counts.nodes
      ? Math.round((counts.edges * 2 * 100) / counts.nodes) / 100
      : 0,
    latestBuild,
    topNodes: nodes.slice(0, 8),
    sampledNodes: nodes.length,
    sampledEdges: edges.length,
  });
}

function connectedComponentCount(
  nodes: Awaited<ReturnType<typeof listMemoryGraphNodes>>,
  edges: Awaited<ReturnType<typeof listMemoryGraphEdges>>,
) {
  const parent = new Map(nodes.map((node) => [node.id, node.id] as const));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current || current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) {
    if (!parent.has(edge.sourceNodeId) || !parent.has(edge.targetNodeId)) {
      continue;
    }
    const source = find(edge.sourceNodeId);
    const target = find(edge.targetNodeId);
    if (source !== target) parent.set(target, source);
  }
  return new Set([...parent.keys()].map(find)).size;
}

async function latestMemoryMaintenanceAt(
  tenantId: string,
  actorIds: readonly string[],
) {
  return getLatestScopedStreamEventAt(`memory-maintenance:${tenantId}`, {
    tenantId,
    actorIds,
    type: "memory.maintenance.completed",
  });
}

async function readMemoryCatalog(
  caller: AppServiceCaller,
  requestAccess: ReturnType<typeof requestMemoryAccessFromSecurityContext>,
  catalogClass: MemoryCatalogClass = "all",
  scanLimit = EXISTING_MEMORY_CATALOG_SCAN_LIMIT,
) {
  const readLegacy = () => listMemoryCatalog({
    tenantId: caller.context.tenantId,
    includeInactive: true,
    limit: scanLimit,
    catalogClass,
  });
  const readScoped = () => requestAccess
    ? listMemoryCatalog({
        tenantId: caller.context.tenantId,
        includeInactive: true,
        limit: scanLimit,
        catalogClass,
        accessScope: requestAccess.databaseAccessScope,
      })
    : Promise.resolve([]);
  let legacy: Awaited<ReturnType<typeof readLegacy>>;
  let scoped: Awaited<ReturnType<typeof readScoped>>;
  if (getDatabasePoolMax() === 1) {
    legacy = await readLegacy();
    scoped = await readScoped();
  } else {
    [legacy, scoped] = await Promise.all([readLegacy(), readScoped()]);
  }
  return mergeById(legacy, scoped)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    );
}

function mergeById<T extends { id: string }>(
  legacy: readonly T[],
  scoped: readonly T[],
) {
  return [...new Map(
    [...legacy, ...scoped].map((item) => [item.id, item] as const),
  ).values()];
}
