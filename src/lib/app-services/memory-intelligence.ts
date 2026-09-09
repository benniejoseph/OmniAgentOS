import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { getMemoryGraphStats } from "@/lib/memory/graph";
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
  listAttributedMemoryDeletionReceipts,
  listMemoryCatalog,
  listMemoryReconciliationReviews,
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
    const memories = await readMemoryCatalog(caller, requestAccess);
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

  const memories = await readMemoryCatalog(caller, requestAccess);
  const documents = await listKnowledgeDocuments(5_000, {
    tenantId: caller.context.tenantId,
  });
  const knowledgeStats = await getKnowledgeStats({
    tenantId: caller.context.tenantId,
  });
  const graphStats = await getMemoryGraphStats({
    tenantId: caller.context.tenantId,
    accessScope: requestAccess?.databaseAccessScope,
  });
  const legacyReviews = await listMemoryReconciliationReviews({
    tenantId: caller.context.tenantId,
    status: "all",
    limit: 200,
  });
  const privateReviews = requestAccess
    ? await listMemoryReconciliationReviews({
        tenantId: caller.context.tenantId,
        status: "all",
        limit: 200,
        accessScope: requestAccess.databaseAccessScope,
      })
    : [];
  const reviews = mergeById(legacyReviews, privateReviews);
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    caller.context,
  );
  const deletionReceipts = await listAttributedMemoryDeletionReceipts({
    tenantId: caller.context.tenantId,
    initiatingActorIds: actorBinding?.readableOwnerActorIds || [
      caller.context.actorId,
    ],
    limit: 100,
  });
  const overview = buildMemoryIntelligenceOverview({
    memories,
    documents,
    knowledgeStats,
    graphStats,
    pendingReviews: reviews.filter((review) => review.status === "pending").length,
    resolvedReviews: reviews.filter((review) => review.status === "resolved").length,
    deletionBarriers: deletionReceipts.length,
  });
  const memoryItems = memories.filter((memory) => !isSourceKnowledgeMemory(memory))
    .map(memoryIndexItem);
  const knowledgeItems = documents.map(knowledgeIndexItem);
  const memory = sliceIntelligencePage(memoryItems, undefined, value.limit, {
    view: "memory",
    query: "",
    category: "all",
    tier: "all",
    state: "all",
  });
  const knowledge = sliceIntelligencePage(
    knowledgeItems,
    undefined,
    value.limit,
    { view: "knowledge", query: "", category: "all" },
  );

  return completeAppServiceCall(authorized, { overview, memory, knowledge }, {
    resourceCount: memory.items.length + knowledge.items.length,
  });
}

async function readMemoryCatalog(
  caller: AppServiceCaller,
  requestAccess: ReturnType<typeof requestMemoryAccessFromSecurityContext>,
) {
  const legacy = await listMemoryCatalog({
    tenantId: caller.context.tenantId,
    includeInactive: true,
    limit: 10_000,
  });
  const scoped = requestAccess
    ? await listMemoryCatalog({
        tenantId: caller.context.tenantId,
        includeInactive: true,
        limit: 10_000,
        accessScope: requestAccess.databaseAccessScope,
      })
    : [];
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
