import { Buffer } from "node:buffer";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { MemoryCatalogRecord } from "@/lib/memory/store";
import type { MemoryFormationReason, MemoryTier } from "@/lib/memory/tier-policy";
import type { MemoryGraphStats } from "@/lib/memory/types";
import type { KnowledgeDocument } from "@/lib/rag/types";

export const MEMORY_INTELLIGENCE_VERSION =
  "memory-intelligence-observatory:1" as const;

export const MEMORY_CATEGORY_IDS = [
  "preferences",
  "commitments",
  "decisions",
  "procedures",
  "experiences",
  "summaries",
  "facts",
] as const;

export type MemoryCategoryId = (typeof MEMORY_CATEGORY_IDS)[number];

export const KNOWLEDGE_CATEGORY_IDS = [
  "mail",
  "calendar",
  "drive",
  "transcripts",
  "documents",
  "web",
  "notes",
  "other",
] as const;

export type KnowledgeCategoryId = (typeof KNOWLEDGE_CATEGORY_IDS)[number];

export type MemoryIndexItem = Readonly<{
  id: string;
  title: string;
  category: MemoryCategoryId;
  type: MemoryCatalogRecord["type"];
  tier: MemoryTier;
  state: "active" | "candidate" | "superseded" | "contradicted" | "archived";
  confidence: number;
  importance: number;
  formationReason: MemoryFormationReason;
  assertedBy: NonNullable<MemoryCatalogRecord["assertedBy"]>;
  evidenceCount: number;
  useCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
  scope: "personal" | "project" | "workspace";
  visibility: string;
  pinned: boolean;
  byteCount: number;
}>;

export type KnowledgeIndexItem = Readonly<{
  id: string;
  title: string;
  category: KnowledgeCategoryId;
  sourceType: string;
  sourceLabel: string;
  tags: readonly string[];
  chunkCount: number;
  totalCharacters: number;
  indexedAt: string;
  hasCanonicalLineage: boolean;
}>;

export type MemoryStewardRecommendation = Readonly<{
  id: "review" | "embedding" | "scope" | "classification" | "maintenance";
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  action: "open_reviews" | "open_knowledge" | "run_maintenance" | "none";
  affectedCount: number;
}>;

export type MemoryIntelligenceOverview = Readonly<{
  version: typeof MEMORY_INTELLIGENCE_VERSION;
  generatedAt: string;
  summary: Readonly<{
    durableMemories: number;
    activeMemories: number;
    knowledgeDocuments: number;
    knowledgeChunks: number;
    embeddedChunks: number;
    pendingReviews: number;
    archivedMemories: number;
    graphNodes: number;
    graphEdges: number;
  }>;
  memoryCategories: readonly Readonly<{
    id: MemoryCategoryId;
    label: string;
    count: number;
  }>[];
  knowledgeCategories: readonly Readonly<{
    id: KnowledgeCategoryId;
    label: string;
    count: number;
  }>[];
  steward: Readonly<{
    agentId: "mnemosyne";
    name: "Mnemosyne";
    role: "Memory steward";
    state: "watching" | "attention" | "healthy";
    healthScore: number;
    lastObservedAt: string;
    autonomy: string;
    learningSignals: Readonly<{
      retrievalUses: number;
      corrections: number;
      forgetRequests: number;
      resolvedReviews: number;
    }>;
    recommendations: readonly MemoryStewardRecommendation[];
  }>;
}>;

export function isSourceKnowledgeMemory(memory: MemoryCatalogRecord) {
  if (memory.type !== "knowledge") return false;
  if (memory.tier === "summary") return false;
  if (
    memory.formationReason &&
    [
      "manual_user_entry",
      "explicit_user_request",
      "correction",
      "project_reflection",
      "project_artifact",
      "workflow_output",
      "maintenance_promotion",
    ].includes(memory.formationReason)
  ) return false;
  return memory.tags.includes("rag") ||
    memory.formationReason === "canonical_source_observation" ||
    memory.assertedBy === "import";
}

export function memoryIndexItem(
  memory: MemoryCatalogRecord,
): MemoryIndexItem {
  const archived = Boolean(memory.archivedAt);
  return Object.freeze({
    id: memory.id,
    title: memory.title,
    category: memoryCategory(memory),
    type: memory.type,
    tier: memory.tier || "semantic",
    state: archived
      ? "archived"
      : memory.claimStatus === "candidate" ||
          memory.claimStatus === "superseded" ||
          memory.claimStatus === "contradicted"
        ? memory.claimStatus
        : "active",
    confidence: memory.confidence ?? 0.7,
    importance: memory.importance,
    formationReason: memory.formationReason || "legacy_record",
    assertedBy: memory.assertedBy || "system",
    evidenceCount: memory.evidenceRefCount,
    useCount: memory.useCount || 0,
    lastUsedAt: memory.lastUsedAt || null,
    updatedAt: memory.updatedAt,
    scope: memory.accessBinding?.visibility === "user_private" ||
        memory.scope === "user"
      ? "personal"
      : memory.accessBinding?.visibility === "project_shared" ||
          memory.scope === "project"
        ? "project"
        : "workspace",
    visibility: memory.accessBinding?.visibility || "legacy_unattributed",
    pinned: Boolean(memory.pinnedAt),
    byteCount: memory.byteCount,
  });
}

export function knowledgeIndexItem(
  document: KnowledgeDocument,
): KnowledgeIndexItem {
  return Object.freeze({
    id: document.id,
    title: document.title,
    category: knowledgeCategory(document),
    sourceType: document.sourceType,
    sourceLabel: readableSourceLabel(document),
    tags: Object.freeze(document.tags.slice(0, 8)),
    chunkCount: document.chunkCount,
    totalCharacters: document.totalCharacters,
    indexedAt: document.updatedAt,
    hasCanonicalLineage: Boolean(
      document.sourceItemId && document.sourceRevisionId,
    ),
  });
}

export function buildMemoryIntelligenceOverview(input: {
  memories: readonly MemoryCatalogRecord[];
  documents: readonly KnowledgeDocument[];
  knowledgeStats: Readonly<{
    documents: number;
    chunks: number;
    characters: number;
    embedded: number;
  }>;
  graphStats: MemoryGraphStats;
  pendingReviews: number;
  resolvedReviews: number;
  deletionBarriers: number;
  generatedAt?: string;
}): MemoryIntelligenceOverview {
  const durable = input.memories.filter((memory) =>
    !isSourceKnowledgeMemory(memory)
  );
  const memoryItems = durable.map(memoryIndexItem);
  const knowledgeItems = input.documents.map(knowledgeIndexItem);
  const active = memoryItems.filter((item) => item.state === "active").length;
  const archived = memoryItems.filter((item) => item.state === "archived").length;
  const corrections = durable.filter((memory) =>
    memory.formationReason === "correction"
  ).length;
  const retrievalUses = durable.reduce(
    (total, memory) => total + (memory.useCount || 0),
    0,
  );
  const legacy = durable.filter((memory) => !memory.accessBinding).length;
  const unclassified = knowledgeItems.filter((item) =>
    item.category === "other"
  ).length;
  const missingEmbeddings = Math.max(
    0,
    input.knowledgeStats.chunks - input.knowledgeStats.embedded,
  );
  const recommendations = stewardRecommendations({
    pendingReviews: input.pendingReviews,
    missingEmbeddings,
    legacy,
    unclassified,
    durableCount: durable.length,
  });
  const embeddingCoverage = input.knowledgeStats.chunks
    ? input.knowledgeStats.embedded / input.knowledgeStats.chunks
    : 1;
  const reviewPenalty = Math.min(
    25,
    input.pendingReviews / Math.max(durable.length, 1) * 100,
  );
  const scopePenalty = Math.min(
    20,
    legacy / Math.max(durable.length, 1) * 20,
  );
  const healthScore = Math.max(
    0,
    Math.round(100 - (1 - embeddingCoverage) * 30 - reviewPenalty - scopePenalty),
  );
  const generatedAt = input.generatedAt || new Date().toISOString();

  return Object.freeze({
    version: MEMORY_INTELLIGENCE_VERSION,
    generatedAt,
    summary: Object.freeze({
      durableMemories: durable.length,
      activeMemories: active,
      knowledgeDocuments: input.knowledgeStats.documents,
      knowledgeChunks: input.knowledgeStats.chunks,
      embeddedChunks: input.knowledgeStats.embedded,
      pendingReviews: input.pendingReviews,
      archivedMemories: archived,
      graphNodes: input.graphStats.nodes,
      graphEdges: input.graphStats.edges,
    }),
    memoryCategories: Object.freeze(categoryCounts(
      MEMORY_CATEGORY_IDS,
      memoryItems.map((item) => item.category),
      memoryCategoryLabel,
    )),
    knowledgeCategories: Object.freeze(categoryCounts(
      KNOWLEDGE_CATEGORY_IDS,
      knowledgeItems.map((item) => item.category),
      knowledgeCategoryLabel,
    )),
    steward: Object.freeze({
      agentId: "mnemosyne",
      name: "Mnemosyne",
      role: "Memory steward",
      state: recommendations.some((item) => item.priority === "high")
        ? "attention"
        : recommendations.length
          ? "watching"
          : "healthy",
      healthScore,
      lastObservedAt: generatedAt,
      autonomy:
        "Monitors, classifies, links and recommends. Truth changes, promotion and forgetting always require governed review.",
      learningSignals: Object.freeze({
        retrievalUses,
        corrections,
        forgetRequests: input.deletionBarriers,
        resolvedReviews: input.resolvedReviews,
      }),
      recommendations: Object.freeze(recommendations),
    }),
  });
}

export function filterMemoryIndex(
  input: readonly MemoryIndexItem[],
  filter: {
    query?: string;
    category?: MemoryCategoryId | "all";
    tier?: MemoryTier | "all";
    state?: MemoryIndexItem["state"] | "all";
  },
) {
  const terms = normalizeTerms(filter.query);
  return input.filter((item) =>
    (filter.category === undefined || filter.category === "all" ||
      item.category === filter.category) &&
    (filter.tier === undefined || filter.tier === "all" ||
      item.tier === filter.tier) &&
    (filter.state === undefined || filter.state === "all" ||
      item.state === filter.state) &&
    terms.every((term) =>
      `${item.title} ${item.category} ${item.type} ${item.tier} ${item.formationReason}`
        .toLowerCase()
        .includes(term)
    )
  );
}

export function filterKnowledgeIndex(
  input: readonly KnowledgeIndexItem[],
  filter: {
    query?: string;
    category?: KnowledgeCategoryId | "all";
  },
) {
  const terms = normalizeTerms(filter.query);
  return input.filter((item) =>
    (filter.category === undefined || filter.category === "all" ||
      item.category === filter.category) &&
    terms.every((term) =>
      `${item.title} ${item.category} ${item.sourceType} ${item.sourceLabel} ${item.tags.join(" ")}`
        .toLowerCase()
        .includes(term)
    )
  );
}

export function sliceIntelligencePage<T>(
  input: readonly T[],
  cursor: string | undefined,
  limit: number,
  fingerprint: unknown,
) {
  const fingerprintSha256 = sourceContractSha256(fingerprint);
  const offset = decodeCursor(cursor, fingerprintSha256);
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const items = input.slice(offset, offset + boundedLimit);
  const nextOffset = offset + items.length;
  return Object.freeze({
    items,
    total: input.length,
    nextCursor: nextOffset < input.length
      ? encodeCursor(nextOffset, fingerprintSha256)
      : null,
  });
}

export function memoryCategoryLabel(id: MemoryCategoryId) {
  return ({
    preferences: "Preferences",
    commitments: "Commitments",
    decisions: "Decisions",
    procedures: "Procedures",
    experiences: "Experiences",
    summaries: "Summaries",
    facts: "Facts",
  })[id];
}

export function knowledgeCategoryLabel(id: KnowledgeCategoryId) {
  return ({
    mail: "Mail",
    calendar: "Calendar",
    drive: "Drive",
    transcripts: "Transcripts",
    documents: "Documents",
    web: "Web",
    notes: "Notes",
    other: "Other",
  })[id];
}

function memoryCategory(memory: MemoryCatalogRecord): MemoryCategoryId {
  if (memory.tier === "summary") return "summaries";
  if (memory.type === "preference") return "preferences";
  if (memory.type === "task") return "commitments";
  if (memory.type === "decision") return "decisions";
  if (memory.type === "procedure") return "procedures";
  if (memory.type === "episode") return "experiences";
  return "facts";
}

function knowledgeCategory(document: KnowledgeDocument): KnowledgeCategoryId {
  const text = `${document.source} ${document.title} ${document.tags.join(" ")}`
    .toLowerCase();
  if (/gmail|email|mail\b/.test(text)) return "mail";
  if (/calendar|meeting|event\b/.test(text)) return "calendar";
  if (/drive|google-doc|google-sheet|google-slide/.test(text)) return "drive";
  if (/transcript|caption|video|audio|recording|youtube/.test(text)) {
    return "transcripts";
  }
  if (document.sourceType === "url" || /https?:\/\//.test(text)) return "web";
  if (/note|notion|markdown|\.md\b/.test(text)) return "notes";
  if (
    document.sourceType === "file" ||
    /pdf|document|spreadsheet|presentation|upload/.test(text)
  ) return "documents";
  return "other";
}

function readableSourceLabel(document: KnowledgeDocument) {
  const text = `${document.source} ${document.tags.join(" ")}`.toLowerCase();
  if (text.includes("gmail") || text.includes("google:mail")) return "Gmail";
  if (text.includes("calendar")) return "Google Calendar";
  if (text.includes("drive")) return "Google Drive";
  if (text.includes("capture")) return "Capture";
  if (document.sourceType === "manual") return "Manual";
  if (document.sourceType === "file") return "Uploaded file";
  if (document.sourceType === "url") return "Web source";
  if (document.sourceType === "api") return "Connected source";
  return "Knowledge source";
}

function stewardRecommendations(input: {
  pendingReviews: number;
  missingEmbeddings: number;
  legacy: number;
  unclassified: number;
  durableCount: number;
}): MemoryStewardRecommendation[] {
  const recommendations: MemoryStewardRecommendation[] = [];
  if (input.pendingReviews) {
    recommendations.push(Object.freeze({
      id: "review",
      priority: "high",
      title: "Resolve proposed memories",
      detail: `${input.pendingReviews} candidates remain outside active recall until reviewed.`,
      action: "open_reviews",
      affectedCount: input.pendingReviews,
    }));
  }
  if (input.missingEmbeddings) {
    recommendations.push(Object.freeze({
      id: "embedding",
      priority: "high",
      title: "Complete semantic indexing",
      detail: `${input.missingEmbeddings} chunks currently rely on lexical retrieval only.`,
      action: "open_knowledge",
      affectedCount: input.missingEmbeddings,
    }));
  }
  if (input.legacy) {
    recommendations.push(Object.freeze({
      id: "scope",
      priority: "medium",
      title: "Migrate legacy ownership",
      detail: `${input.legacy} durable memories do not yet carry the current actor-bound access contract.`,
      action: "none",
      affectedCount: input.legacy,
    }));
  }
  if (input.unclassified) {
    recommendations.push(Object.freeze({
      id: "classification",
      priority: "medium",
      title: "Improve source classification",
      detail: `${input.unclassified} knowledge sources need a more precise provider or document category.`,
      action: "open_knowledge",
      affectedCount: input.unclassified,
    }));
  }
  if (input.durableCount > 20) {
    recommendations.push(Object.freeze({
      id: "maintenance",
      priority: "low",
      title: "Check lifecycle quality",
      detail: "Run deterministic deduplication and review any procedure promotions.",
      action: "run_maintenance",
      affectedCount: input.durableCount,
    }));
  }
  return recommendations;
}

function categoryCounts<T extends string>(
  ids: readonly T[],
  values: readonly T[],
  label: (id: T) => string,
) {
  return ids.map((id) => ({
    id,
    label: label(id),
    count: values.filter((value) => value === id).length,
  })).filter((item) => item.count > 0);
}

function normalizeTerms(query?: string) {
  return (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function encodeCursor(offset: number, fingerprintSha256: string) {
  return Buffer.from(JSON.stringify({ offset, fingerprintSha256 }))
    .toString("base64url");
}

function decodeCursor(cursor: string | undefined, fingerprintSha256: string) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown; fingerprintSha256?: unknown };
    if (
      parsed.fingerprintSha256 !== fingerprintSha256 ||
      !Number.isSafeInteger(parsed.offset) ||
      Number(parsed.offset) < 0 ||
      Number(parsed.offset) > 100_000
    ) throw new Error("invalid cursor");
    return Number(parsed.offset);
  } catch {
    throw new Error("Memory index cursor is invalid or stale.");
  }
}
