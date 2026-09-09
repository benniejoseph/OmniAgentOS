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
import { getKnowledgeStats, listKnowledgeDocuments } from "@/lib/rag/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { memoryTierSchema } from "@/lib/memory/tier-policy";

const indexStateSchema = z.enum([
  "active",
  "candidate",
  "superseded",
  "contradicted",
  "archived",
]);

export const memoryIntelligenceServiceInputSchema = z.object({
  view: z.enum(["overview", "memory", "knowledge"]).default("overview"),
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
    const documents = await listKnowledgeDocuments(5_000, {
      tenantId: caller.context.tenantId,
    });
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
  const [
    memories,
    documents,
    knowledgeStats,
    graphStats,
    latestGraphBuild,
    legacyReviewStats,
    privateReviewStats,
    deletionBarriers,
  ] = await Promise.all([
    readMemoryCatalog(caller, requestAccess, "durable"),
    listKnowledgeDocuments(5_000, {
      tenantId: caller.context.tenantId,
    }),
    getKnowledgeStats({ tenantId: caller.context.tenantId }),
    getMemoryGraphCounts({
      tenantId: caller.context.tenantId,
      accessScope: requestAccess?.databaseAccessScope,
    }),
    getLatestMemoryGraphBuild({ tenantId: caller.context.tenantId }),
    getMemoryReconciliationStats({ tenantId: caller.context.tenantId }),
    requestAccess
      ? getMemoryReconciliationStats({
          tenantId: caller.context.tenantId,
          accessScope: requestAccess.databaseAccessScope,
        })
      : Promise.resolve({ pending: 0, resolved: 0 }),
    countAttributedMemoryDeletionReceipts({
      tenantId: caller.context.tenantId,
      initiatingActorIds: actorBinding?.readableOwnerActorIds || [
        caller.context.actorId,
      ],
    }),
  ]);
  const overview = buildMemoryIntelligenceOverview({
    memories,
    documents,
    knowledgeStats,
    graphStats: {
      ...graphStats,
      latestBuild: latestGraphBuild,
    },
    pendingReviews: legacyReviewStats.pending + privateReviewStats.pending,
    resolvedReviews: legacyReviewStats.resolved + privateReviewStats.resolved,
    deletionBarriers,
  });
  return completeAppServiceCall(authorized, { overview }, {
    resourceCount: memories.length + documents.length,
  });
}

async function readMemoryCatalog(
  caller: AppServiceCaller,
  requestAccess: ReturnType<typeof requestMemoryAccessFromSecurityContext>,
  catalogClass: MemoryCatalogClass = "all",
) {
  const [legacy, scoped] = await Promise.all([
    listMemoryCatalog({
      tenantId: caller.context.tenantId,
      includeInactive: true,
      limit: 10_000,
      catalogClass,
    }),
    requestAccess
      ? listMemoryCatalog({
          tenantId: caller.context.tenantId,
          includeInactive: true,
          limit: 10_000,
          catalogClass,
          accessScope: requestAccess.databaseAccessScope,
        })
      : Promise.resolve([]),
  ]);
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
