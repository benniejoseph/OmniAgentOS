import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
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
import { redactSensitive } from "@/lib/security/context";

type BuildContextPackOptions = {
  tenantId?: string;
  limit?: number;
  candidateLimit?: number;
  persistTrace?: boolean;
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
  const normalizedQuery = String(redactSensitive(query.trim())).slice(0, 4_000);
  const limit = Math.min(Math.max(options.limit || 8, 1), 24);
  const candidateLimit = Math.min(Math.max(options.candidateLimit || limit * 3, limit), 60);
  const profile = profileQuery(normalizedQuery);

  if (!profile.shouldRetrieve) {
    const pack: ContextPack = {
      query: normalizedQuery,
      profile,
      results: [],
      memoryResults: [],
      knowledgeResults: [],
      graphResults: [],
      contextBlock: formatContextPack([], profile),
    };
    if (options.persistTrace !== false) {
      pack.trace = await saveRetrievalTrace({
        tenantId: options.tenantId,
        query: normalizedQuery,
        profile,
        resultCount: 0,
        selectedCount: 0,
        latencyMs: Date.now() - startedAt,
        results: [],
      });
    }
    return sanitizeContextPack(pack);
  }

  const retrievalQuery = profile.expandedQueries.join("\n");
  const queryEmbedding = (await embedTexts([retrievalQuery || normalizedQuery]))?.[0];
  const [memoryResults, knowledgeResults, graphResults] = await Promise.all([
    searchMemories(retrievalQuery || normalizedQuery, { limit: candidateLimit, queryEmbedding, tenantId: options.tenantId }),
    searchKnowledge(retrievalQuery || normalizedQuery, { limit: candidateLimit, queryEmbedding, tenantId: options.tenantId }),
    searchMemoryGraph(normalizedQuery, {
      limit: Math.min(candidateLimit, 24),
      tenantId: options.tenantId,
    }),
  ]);
  const evidence = scoreEvidenceItems({
    profile,
    memoryResults,
    knowledgeResults,
    graphResults,
  });
  const selected = selectDiverseEvidence(evidence, limit);
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
  const trace =
    options.persistTrace === false
      ? undefined
      : await saveRetrievalTrace({
          tenantId: options.tenantId,
          query: normalizedQuery,
          profile,
          resultCount: memoryResults.length + knowledgeResults.length + graphResults.length,
          selectedCount: selected.length,
          latencyMs: Date.now() - startedAt,
          results: traceResults,
        });

  return sanitizeContextPack({
    query: normalizedQuery,
    profile,
    results: selected,
    memoryResults,
    knowledgeResults,
    graphResults,
    contextBlock: formatContextPack(selected, profile),
    trace,
  });
}

function sanitizeContextPack(pack: ContextPack): ContextPack {
  return redactSensitive(pack) as ContextPack;
}

export async function listRetrievalTraces(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_retrieval_traces
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(retrievalTraceFromRow);
  }

  const ledger = await readRetrievalTraceLedger();
  return ledger.traces.filter((trace) => normalizeTenantId(trace.tenantId) === tenantId).slice(0, limit);
}

export async function getContextEngineStats(options: { tenantId?: string } = {}): Promise<ContextEngineStats> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const [totals, modes] = await Promise.all([
      getSql()`
        SELECT COUNT(*)::int AS traces,
               COALESCE(AVG(latency_ms), 0)::int AS average_latency_ms,
               COALESCE(AVG(selected_count), 0)::float AS average_selected_count
        FROM omni_retrieval_traces
        WHERE tenant_id = ${tenantId}
      `,
      getSql()`
        SELECT COALESCE(profile->>'mode', 'unknown') AS mode,
               COUNT(*)::int AS count
        FROM omni_retrieval_traces
        WHERE tenant_id = ${tenantId}
        GROUP BY mode
      `,
    ]);
    const byMode = modes.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.mode)] = Number(row.count);
      return acc;
    }, {});
    return {
      traces: Number(totals[0]?.traces || 0),
      averageLatencyMs: Number(totals[0]?.average_latency_ms || 0),
      averageSelectedCount: Number(totals[0]?.average_selected_count || 0),
      byMode,
      latest: await listRetrievalTraces(5, { tenantId }),
    };
  }

  const ledger = await readRetrievalTraceLedger();
  const traces = ledger.traces.filter((trace) => normalizeTenantId(trace.tenantId) === tenantId);
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
): Promise<RetrievalTraceRecord> {
  const safeInput = redactSensitive(
    input,
  ) as Omit<RetrievalTraceRecord, "id" | "createdAt">;
  const record: RetrievalTraceRecord = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...safeInput,
    tenantId: normalizeTenantId(safeInput.tenantId),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_retrieval_traces (
        id, tenant_id, query, profile, result_count, selected_count, latency_ms, results, created_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.query}, ${record.profile}::jsonb,
        ${record.resultCount}, ${record.selectedCount}, ${record.latencyMs},
        ${record.results}::jsonb, ${record.createdAt}
      )
    `;
    return record;
  }

  await mutateRetrievalTraceLedger((ledger) => {
    ledger.traces.unshift(record);
    return trimRetrievalTraceLedger(ledger);
  });
  return record;
}

function retrievalTraceFromRow(row: Record<string, unknown>): RetrievalTraceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
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
