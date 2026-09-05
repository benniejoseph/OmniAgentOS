import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  parseDatabaseMemoryAccessScope,
  setTransactionLocalDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import {
  buildUserPrivateMemoryAccessBindingV1,
  memoryAccessBindingAllows,
  memoryAccessBindingV1Schema,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  toLegacyTenantOptions,
  type MemoryAccessContext,
} from "@/lib/memory/access-context";
import type { MemorySearchResult } from "@/lib/memory/types";
import { embedTexts } from "@/lib/openai/client";
import { searchMemoryGraph } from "@/lib/memory/graph";
import { searchMemories } from "@/lib/memory/store";
import { searchKnowledge } from "@/lib/rag/store";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  ContextEngineStats,
  ContextEvidenceItem,
  ContextPack,
  KnowledgeSearchResult,
  RetrievalIntent,
  RetrievalMode,
  RetrievalProfile,
  RetrievalTraceRecord,
} from "@/lib/rag/types";
import { citationIdForEvidence } from "@/lib/rag/citations";
import { normalizeExplicitEvidenceIds } from "@/lib/rag/evidence-selection";
import { redactSensitive } from "@/lib/security/context";
import type { AiUsageScope } from "@/lib/usage/types";

export type BuildContextPackOptions = {
  tenantId?: string;
  /**
   * Versioned execution-aware access metadata. During P0.1 this is adapted to
   * the existing tenant-only retrieval contract without changing results.
   */
  accessContext?: MemoryAccessContext;
  /**
   * Already-authorized database scope for non-legacy memory. User-private
   * results are recorded only in a separately scoped private trace; no scoped
   * query or result is written to the tenant-wide compatibility trace.
   */
  databaseMemoryAccessScope?: DatabaseMemoryAccessScope;
  limit?: number;
  candidateLimit?: number;
  persistTrace?: boolean;
  /**
   * An explicit allowlist of canonical `kind:id` evidence IDs selected by the
   * user. The IDs are resolved against fresh, tenant-scoped retrieval results;
   * client-provided evidence content is never accepted. An empty list
   * intentionally disables saved context for this task.
   */
  evidenceIds?: string[];
  /** Trusted server-created attribution for the retrieval embedding call. */
  usageScope?: AiUsageScope;
};

type RetrievalTraceLedger = {
  traces: RetrievalTraceRecord[];
};

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "can",
  "could",
  "for",
  "from",
  "have",
  "how",
  "into",
  "let",
  "our",
  "that",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

export async function buildContextPack(
  query: string,
  options: BuildContextPackOptions = {},
): Promise<ContextPack> {
  const startedAt = Date.now();
  const databaseMemoryAccessScope = resolveContextMemoryAccessScope(options);
  const privateTraceAccessScope = resolvePrivateTraceAccessScope(
    databaseMemoryAccessScope,
  );
  const tenantId = resolveContextTenantId(options, databaseMemoryAccessScope);
  const normalizedQuery = String(redactSensitive(query.trim())).slice(0, 4_000);
  const evidenceIds = normalizeExplicitEvidenceIds(options.evidenceIds);
  const limit = Math.min(Math.max(options.limit || 8, evidenceIds?.length || 1), 24);
  const candidateLimit = Math.min(Math.max(options.candidateLimit || limit * 3, limit), 60);
  const profile = profileQuery(normalizedQuery);

  if (!profile.shouldRetrieve || evidenceIds?.length === 0) {
    const pack: ContextPack = {
      query: normalizedQuery,
      profile,
      results: [],
      memoryResults: [],
      knowledgeResults: [],
      graphResults: [],
      contextBlock: formatContextPack([], profile),
    };
    if (options.persistTrace !== false && !databaseMemoryAccessScope) {
      pack.trace = await saveRetrievalTrace({
        tenantId,
        query: normalizedQuery,
        profile,
        resultCount: 0,
        selectedCount: 0,
        latencyMs: Date.now() - startedAt,
        results: [],
      });
    } else if (options.persistTrace !== false && privateTraceAccessScope) {
      pack.trace = await saveRetrievalTrace({
        tenantId,
        query: normalizedQuery,
        profile,
        resultCount: 0,
        selectedCount: 0,
        latencyMs: Date.now() - startedAt,
        results: [],
      }, { accessScope: privateTraceAccessScope });
    }
    return sanitizeContextPack(pack);
  }

  const retrievalQuery = profile.expandedQueries.join("\n");
  const queryEmbedding = (await embedTexts(
    [retrievalQuery || normalizedQuery],
    undefined,
    options.usageScope,
  ))?.[0];
  const [legacyMemoryResults, scopedMemoryResults, knowledgeResults, graphResults] = await Promise.all([
    searchMemories(retrievalQuery || normalizedQuery, { limit: candidateLimit, queryEmbedding, tenantId }),
    databaseMemoryAccessScope
      ? searchMemories(retrievalQuery || normalizedQuery, {
          limit: candidateLimit,
          queryEmbedding,
          tenantId,
          accessScope: databaseMemoryAccessScope,
        })
      : Promise.resolve([]),
    searchKnowledge(retrievalQuery || normalizedQuery, { limit: candidateLimit, queryEmbedding, tenantId }),
    searchMemoryGraph(normalizedQuery, {
      limit: Math.min(candidateLimit, 24),
      tenantId,
      accessScope: databaseMemoryAccessScope,
    }),
  ]);
  const memoryResults = mergeMemorySearchResults(
    legacyMemoryResults,
    scopedMemoryResults,
    candidateLimit,
  );
  const evidence = scoreEvidenceItems({
    profile,
    memoryResults,
    knowledgeResults,
    graphResults,
  });
  const evidenceIdSet = evidenceIds ? new Set(evidenceIds) : undefined;
  const selected = selectDiverseEvidence(
    evidenceIdSet ? evidence.filter((item) => evidenceIdSet.has(citationIdForEvidence(item))) : evidence,
    limit,
  );
  const selectedIdSet = evidenceIdSet
    ? new Set(selected.map(citationIdForEvidence))
    : undefined;
  const selectedMemoryResults = selectedIdSet
    ? memoryResults.filter((result) => selectedIdSet.has(`memory:${result.record.id}`))
    : memoryResults;
  const selectedKnowledgeResults = selectedIdSet
    ? knowledgeResults.filter((result) => selectedIdSet.has(`knowledge:${result.chunk.id}`))
    : knowledgeResults;
  const selectedGraphResults = selectedIdSet
    ? graphResults.filter((result) => selectedIdSet.has(`graph:${result.node.id}`))
    : graphResults;
  const traceResults = selected.map((item) => ({
    id: item.id,
    kind: item.kind,
    sourceKey: item.sourceKey,
    title: item.title,
    score: roundScore(item.score),
    utilityScore: roundScore(item.utilityScore),
    confidence: roundScore(item.confidence),
    reasons: item.reasons.slice(0, 8),
  }));
  const privateMemoryIds = new Set(
    scopedMemoryResults.map((result) => result.record.id),
  );
  const privateTraceResults = traceResults.filter(
    (result) => result.kind === "memory" && privateMemoryIds.has(result.id),
  );
  const trace =
    options.persistTrace === false
      ? undefined
      : !databaseMemoryAccessScope
        ? await saveRetrievalTrace({
          tenantId,
          query: normalizedQuery,
          profile,
          resultCount: memoryResults.length + knowledgeResults.length + graphResults.length,
          selectedCount: selected.length,
          latencyMs: Date.now() - startedAt,
          results: traceResults,
        })
        : privateTraceAccessScope
          ? await saveRetrievalTrace({
              tenantId,
              query: normalizedQuery,
              profile,
              resultCount: scopedMemoryResults.length,
              selectedCount: privateTraceResults.length,
              latencyMs: Date.now() - startedAt,
              results: privateTraceResults,
            }, { accessScope: privateTraceAccessScope })
          : undefined;

  return sanitizeContextPack({
    query: normalizedQuery,
    profile,
    results: selected,
    memoryResults: selectedMemoryResults,
    knowledgeResults: selectedKnowledgeResults,
    graphResults: selectedGraphResults,
    contextBlock: formatContextPack(selected, profile),
    trace,
  });
}

function resolveContextTenantId(
  options: BuildContextPackOptions,
  databaseMemoryAccessScope?: DatabaseMemoryAccessScope,
): string | undefined {
  const scopedTenantId = options.accessContext
    ? toLegacyTenantOptions(options.accessContext).tenantId
    : databaseMemoryAccessScope?.tenantId;
  if (!scopedTenantId) return options.tenantId;
  if (
    options.tenantId !== undefined &&
    normalizeTenantId(options.tenantId) !== normalizeTenantId(scopedTenantId)
  ) {
    throw new Error("Context retrieval tenant does not match its execution scope.");
  }
  return scopedTenantId;
}

function resolveContextMemoryAccessScope(
  options: BuildContextPackOptions,
): DatabaseMemoryAccessScope | undefined {
  if (!options.databaseMemoryAccessScope) return undefined;
  const scope = parseDatabaseMemoryAccessScope(
    options.databaseMemoryAccessScope,
  );
  if (scope.purposeId !== MEMORY_PURPOSE_IDS.retrieve) {
    throw new Error("Context retrieval requires the canonical memory retrieval purpose.");
  }
  const executionScope = options.accessContext?.executionScope;
  if (
    executionScope &&
    (
      executionScope.tenantId !== scope.tenantId ||
      executionScope.initiatingActorId !== scope.initiatingActorId ||
      executionScope.executingPrincipalType !== scope.executingPrincipalType ||
      executionScope.executingPrincipalId !== scope.executingPrincipalId ||
      executionScope.workspaceId !== scope.workspaceId ||
      executionScope.projectId !== scope.projectId ||
      executionScope.missionId !== scope.missionId
    )
  ) {
    throw new Error("Context retrieval scope does not match its execution scope.");
  }
  return scope;
}

function resolvePrivateTraceAccessScope(
  accessScope?: DatabaseMemoryAccessScope,
) {
  if (!accessScope) return undefined;
  return accessScope.executingPrincipalType === "user" &&
      accessScope.executingPrincipalId === accessScope.initiatingActorId &&
      accessScope.workspaceId === null &&
      accessScope.projectId === null &&
      accessScope.missionId === null
    ? accessScope
    : undefined;
}

function mergeMemorySearchResults(
  legacyResults: MemorySearchResult[],
  scopedResults: MemorySearchResult[],
  limit: number,
) {
  const byId = new Map<string, MemorySearchResult>();
  for (const result of [...legacyResults, ...scopedResults]) {
    const previous = byId.get(result.record.id);
    if (!previous || result.score > previous.score) {
      byId.set(result.record.id, result);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function sanitizeContextPack(pack: ContextPack): ContextPack {
  const sanitized = redactSensitive(pack) as ContextPack;
  return {
    ...sanitized,
    memoryResults: sanitized.memoryResults.map(withoutMemoryEmbedding),
    results: sanitized.results.map((item) => item.kind === "memory"
      ? { ...item, result: withoutMemoryEmbedding(item.result) }
      : item),
  };
}

function withoutMemoryEmbedding(
  result: MemorySearchResult,
): MemorySearchResult {
  const record = { ...result.record };
  delete record.embedding;
  return { ...result, record };
}

export async function listRetrievalTraces(
  limit = 20,
  options: {
    tenantId?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 100);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const legacyRows = await getSql()`
      SELECT *
      FROM omni_retrieval_traces
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `;
    const scopedRows = options.accessScope
      ? await runWithRetrievalTraceAccessScope(
          options.accessScope,
          tenantId,
          [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.retrieve],
          (sql) => sql`
            SELECT *
            FROM omni_retrieval_traces
            WHERE tenant_id = ${tenantId}
            ORDER BY created_at DESC
            LIMIT ${boundedLimit}
          `,
        )
      : [];
    return mergeRetrievalTraces(
      legacyRows.map(retrievalTraceFromRow),
      scopedRows.map(retrievalTraceFromRow),
      boundedLimit,
    );
  }

  const ledger = await readRetrievalTraceLedger();
  return ledger.traces
    .filter((trace) =>
      normalizeTenantId(trace.tenantId) === tenantId &&
      retrievalTraceVisibleForScope(trace, options.accessScope)
    )
    .slice(0, boundedLimit);
}

export async function getContextEngineStats(options: {
  tenantId?: string;
  accessScope?: DatabaseMemoryAccessScope;
} = {}): Promise<ContextEngineStats> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const legacy = await readContextEngineStats(getSql(), tenantId);
    const scoped = options.accessScope
      ? await runWithRetrievalTraceAccessScope(
          options.accessScope,
          tenantId,
          [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.retrieve],
          (sql) => readContextEngineStats(sql, tenantId),
        )
      : emptyContextEngineStats();
    const traces = legacy.traces + scoped.traces;
    return {
      traces,
      averageLatencyMs: weightedAverage(
        legacy.averageLatencyMs,
        legacy.traces,
        scoped.averageLatencyMs,
        scoped.traces,
      ),
      averageSelectedCount: weightedAverage(
        legacy.averageSelectedCount,
        legacy.traces,
        scoped.averageSelectedCount,
        scoped.traces,
      ),
      byMode: mergeModeCounts(legacy.byMode, scoped.byMode),
      latest: await listRetrievalTraces(5, {
        tenantId,
        accessScope: options.accessScope,
      }),
    };
  }

  const ledger = await readRetrievalTraceLedger();
  const traces = ledger.traces.filter((trace) =>
    normalizeTenantId(trace.tenantId) === tenantId &&
    retrievalTraceVisibleForScope(trace, options.accessScope)
  );
  const byMode = traces.reduce<Record<string, number>>((acc, trace) => {
    acc[trace.profile.mode] = (acc[trace.profile.mode] || 0) + 1;
    return acc;
  }, {});
  return {
    traces: traces.length,
    averageLatencyMs: average(traces.map((trace) => trace.latencyMs)),
    averageSelectedCount: average(traces.map((trace) => trace.selectedCount)),
    byMode,
    latest: traces.slice(0, 5),
  };
}

function profileQuery(query: string): RetrievalProfile {
  const queryTerms = tokenize(query);
  const rationale: string[] = [];
  const casual = !queryTerms.length || /^(hi|hello|hey|thanks|thank you|ok|okay)$/i.test(query);
  const personal = /\b(my|me|our|previous|remember|preference|decision|we decided)\b/i.test(query);
  const operational = /\b(workflow|tool|connector|approval|deploy|vercel|database|queue|cron|auth|security|run|eval)\b/i.test(query);
  const procedural = /\b(how|plan|steps|implement|build|fix|debug|migrate|configure|operate)\b/i.test(query);
  const global = /\b(all|across|entire|overall|themes|summarize|synthesize|compare|landscape|architecture|research|review|audit)\b/i.test(query);
  const questionComplexity = Math.min(1, queryTerms.length / 18);
  const complexity =
    Math.min(
      1,
      questionComplexity +
        (global ? 0.3 : 0) +
        (procedural ? 0.18 : 0) +
        (operational ? 0.12 : 0),
    );
  let mode: RetrievalMode = "hybrid";
  let intent: RetrievalIntent = "factual";

  if (casual) {
    mode = "direct";
    intent = "casual";
    rationale.push("No retrieval needed for short conversational input.");
  } else if (global) {
    mode = "global";
    intent = "global_synthesis";
    rationale.push("Global synthesis terms detected; favor diverse evidence across sources.");
  } else if (personal) {
    mode = "memory_first";
    intent = "personal";
    rationale.push("Personal or historical-memory terms detected; favor durable memories.");
  } else if (operational) {
    mode = "hybrid";
    intent = "operational";
    rationale.push("Operational terms detected; blend memory and knowledge evidence.");
  } else if (procedural) {
    mode = "local";
    intent = "procedural";
    rationale.push("Procedural terms detected; favor high-confidence local context.");
  }

  if (!rationale.length) {
    rationale.push("Default hybrid retrieval policy selected.");
  }

  return {
    mode,
    intent,
    shouldRetrieve: mode !== "direct",
    complexity: roundScore(complexity),
    queryTerms,
    expandedQueries: expandQueries(query, queryTerms, { personal, operational, procedural, global }),
    rationale,
  };
}

function expandQueries(
  query: string,
  queryTerms: string[],
  flags: {
    personal: boolean;
    operational: boolean;
    procedural: boolean;
    global: boolean;
  },
) {
  const variants = new Set<string>();
  if (query.trim()) {
    variants.add(query.trim());
  }

  const distilled = queryTerms.filter((term) => !stopWords.has(term)).join(" ");
  if (distilled && distilled !== query.trim().toLowerCase()) {
    variants.add(distilled);
  }

  if (flags.global) {
    variants.add(`${distilled || query} themes architecture synthesis evidence`);
  }

  if (flags.operational) {
    variants.add(`${distilled || query} workflow runtime operations security connector database`);
  }

  if (flags.procedural) {
    variants.add(`${distilled || query} procedure implementation verification`);
  }

  if (flags.personal) {
    variants.add(`${distilled || query} preference decision memory prior context`);
  }

  return Array.from(variants).slice(0, 5);
}

function scoreEvidenceItems({
  profile,
  memoryResults,
  knowledgeResults,
  graphResults,
}: {
  profile: RetrievalProfile;
  memoryResults: MemorySearchResult[];
  knowledgeResults: KnowledgeSearchResult[];
  graphResults: import("@/lib/memory/types").MemoryGraphSearchResult[];
}) {
  const memoryItems = memoryResults.map<ContextEvidenceItem>((result) => {
    const record = result.record;
    const freshnessScore = freshnessFromDate(record.updatedAt);
    const intentBoost = memoryIntentBoost(profile, record.type, record.tags);
    const supportScore = clamp01(result.score / 1.6);
    const utilityScore = clamp01(result.score * 0.58 + intentBoost + record.importance * 0.18 + freshnessScore * 0.08);
    return {
      id: record.id,
      kind: "memory",
      sourceKey: `memory:${record.type}:${record.source}`,
      title: record.title,
      content: record.content,
      score: result.score,
      utilityScore,
      supportScore,
      diversityScore: 1,
      freshnessScore,
      confidence: clamp01(utilityScore * 0.68 + supportScore * 0.32),
      reasons: [
        ...result.reasons,
        `intent: ${profile.intent}`,
        intentBoost > 0 ? "intent-aligned memory" : "",
        record.importance >= 0.75 ? "durable high-importance memory" : "",
      ].filter(Boolean),
      result,
    };
  });

  const knowledgeItems = knowledgeResults.map<ContextEvidenceItem>((result) => {
    const chunk = result.chunk;
    const sourceType = result.document?.sourceType || "text";
    const freshnessScore = result.recencyScore || freshnessFromDate(chunk.updatedAt);
    const intentBoost = knowledgeIntentBoost(profile, sourceType, chunk.tags);
    const supportScore = clamp01(result.vectorScore * 0.72 + result.lexicalScore * 0.28);
    const utilityScore = clamp01(result.score * 0.72 + intentBoost + freshnessScore * 0.08);
    return {
      id: chunk.id,
      kind: "knowledge",
      sourceKey: `knowledge:${result.document?.id || chunk.documentId}:${chunk.source}`,
      title: chunk.title,
      content: chunk.content,
      score: result.score,
      utilityScore,
      supportScore,
      diversityScore: 1,
      freshnessScore,
      confidence: clamp01(utilityScore * 0.7 + supportScore * 0.3),
      reasons: [
        ...result.reasons,
        `intent: ${profile.intent}`,
        intentBoost > 0 ? "intent-aligned source" : "",
      ].filter(Boolean),
      result,
    };
  });

  const graphItems = graphResults.map<ContextEvidenceItem>((result) => {
    const graphBoost = graphIntentBoost(profile, result.node.kind, result.node.tags);
    const supportScore = clamp01(result.score);
    const neighborhoodStrength = clamp01(result.neighborhood.reduce((sum, item) => sum + item.weight, 0) / 4);
    const utilityScore = clamp01(result.score * 0.68 + graphBoost + result.node.weight * 0.12 + neighborhoodStrength * 0.08);
    return {
      id: result.node.id,
      kind: "graph",
      sourceKey: `graph:${result.communityId}`,
      title: `Graph Memory: ${result.node.label}`,
      content: formatGraphEvidence(result),
      score: result.score,
      utilityScore,
      supportScore,
      diversityScore: 1,
      freshnessScore: 0.72,
      confidence: clamp01(utilityScore * 0.66 + supportScore * 0.24 + neighborhoodStrength * 0.1),
      reasons: [
        ...result.reasons,
        `intent: ${profile.intent}`,
        graphBoost > 0 ? "intent-aligned graph neighborhood" : "",
        result.neighborhood.length ? "connected memory evidence" : "",
      ].filter(Boolean),
      result,
    };
  });

  return [...memoryItems, ...knowledgeItems, ...graphItems].sort((left, right) => right.utilityScore - left.utilityScore);
}

function selectDiverseEvidence(items: ContextEvidenceItem[], limit: number) {
  const selected: ContextEvidenceItem[] = [];
  const perSource = new Map<string, number>();
  const perKind = new Map<string, number>();
  const maxPerSource = Math.max(1, Math.ceil(limit / 2));

  for (const item of items) {
    if (selected.length >= limit) {
      break;
    }

    const sourceCount = perSource.get(item.sourceKey) || 0;
    const kindCount = perKind.get(item.kind) || 0;
    if (sourceCount >= maxPerSource && selected.length >= Math.ceil(limit / 2)) {
      continue;
    }

    const sourcePenalty = sourceCount * 0.12;
    const kindPenalty = Math.max(0, kindCount - Math.ceil(limit / 2)) * 0.05;
    const diversityScore = clamp01(1 - sourcePenalty - kindPenalty);
    selected.push({
      ...item,
      diversityScore,
      utilityScore: clamp01(item.utilityScore * (0.78 + diversityScore * 0.22)),
      confidence: clamp01(item.confidence * (0.86 + diversityScore * 0.14)),
      reasons: [
        ...item.reasons,
        sourceCount ? "source-diversity penalty applied" : "diverse source",
      ],
    });
    perSource.set(item.sourceKey, sourceCount + 1);
    perKind.set(item.kind, kindCount + 1);
  }

  if (selected.length < limit) {
    const selectedIds = new Set(selected.map((item) => item.id));
    for (const item of items) {
      if (selected.length >= limit) {
        break;
      }
      if (!selectedIds.has(item.id)) {
        selected.push(item);
      }
    }
  }

  return selected.sort((left, right) => right.utilityScore - left.utilityScore);
}

function formatContextPack(items: ContextEvidenceItem[], profile: RetrievalProfile) {
  if (!items.length) {
    return [
      "Context Engine: no retrieval context selected.",
      `Retrieval mode: ${profile.mode}`,
      `Rationale: ${profile.rationale.join(" ")}`,
    ].join("\n");
  }

  const ordered = positionalPack(items);
  const evidence = ordered.map((item) => {
    const header = [
      `[${citationIdForEvidence(item)}] ${evidenceKindLabel(item.kind)}: ${item.title}`,
      `mode: ${profile.mode}; confidence: ${item.confidence.toFixed(2)}; utility: ${item.utilityScore.toFixed(2)}`,
      `reasons: ${item.reasons.slice(0, 6).join(", ") || "ranked context"}`,
    ];
    return [...header, item.content].join("\n");
  });
  const recap = items
    .slice(0, 3)
    .map((item) => `[${citationIdForEvidence(item)}] ${item.title} (${item.kind}, confidence ${item.confidence.toFixed(2)})`)
    .join("\n");

  return String(redactSensitive([
    "Context Engine Profile",
    `mode: ${profile.mode}`,
    `intent: ${profile.intent}`,
    `complexity: ${profile.complexity.toFixed(2)}`,
    `rationale: ${profile.rationale.join(" ")}`,
    "",
    "Selected Evidence",
    "Cite supported claims with the exact bracketed evidence ID shown below. Never invent an evidence ID.",
    evidence.join("\n\n---\n\n"),
    "",
    "Critical Evidence Recap",
    recap,
  ].join("\n")));
}

function positionalPack(items: ContextEvidenceItem[]) {
  if (items.length <= 3) {
    return items;
  }

  const top = items.slice(0, 2);
  const tail = items.slice(2);
  const endAnchor = tail.shift();
  return endAnchor ? [...top, ...tail, endAnchor] : items;
}

async function saveRetrievalTrace(
  input: Omit<RetrievalTraceRecord, "id" | "createdAt">,
  options: { accessScope?: DatabaseMemoryAccessScope } = {},
): Promise<RetrievalTraceRecord> {
  const safeInput = redactSensitive(
    input,
  ) as Omit<RetrievalTraceRecord, "id" | "createdAt">;
  const createdAt = new Date().toISOString();
  const tenantId = normalizeTenantId(safeInput.tenantId);
  const accessScope = options.accessScope
    ? requirePrivateTraceAccessScope(options.accessScope, tenantId)
    : undefined;
  const accessBinding = accessScope
    ? buildUserPrivateMemoryAccessBindingV1({
        tenantId,
        ownerActorId: accessScope.initiatingActorId,
        originPurpose: "context.retrieval.trace",
        allowedPurposeIds: [
          MEMORY_PURPOSE_IDS.read,
          MEMORY_PURPOSE_IDS.retrieve,
          MEMORY_PURPOSE_IDS.forget,
          MEMORY_PURPOSE_IDS.export,
        ],
        accessBoundAt: createdAt,
      })
    : undefined;
  if (
    accessBinding &&
    safeInput.results.some((result) => result.kind !== "memory")
  ) {
    throw new Error("Private retrieval traces may contain only scoped memory evidence.");
  }
  const record: RetrievalTraceRecord = {
    id: randomUUID(),
    createdAt,
    ...safeInput,
    tenantId,
    accessBinding,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const insert = (sql: RetrievalTraceSqlClient) => sql`
      INSERT INTO omni_retrieval_traces (
        id, tenant_id, query, profile, result_count, selected_count,
        latency_ms, results, created_at, access_contract_version,
        access_state, owner_actor_id, owner_agent_id, workspace_id,
        project_id, mission_id, visibility, sensitivity, origin_purpose,
        allowed_purpose_ids, access_scope_sha256, access_bound_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.query}, ${record.profile}::jsonb,
        ${record.resultCount}, ${record.selectedCount}, ${record.latencyMs},
        ${record.results}::jsonb, ${record.createdAt},
        ${accessBinding?.version || 0},
        ${accessBinding?.state || "legacy_unattributed"},
        ${accessBinding?.ownerActorId || null},
        ${accessBinding?.ownerAgentId || null},
        ${accessBinding?.workspaceId || null},
        ${accessBinding?.projectId || null},
        ${accessBinding?.missionId || null},
        ${accessBinding?.visibility || null},
        ${accessBinding?.sensitivity || null},
        ${accessBinding?.originPurpose || null},
        ${accessBinding?.allowedPurposeIds || null},
        ${accessBinding?.accessScopeSha256 || null},
        ${accessBinding?.accessBoundAt || null}
      )
    `;
    if (accessScope) {
      await runWithRetrievalTraceAccessScope(
        accessScope,
        tenantId,
        [MEMORY_PURPOSE_IDS.retrieve],
        insert,
      );
    } else {
      await insert(getSql());
    }
    return record;
  }

  await mutateRetrievalTraceLedger((ledger) => {
    ledger.traces.unshift(record);
    return trimRetrievalTraceLedger(ledger);
  });
  return record;
}

function retrievalTraceFromRow(row: Record<string, unknown>): RetrievalTraceRecord {
  const accessBinding = Number(row.access_contract_version || 0) === 1
    ? memoryAccessBindingV1Schema.parse({
        version: 1,
        state: row.access_state,
        tenantId: row.tenant_id,
        ownerActorId: row.owner_actor_id,
        ownerAgentId: row.owner_agent_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        missionId: row.mission_id,
        visibility: row.visibility,
        sensitivity: row.sensitivity,
        originPurpose: row.origin_purpose,
        allowedPurposeIds: row.allowed_purpose_ids,
        accessScopeSha256: row.access_scope_sha256,
        accessBoundAt: normalizeDate(row.access_bound_at),
      })
    : undefined;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    accessBinding,
    query: String(row.query || ""),
    profile: parseProfile(row.profile),
    resultCount: Number(row.result_count || 0),
    selectedCount: Number(row.selected_count || 0),
    latencyMs: Number(row.latency_ms || 0),
    results: Array.isArray(row.results)
      ? (row.results as RetrievalTraceRecord["results"])
      : [],
    createdAt: normalizeDate(row.created_at),
  };
}

type RetrievalTraceSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  readonly transactionScoped: boolean;
};

async function runWithRetrievalTraceAccessScope<T>(
  accessScope: DatabaseMemoryAccessScope,
  tenantId: string,
  allowedPurposeIds: readonly string[],
  operation: (sql: RetrievalTraceSqlClient) => Promise<T>,
): Promise<T> {
  const parsedScope = parseDatabaseMemoryAccessScope(accessScope);
  if (
    parsedScope.tenantId !== tenantId ||
    !allowedPurposeIds.includes(parsedScope.purposeId)
  ) {
    throw new Error("Retrieval trace access scope does not match this operation.");
  }
  return getSql().transaction(async (sql: RetrievalTraceSqlClient) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, parsedScope);
    return operation(sql);
  }) as Promise<T>;
}

function requirePrivateTraceAccessScope(
  accessScope: DatabaseMemoryAccessScope,
  tenantId: string,
) {
  const parsed = parseDatabaseMemoryAccessScope(accessScope);
  if (
    parsed.tenantId !== tenantId ||
    parsed.purposeId !== MEMORY_PURPOSE_IDS.retrieve ||
    !resolvePrivateTraceAccessScope(parsed)
  ) {
    throw new Error("Private retrieval trace requires canonical user retrieval scope.");
  }
  return parsed;
}

function retrievalTraceVisibleForScope(
  trace: RetrievalTraceRecord,
  accessScope?: DatabaseMemoryAccessScope,
) {
  if (!trace.accessBinding) return true;
  return accessScope
    ? memoryAccessBindingAllows(accessScope, trace.accessBinding)
    : false;
}

function mergeRetrievalTraces(
  legacy: RetrievalTraceRecord[],
  scoped: RetrievalTraceRecord[],
  limit: number,
) {
  return [...new Map(
    [...legacy, ...scoped].map((trace) => [trace.id, trace] as const),
  ).values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

async function readContextEngineStats(
  sql: RetrievalTraceSqlClient,
  tenantId: string,
) {
  const totals = await sql`
    SELECT COUNT(*)::int AS traces,
           COALESCE(AVG(latency_ms), 0)::int AS average_latency_ms,
           COALESCE(AVG(selected_count), 0)::float AS average_selected_count
    FROM omni_retrieval_traces
    WHERE tenant_id = ${tenantId}
  `;
  const modes = await sql`
    SELECT COALESCE(profile->>'mode', 'unknown') AS mode,
           COUNT(*)::int AS count
    FROM omni_retrieval_traces
    WHERE tenant_id = ${tenantId}
    GROUP BY mode
  `;
  return {
    traces: Number(totals[0]?.traces || 0),
    averageLatencyMs: Number(totals[0]?.average_latency_ms || 0),
    averageSelectedCount: Number(totals[0]?.average_selected_count || 0),
    byMode: modes.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.mode)] = Number(row.count);
      return acc;
    }, {}),
  };
}

function emptyContextEngineStats() {
  return {
    traces: 0,
    averageLatencyMs: 0,
    averageSelectedCount: 0,
    byMode: {} as Record<string, number>,
  };
}

function weightedAverage(
  leftAverage: number,
  leftCount: number,
  rightAverage: number,
  rightCount: number,
) {
  const count = leftCount + rightCount;
  return count
    ? Math.round((leftAverage * leftCount + rightAverage * rightCount) / count)
    : 0;
}

function mergeModeCounts(
  left: Record<string, number>,
  right: Record<string, number>,
) {
  const merged = { ...left };
  for (const [mode, count] of Object.entries(right)) {
    merged[mode] = (merged[mode] || 0) + count;
  }
  return merged;
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function parseProfile(value: unknown): RetrievalProfile {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as RetrievalProfile;
  }

  return {
    mode: "hybrid",
    intent: "factual",
    shouldRetrieve: true,
    complexity: 0.5,
    queryTerms: [],
    expandedQueries: [],
    rationale: ["Profile unavailable."],
  };
}

async function readRetrievalTraceLedger() {
  return readJsonFile<RetrievalTraceLedger>(getRetrievalTraceFile(), { traces: [] });
}

async function mutateRetrievalTraceLedger(mutator: (ledger: RetrievalTraceLedger) => RetrievalTraceLedger) {
  await updateJsonFile<RetrievalTraceLedger>(
    getRetrievalTraceFile(),
    { traces: [] },
    (ledger) => trimRetrievalTraceLedger(mutator(ledger)),
  );
}

function trimRetrievalTraceLedger(ledger: RetrievalTraceLedger): RetrievalTraceLedger {
  return {
    traces: ledger.traces.slice(0, 500),
  };
}

function memoryIntentBoost(profile: RetrievalProfile, type: string, tags: string[]) {
  let boost = 0;
  if (profile.mode === "memory_first") {
    boost += 0.22;
  }
  if (profile.intent === "procedural" && type === "procedure") {
    boost += 0.14;
  }
  if (profile.intent === "operational" && tags.some((tag) => ["workflow", "tool", "connector", "security"].includes(tag))) {
    boost += 0.12;
  }
  if (profile.intent === "personal" && ["preference", "decision", "task"].includes(type)) {
    boost += 0.12;
  }
  return boost;
}

function knowledgeIntentBoost(profile: RetrievalProfile, sourceType: string, tags: string[]) {
  let boost = 0;
  if (profile.mode === "global") {
    boost += 0.16;
  }
  if (profile.intent === "operational" && tags.some((tag) => ["rag", "workflow", "connector", "security"].includes(tag))) {
    boost += 0.1;
  }
  if (sourceType === "api" || sourceType === "file") {
    boost += 0.04;
  }
  return boost;
}

function graphIntentBoost(profile: RetrievalProfile, kind: string, tags: string[]) {
  let boost = 0;
  if (profile.mode === "global") {
    boost += 0.18;
  }
  if (profile.intent === "global_synthesis") {
    boost += 0.12;
  }
  if (profile.intent === "operational" && (kind === "workflow" || kind === "tool")) {
    boost += 0.1;
  }
  if (tags.some((tag) => profile.queryTerms.includes(tag))) {
    boost += 0.08;
  }
  return boost;
}

function formatGraphEvidence(result: import("@/lib/memory/types").MemoryGraphSearchResult) {
  const neighbors = result.neighborhood
    .map((item) => `- ${item.relation}: ${item.node.label} (weight ${item.weight.toFixed(2)})`)
    .join("\n");
  return [
    result.node.summary || `Graph memory node for ${result.node.label}.`,
    "",
    `Community: ${result.communityId}`,
    `Node kind: ${result.node.kind}`,
    `Source memories: ${result.node.memoryIds.length}`,
    `Retrieval traces: ${result.node.traceIds.length}`,
    result.node.tags.length ? `Tags: ${result.node.tags.join(", ")}` : "",
    neighbors ? `Connected signals:\n${neighbors}` : "Connected signals: none recorded yet.",
  ].filter(Boolean).join("\n");
}

function evidenceKindLabel(kind: ContextEvidenceItem["kind"]) {
  if (kind === "memory") {
    return "Memory";
  }
  if (kind === "knowledge") {
    return "Knowledge";
  }
  return "Graph";
}

function freshnessFromDate(value: string) {
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  return 1 / (1 + ageMs / (14 * 24 * 60 * 60 * 1000));
}

function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((term) => term.length > 2),
    ),
  );
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function getRetrievalTraceFile() {
  return getDataPath("retrieval-traces.json");
}
