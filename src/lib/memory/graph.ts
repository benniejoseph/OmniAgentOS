import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { listMemories } from "@/lib/memory/store";
import type {
  MemoryGraphBuildRecord,
  MemoryGraphEdge,
  MemoryGraphEdgeRelation,
  MemoryGraphNode,
  MemoryGraphNodeKind,
  MemoryGraphSearchResult,
  MemoryGraphStats,
  MemoryRecord,
} from "@/lib/memory/types";
import {
  readJsonFile,
  updateJsonFile,
  withJsonFileLock,
  writeJsonFile,
} from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  jsonbSafeStringify,
  jsonbSafeTruncate,
} from "@/lib/rag/text-safety";

type RebuildMemoryGraphOptions = {
  tenantId?: string;
  source?: string;
  memoryLimit?: number;
  traceLimit?: number;
};

type SearchMemoryGraphOptions = {
  tenantId?: string;
  limit?: number;
  nodeLimit?: number;
};

type GraphSqlClient = ReturnType<typeof getSql>;

type TraceSeed = {
  id: string;
  query: string;
  profile?: {
    mode?: string;
    intent?: string;
  };
  results: Array<{
    title?: string;
    kind?: string;
    reasons?: string[];
  }>;
  createdAt: string;
};

type MemoryGraphLedger = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  builds: MemoryGraphBuildRecord[];
};

type GraphCandidate = {
  kind: MemoryGraphNodeKind;
  label: string;
  slug: string;
  aliases: string[];
  tags: string[];
  summary: string;
  weight: number;
};

type GraphAggregate = {
  nodes: Map<string, MemoryGraphNode>;
  edges: Map<string, MemoryGraphEdge>;
};

const stopWords = new Set([
  "about",
  "after",
  "agent",
  "also",
  "and",
  "are",
  "can",
  "could",
  "done",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "let",
  "our",
  "that",
  "the",
  "this",
  "use",
  "used",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

const domainPhrases: Array<{ phrase: string; label: string; kind: MemoryGraphNodeKind; tags: string[] }> = [
  { phrase: "adaptive context engine", label: "Adaptive Context Engine", kind: "system", tags: ["context", "retrieval"] },
  { phrase: "context engine", label: "Context Engine", kind: "system", tags: ["context", "retrieval"] },
  { phrase: "retrieval augmented generation", label: "Retrieval Augmented Generation", kind: "system", tags: ["rag"] },
  { phrase: "rag", label: "RAG", kind: "system", tags: ["rag"] },
  { phrase: "graph memory", label: "Graph Memory", kind: "system", tags: ["memory", "graph"] },
  { phrase: "long-term memory", label: "Long-Term Memory", kind: "system", tags: ["memory"] },
  { phrase: "memory consolidation", label: "Memory Consolidation", kind: "system", tags: ["memory"] },
  { phrase: "retrieval trace", label: "Retrieval Trace", kind: "trace", tags: ["retrieval", "trace"] },
  { phrase: "workflow", label: "Workflow Runtime", kind: "workflow", tags: ["workflow"] },
  { phrase: "durable workflow", label: "Durable Workflow", kind: "workflow", tags: ["workflow"] },
  { phrase: "approval", label: "Approval Gates", kind: "workflow", tags: ["approval"] },
  { phrase: "connector", label: "Connectors", kind: "tool", tags: ["connector"] },
  { phrase: "openapi", label: "OpenAPI", kind: "tool", tags: ["connector", "api"] },
  { phrase: "mcp", label: "MCP", kind: "tool", tags: ["connector"] },
  { phrase: "pgvector", label: "pgvector", kind: "system", tags: ["vector", "postgres"] },
  { phrase: "hnsw", label: "HNSW", kind: "system", tags: ["vector"] },
  { phrase: "postgres", label: "Postgres", kind: "system", tags: ["database"] },
  { phrase: "neon", label: "Neon", kind: "system", tags: ["database"] },
  { phrase: "vercel", label: "Vercel", kind: "system", tags: ["deployment"] },
  { phrase: "openai", label: "OpenAI", kind: "system", tags: ["llm"] },
  { phrase: "responses api", label: "Responses API", kind: "system", tags: ["openai", "llm"] },
  { phrase: "evaluation", label: "Evaluation Harness", kind: "system", tags: ["evaluation"] },
  { phrase: "rbac", label: "RBAC", kind: "system", tags: ["security"] },
  { phrase: "auth", label: "Auth Control Plane", kind: "system", tags: ["security", "identity"] },
  { phrase: "security", label: "Security Controls", kind: "system", tags: ["security"] },
  { phrase: "queue", label: "Operation Queue", kind: "workflow", tags: ["queue", "workflow"] },
];

export async function rebuildMemoryGraph(options: RebuildMemoryGraphOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  return runWithDatabaseTenantScope(tenantId, () => rebuildMemoryGraphForTenant(options, tenantId));
}

export async function queueMemoryGraphRebuild(
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (!hasDatabaseUrl()) {
    await rebuildMemoryGraph({ tenantId, source: "queued-memory-change" });
    return { queued: false, tenantId, generation: "0" };
  }

  await ensureDatabaseSchema();
  return runWithDatabaseTenantScope(tenantId, async () => {
    const [row] = await getSql()`
      INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
        tenant_id, requested_at, attempts, last_error, updated_at, generation
      )
      VALUES (${tenantId}, NOW(), 0, NULL, NOW(), 1)
      ON CONFLICT (tenant_id) DO UPDATE SET
        requested_at = NOW(),
        attempts = 0,
        last_error = NULL,
        updated_at = NOW(),
        generation = rebuild.generation + 1
      RETURNING tenant_id, generation
    `;
    return {
      queued: true,
      tenantId: String(row?.tenant_id || tenantId),
      generation: String(row?.generation || "1"),
    };
  });
}

async function rebuildMemoryGraphForTenant(
  options: RebuildMemoryGraphOptions,
  tenantId: string,
) {
  const startedAt = Date.now();
  const source = options.source || "rebuild";

  try {
    let completedBuild: MemoryGraphBuildRecord | undefined;

    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      await getSql().transaction(async (sql: GraphSqlClient) => {
        await sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${"memory-graph:" + tenantId}, 0)
          )
        `;
        const { aggregate, selectedMemories, traces } =
          await collectMemoryGraphAggregate(options, tenantId, sql);
        const build = buildRecord({
          tenantId,
          status: "completed",
          source,
          memoryCount: selectedMemories.length,
          traceCount: traces.length,
          nodeCount: aggregate.nodes.size,
          edgeCount: aggregate.edges.size,
          latencyMs: Date.now() - startedAt,
        });
        completedBuild = build;
        await sql`DELETE FROM omni_memory_graph_edges WHERE tenant_id = ${tenantId}`;
        await sql`DELETE FROM omni_memory_graph_nodes WHERE tenant_id = ${tenantId}`;
        for (const node of aggregate.nodes.values()) {
          await insertGraphNode(node, sql);
        }
        for (const edge of aggregate.edges.values()) {
          await insertGraphEdge(edge, sql);
        }
        await insertGraphBuild(build, sql);
      });
    } else {
      await withJsonFileLock(getGraphFile(), async () => {
        const { aggregate, selectedMemories, traces } =
          await collectMemoryGraphAggregate(options, tenantId);
        const build = buildRecord({
          tenantId,
          status: "completed",
          source,
          memoryCount: selectedMemories.length,
          traceCount: traces.length,
          nodeCount: aggregate.nodes.size,
          edgeCount: aggregate.edges.size,
          latencyMs: Date.now() - startedAt,
        });
        completedBuild = build;
        const ledger = await readGraphLedger();
        await writeJsonFile<MemoryGraphLedger>(getGraphFile(), {
          nodes: [
            ...ledger.nodes.filter((node) => graphTenantId(node) !== tenantId),
            ...aggregate.nodes.values(),
          ].sort(sortNodes).slice(0, 2000),
          edges: [
            ...ledger.edges.filter((edge) => graphTenantId(edge) !== tenantId),
            ...aggregate.edges.values(),
          ].sort(sortEdges).slice(0, 5000),
          builds: [
            build,
            ...ledger.builds.filter((item) => graphTenantId(item) !== tenantId),
            ...ledger.builds.filter((item) => graphTenantId(item) === tenantId),
          ].slice(0, 50),
        });
      });
    }

    if (!completedBuild) {
      throw new Error("Memory graph rebuild did not produce a build record.");
    }
    return {
      build: completedBuild,
      stats: await getMemoryGraphStats({ tenantId }),
    };
  } catch (error) {
    const build = buildRecord({
      tenantId,
      status: "failed",
      source,
      memoryCount: 0,
      traceCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Memory graph rebuild failed.",
    });
    await saveGraphBuild(build);
    throw error;
  }
}

async function collectMemoryGraphAggregate(
  options: RebuildMemoryGraphOptions,
  tenantId: string,
  sql?: GraphSqlClient,
) {
  const memoryLimit = Math.min(Math.max(options.memoryLimit || 500, 1), 2000);
  const [memories, traces] = await Promise.all([
    listMemories({ tenantId, limit: memoryLimit, sql }),
    listTraceSeeds(options.traceLimit || 200, tenantId, sql),
  ]);
  const selectedMemories = memories.slice(0, memoryLimit);
  return {
    aggregate: aggregateGraph(selectedMemories, traces, tenantId),
    selectedMemories,
    traces,
  };
}

export async function indexMemoryGraphRecords(
  records: MemoryRecord[],
  source = "memory.write",
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || records[0]?.tenantId);
  if (records.some((record) => normalizeTenantId(record.tenantId) !== tenantId)) {
    throw new Error("Memory graph indexing cannot mix records from different tenants.");
  }
  return runWithDatabaseTenantScope(tenantId, () =>
    indexMemoryGraphRecordsForTenant(records, source, tenantId),
  );
}

async function indexMemoryGraphRecordsForTenant(
  records: MemoryRecord[],
  source: string,
  tenantId: string,
) {
  if (!records.length) {
    return getMemoryGraphStats({ tenantId });
  }

  const aggregate = aggregateGraph(records, [], tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql().transaction(async (sql: GraphSqlClient) => {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${"memory-graph:" + tenantId}, 0)
        )
      `;
      await upsertGraphNodes([...aggregate.nodes.values()], sql);
      await upsertGraphEdges([...aggregate.edges.values()], sql);
      await insertGraphBuild(
        buildRecord({
          tenantId,
          status: "completed",
          source,
          memoryCount: records.length,
          traceCount: 0,
          nodeCount: aggregate.nodes.size,
          edgeCount: aggregate.edges.size,
          latencyMs: 0,
        }),
        sql,
      );
    });
    return getMemoryGraphStats({ tenantId });
  }

  await mutateGraphLedger((ledger) => mergeLedger(ledger, aggregate, source, records.length, tenantId));
  return getMemoryGraphStats({ tenantId });
}

export async function searchMemoryGraph(
  query: string,
  options: SearchMemoryGraphOptions = {},
): Promise<MemoryGraphSearchResult[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  return runWithDatabaseTenantScope(tenantId, () =>
    searchMemoryGraphForTenant(query, { ...options, tenantId }),
  );
}

async function searchMemoryGraphForTenant(
  query: string,
  options: SearchMemoryGraphOptions,
): Promise<MemoryGraphSearchResult[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 6, 1), 24);
  const [nodes, edges] = await Promise.all([
    listMemoryGraphNodes(options.nodeLimit || 600, { tenantId }),
    listMemoryGraphEdges((options.nodeLimit || 600) * 3, { tenantId }),
  ]);
  if (!nodes.length) {
    return [];
  }

  const queryTerms = tokenize(query);
  const querySlug = slugify(query);
  const adjacency = buildAdjacency(edges);
  const components = componentIds(nodes, edges);
  const scores = new Map<string, { score: number; reasons: string[] }>();

  for (const node of nodes) {
    const nodeTerms = tokenize(`${node.label} ${node.summary} ${node.tags.join(" ")} ${node.aliases.join(" ")}`);
    const overlap = queryTerms.filter((term) => nodeTerms.includes(term));
    const lexicalScore = queryTerms.length ? overlap.length / queryTerms.length : 0;
    const exactScore =
      querySlug && (node.slug === querySlug || node.slug.includes(querySlug) || querySlug.includes(node.slug))
        ? 0.35
        : 0;
    const tagScore = node.tags.filter((tag) => queryTerms.includes(tag)).length * 0.08;
    const degreeScore = Math.min(0.2, (adjacency.get(node.id)?.length || 0) * 0.02);
    const sourceScore = Math.min(0.18, node.sourceCount * 0.015);
    const score = lexicalScore * 0.58 + exactScore + tagScore + node.weight * 0.12 + degreeScore + sourceScore;
    if (score > 0.06) {
      scores.set(node.id, {
        score,
        reasons: [
          overlap.length ? `matched ${overlap.slice(0, 5).join(", ")}` : "",
          exactScore ? "exact graph concept match" : "",
          tagScore ? "tag-aligned graph node" : "",
          degreeScore ? "connected memory neighborhood" : "",
        ].filter(Boolean),
      });
    }
  }

  const seedScores = [...scores.entries()].sort((left, right) => right[1].score - left[1].score).slice(0, 16);
  for (const [nodeId, seed] of seedScores) {
    for (const link of adjacency.get(nodeId) || []) {
      const propagated = seed.score * link.edge.weight * 0.32;
      if (propagated <= 0.04) {
        continue;
      }
      const current = scores.get(link.nodeId) || { score: 0, reasons: [] };
      scores.set(link.nodeId, {
        score: current.score + propagated,
        reasons: [...current.reasons, `graph propagation from ${nodeLabel(nodes, nodeId)}`].slice(0, 8),
      });
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return [...scores.entries()]
    .map(([nodeId, scored]) => {
      const node = byId.get(nodeId);
      if (!node) {
        return undefined;
      }
      return {
        node,
        score: roundScore(scored.score),
        communityId: components.get(node.id) || node.id,
        neighborhood: neighborhoodFor(node.id, adjacency, byId),
        reasons: scored.reasons.length ? scored.reasons : ["ranked graph memory"],
      } satisfies MemoryGraphSearchResult;
    })
    .filter((item): item is MemoryGraphSearchResult => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export async function listMemoryGraphNodes(
  limit = 100,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  return runWithDatabaseTenantScope(tenantId, () =>
    listMemoryGraphNodesForTenant(limit, tenantId),
  );
}

async function listMemoryGraphNodesForTenant(limit: number, tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_nodes
      WHERE tenant_id = ${tenantId}
      ORDER BY weight DESC, source_count DESC, updated_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 2000)}
    `;
    return rows.map(memoryGraphNodeFromRow);
  }

  return (await readGraphLedger()).nodes
    .filter((node) => graphTenantId(node) === tenantId)
    .map((node) => ({ ...node, tenantId }))
    .slice(0, limit);
}

export async function listMemoryGraphEdges(
  limit = 200,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  return runWithDatabaseTenantScope(tenantId, () =>
    listMemoryGraphEdgesForTenant(limit, tenantId),
  );
}

async function listMemoryGraphEdgesForTenant(limit: number, tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_edges
      WHERE tenant_id = ${tenantId}
      ORDER BY weight DESC, evidence_count DESC, updated_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 5000)}
    `;
    return rows.map(memoryGraphEdgeFromRow);
  }

  return (await readGraphLedger()).edges
    .filter((edge) => graphTenantId(edge) === tenantId)
    .map((edge) => ({ ...edge, tenantId }))
    .slice(0, limit);
}

export async function getMemoryGraphStats(
  options: { tenantId?: string } = {},
): Promise<MemoryGraphStats> {
  const tenantId = normalizeTenantId(options.tenantId);
  return runWithDatabaseTenantScope(tenantId, () =>
    getMemoryGraphStatsForTenant(tenantId),
  );
}

async function getMemoryGraphStatsForTenant(
  tenantId: string,
): Promise<MemoryGraphStats> {
  const [nodes, edges, latestBuild] = await Promise.all([
    listMemoryGraphNodes(1000, { tenantId }),
    listMemoryGraphEdges(3000, { tenantId }),
    getLatestGraphBuild(tenantId),
  ]);
  const communities = componentIds(nodes, edges);
  const communityCount = new Set(communities.values()).size;

  return {
    nodes: nodes.length,
    edges: edges.length,
    communities: communityCount,
    averageDegree: nodes.length ? Math.round((edges.length * 2 * 100) / nodes.length) / 100 : 0,
    latestBuild,
    topNodes: nodes.slice(0, 8),
  };
}

function aggregateGraph(
  memories: MemoryRecord[],
  traces: TraceSeed[],
  tenantId: string,
): GraphAggregate {
  const now = new Date().toISOString();
  const aggregate: GraphAggregate = {
    nodes: new Map(),
    edges: new Map(),
  };

  for (const memory of memories) {
    const candidates = extractCandidates({
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      summary: jsonbSafeTruncate(memory.content, 360),
      baseWeight: memory.importance,
    }).slice(0, 14);

    for (const candidate of candidates) {
      mergeNode(aggregate.nodes, nodeFromCandidate(candidate, now, tenantId, {
        sourceCount: 1,
        memoryIds: [memory.id],
        traceIds: [],
        tags: [...candidate.tags, ...memory.tags],
      }));
    }

    for (const [left, right] of boundedPairs(candidates.slice(0, 8))) {
      mergeEdge(
        aggregate.edges,
        edgeFromCandidates(left, right, relationFor(left, right), now, tenantId, {
          weight: (left.weight + right.weight + memory.importance) / 3,
          memoryIds: [memory.id],
          traceIds: [],
        }),
      );
    }
  }

  for (const trace of traces) {
    const resultText = trace.results.map((result) => result.title || "").join("\n");
    const candidates = extractCandidates({
      title: trace.query,
      content: resultText,
      tags: [trace.profile?.mode, trace.profile?.intent, "retrieval-trace"].filter(Boolean).map(String),
      summary: `Trace query: ${trace.query}`,
      baseWeight: 0.62,
    }).slice(0, 12);

    for (const candidate of candidates) {
      mergeNode(aggregate.nodes, nodeFromCandidate(candidate, now, tenantId, {
        sourceCount: 1,
        memoryIds: [],
        traceIds: [trace.id],
        tags: candidate.tags,
      }));
    }

    for (const [left, right] of boundedPairs(candidates.slice(0, 7))) {
      mergeEdge(
        aggregate.edges,
        edgeFromCandidates(left, right, traceRelationFor(left, right), now, tenantId, {
          weight: (left.weight + right.weight) / 2,
          memoryIds: [],
          traceIds: [trace.id],
        }),
      );
    }
  }

  return aggregate;
}

function extractCandidates({
  title,
  content,
  tags,
  summary,
  baseWeight,
}: {
  title: string;
  content: string;
  tags: string[];
  summary: string;
  baseWeight: number;
}) {
  const candidates = new Map<string, GraphCandidate>();
  const text = `${title}\n${tags.join(" ")}\n${content}`.slice(0, 6000);
  const lower = text.toLowerCase();

  for (const tag of tags) {
    const label = cleanLabel(tag);
    if (!label) {
      continue;
    }
    addCandidate(candidates, {
      kind: "tag",
      label,
      slug: slugify(label),
      aliases: [tag],
      summary: `Tag signal: ${label}`,
      tags: [slugify(label)],
      weight: Math.min(1, baseWeight + 0.08),
    });
  }

  for (const item of domainPhrases) {
    if (lower.includes(item.phrase)) {
      addCandidate(candidates, {
        kind: item.kind,
        label: item.label,
        slug: slugify(item.label),
        aliases: [item.phrase],
        summary,
        tags: item.tags,
        weight: Math.min(1, baseWeight + 0.16),
      });
    }
  }

  for (const phrase of phraseCandidates(`${title}\n${content.slice(0, 1200)}`)) {
    const label = cleanLabel(phrase);
    if (!label || stopWords.has(label.toLowerCase())) {
      continue;
    }
    addCandidate(candidates, {
      kind: inferKind(label),
      label,
      slug: slugify(label),
      aliases: [phrase],
      summary,
      tags: tags.map(slugify).filter(Boolean).slice(0, 8),
      weight: baseWeight,
    });
  }

  return [...candidates.values()]
    .sort((left, right) => right.weight - left.weight || right.label.length - left.label.length)
    .slice(0, 24);
}

function phraseCandidates(value: string) {
  const terms = tokenize(value).filter((term) => !stopWords.has(term));
  const phrases = new Set<string>();

  for (const term of terms) {
    if (term.length >= 4) {
      phrases.add(term);
    }
  }

  const titleTokens = tokenize(value.split("\n")[0] || "").filter((term) => !stopWords.has(term));
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= titleTokens.length - size; index += 1) {
      phrases.add(titleTokens.slice(index, index + size).join(" "));
    }
  }

  return [...phrases].slice(0, 40);
}

function addCandidate(candidates: Map<string, GraphCandidate>, candidate: GraphCandidate) {
  if (!candidate.slug || candidate.slug.length < 2) {
    return;
  }
  const existing = candidates.get(candidate.slug);
  if (!existing) {
    candidates.set(candidate.slug, {
      ...candidate,
      aliases: unique(candidate.aliases),
      tags: unique(candidate.tags),
    });
    return;
  }

  candidates.set(candidate.slug, {
    ...existing,
    aliases: unique([...existing.aliases, ...candidate.aliases]),
    tags: unique([...existing.tags, ...candidate.tags]),
    summary: longer(existing.summary, candidate.summary),
    weight: Math.max(existing.weight, candidate.weight),
    kind: existing.kind === "concept" ? candidate.kind : existing.kind,
  });
}

function nodeFromCandidate(
  candidate: GraphCandidate,
  now: string,
  tenantId: string,
  source: {
    sourceCount: number;
    memoryIds: string[];
    traceIds: string[];
    tags: string[];
  },
): MemoryGraphNode {
  return {
    id: nodeId(candidate.slug, tenantId),
    tenantId,
    kind: candidate.kind,
    label: candidate.label,
    slug: candidate.slug,
    aliases: unique(candidate.aliases),
    summary: candidate.summary,
    weight: roundScore(candidate.weight),
    sourceCount: source.sourceCount,
    memoryIds: unique(source.memoryIds),
    traceIds: unique(source.traceIds),
    tags: unique(source.tags.map(slugify).filter(Boolean)).slice(0, 24),
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function edgeFromCandidates(
  left: GraphCandidate,
  right: GraphCandidate,
  relation: MemoryGraphEdgeRelation,
  now: string,
  tenantId: string,
  source: {
    weight: number;
    memoryIds: string[];
    traceIds: string[];
  },
): MemoryGraphEdge {
  const [sourceNodeId, targetNodeId] = [
    nodeId(left.slug, tenantId),
    nodeId(right.slug, tenantId),
  ].sort();
  return {
    id: edgeId(sourceNodeId, targetNodeId, relation, tenantId),
    tenantId,
    sourceNodeId,
    targetNodeId,
    relation,
    weight: roundScore(source.weight),
    evidenceCount: 1,
    memoryIds: unique(source.memoryIds),
    traceIds: unique(source.traceIds),
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function mergeNode(nodes: Map<string, MemoryGraphNode>, node: MemoryGraphNode) {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, node);
    return;
  }

  const memoryIds = unique([...existing.memoryIds, ...node.memoryIds]);
  const traceIds = unique([...existing.traceIds, ...node.traceIds]);
  nodes.set(node.id, {
    ...existing,
    aliases: unique([...existing.aliases, ...node.aliases]),
    summary: longer(existing.summary, node.summary),
    weight: roundScore(Math.max(existing.weight, node.weight)),
    sourceCount: unique([...memoryIds, ...traceIds]).length,
    memoryIds,
    traceIds,
    tags: unique([...existing.tags, ...node.tags]).slice(0, 24),
    updatedAt: node.updatedAt,
  });
}

function mergeEdge(edges: Map<string, MemoryGraphEdge>, edge: MemoryGraphEdge) {
  const existing = edges.get(edge.id);
  if (!existing) {
    edges.set(edge.id, edge);
    return;
  }

  const memoryIds = unique([...existing.memoryIds, ...edge.memoryIds]);
  const traceIds = unique([...existing.traceIds, ...edge.traceIds]);
  edges.set(edge.id, {
    ...existing,
    weight: roundScore(Math.max(existing.weight, edge.weight)),
    evidenceCount: unique([...memoryIds, ...traceIds]).length,
    memoryIds,
    traceIds,
    updatedAt: edge.updatedAt,
  });
}

async function listTraceSeeds(
  limit: number,
  tenantId: string,
  sql?: GraphSqlClient,
): Promise<TraceSeed[]> {
  if (hasDatabaseUrl()) {
    if (!sql) {
      await ensureDatabaseSchema();
    }
    const query = sql || getSql();
    const rows = await query`
      SELECT id, query, profile, results, created_at
      FROM omni_retrieval_traces
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 1000)}
    `;
    return rows.map(traceSeedFromRow);
  }

  const ledger = await readJsonFile<{ traces: TraceSeed[] }>(getDataPath("retrieval-traces.json"), { traces: [] });
  return ledger.traces
    .filter((trace) =>
      graphTenantId(trace as TraceSeed & { tenantId?: string }) === tenantId
    )
    .slice(0, limit)
    .map(traceSeedFromRow);
}

async function upsertGraphNodes(
  nodes: MemoryGraphNode[],
  sql: GraphSqlClient = getSql(),
) {
  if (!nodes.length) {
    return;
  }
  const payload = nodes.map((node) => ({
    id: node.id,
    tenant_id: node.tenantId,
    kind: node.kind,
    label: node.label,
    slug: storageGraphSlug(node.tenantId, node.slug),
    aliases: node.aliases,
    summary: node.summary,
    weight: node.weight,
    source_count: node.sourceCount,
    memory_ids: node.memoryIds,
    trace_ids: node.traceIds,
    tags: node.tags,
    metadata: node.metadata,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  }));
  await sql`
    INSERT INTO omni_memory_graph_nodes (
      id, tenant_id, kind, label, slug, aliases, summary, weight, source_count,
      memory_ids, trace_ids, tags, metadata, created_at, updated_at
    )
    SELECT
      id, tenant_id, kind, label, slug, aliases, summary, weight, source_count,
      memory_ids, trace_ids, tags, metadata, created_at, updated_at
    FROM jsonb_to_recordset(${jsonbSafeStringify(payload)}::text::jsonb) AS input(
      id text,
      tenant_id text,
      kind text,
      label text,
      slug text,
      aliases text[],
      summary text,
      weight double precision,
      source_count integer,
      memory_ids text[],
      trace_ids text[],
      tags text[],
      metadata jsonb,
      created_at timestamptz,
      updated_at timestamptz
    )
    ON CONFLICT (id) DO UPDATE SET
      aliases = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.aliases || EXCLUDED.aliases)),
      summary = CASE
        WHEN length(EXCLUDED.summary) > length(omni_memory_graph_nodes.summary)
        THEN EXCLUDED.summary
        ELSE omni_memory_graph_nodes.summary
      END,
      weight = GREATEST(omni_memory_graph_nodes.weight, EXCLUDED.weight),
      source_count = (
        SELECT COUNT(DISTINCT source.id)::int
        FROM unnest(
          omni_memory_graph_nodes.memory_ids ||
          EXCLUDED.memory_ids ||
          omni_memory_graph_nodes.trace_ids ||
          EXCLUDED.trace_ids
        ) AS source(id)
      ),
      memory_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.memory_ids || EXCLUDED.memory_ids)),
      trace_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.trace_ids || EXCLUDED.trace_ids)),
      tags = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.tags || EXCLUDED.tags)),
      updated_at = EXCLUDED.updated_at
  `;
}

async function upsertGraphEdges(
  edges: MemoryGraphEdge[],
  sql: GraphSqlClient = getSql(),
) {
  if (!edges.length) {
    return;
  }
  const payload = edges.map((edge) => ({
    id: edge.id,
    tenant_id: edge.tenantId,
    source_node_id: edge.sourceNodeId,
    target_node_id: edge.targetNodeId,
    relation: edge.relation,
    weight: edge.weight,
    evidence_count: edge.evidenceCount,
    memory_ids: edge.memoryIds,
    trace_ids: edge.traceIds,
    metadata: edge.metadata,
    created_at: edge.createdAt,
    updated_at: edge.updatedAt,
  }));
  await sql`
    INSERT INTO omni_memory_graph_edges (
      id, tenant_id, source_node_id, target_node_id, relation, weight, evidence_count,
      memory_ids, trace_ids, metadata, created_at, updated_at
    )
    SELECT
      id, tenant_id, source_node_id, target_node_id, relation, weight,
      evidence_count, memory_ids, trace_ids, metadata, created_at, updated_at
    FROM jsonb_to_recordset(${jsonbSafeStringify(payload)}::text::jsonb) AS input(
      id text,
      tenant_id text,
      source_node_id text,
      target_node_id text,
      relation text,
      weight double precision,
      evidence_count integer,
      memory_ids text[],
      trace_ids text[],
      metadata jsonb,
      created_at timestamptz,
      updated_at timestamptz
    )
    ON CONFLICT (id) DO UPDATE SET
      weight = GREATEST(omni_memory_graph_edges.weight, EXCLUDED.weight),
      evidence_count = (
        SELECT COUNT(DISTINCT source.id)::int
        FROM unnest(
          omni_memory_graph_edges.memory_ids ||
          EXCLUDED.memory_ids ||
          omni_memory_graph_edges.trace_ids ||
          EXCLUDED.trace_ids
        ) AS source(id)
      ),
      memory_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_edges.memory_ids || EXCLUDED.memory_ids)),
      trace_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_edges.trace_ids || EXCLUDED.trace_ids)),
      updated_at = EXCLUDED.updated_at
  `;
}

async function insertGraphNode(node: MemoryGraphNode, sql: GraphSqlClient = getSql()) {
  await sql`
    INSERT INTO omni_memory_graph_nodes (
      id, tenant_id, kind, label, slug, aliases, summary, weight, source_count,
      memory_ids, trace_ids, tags, metadata, created_at, updated_at
    )
    VALUES (
      ${node.id}, ${node.tenantId}, ${node.kind}, ${node.label},
      ${storageGraphSlug(node.tenantId, node.slug)}, ${node.aliases},
      ${node.summary}, ${node.weight}, ${node.sourceCount}, ${node.memoryIds},
      ${node.traceIds}, ${node.tags}, ${jsonbSafeStringify(node.metadata)}::text::jsonb,
      ${node.createdAt}, ${node.updatedAt}
    )
  `;
}

async function insertGraphEdge(edge: MemoryGraphEdge, sql: GraphSqlClient = getSql()) {
  await sql`
    INSERT INTO omni_memory_graph_edges (
      id, tenant_id, source_node_id, target_node_id, relation, weight, evidence_count,
      memory_ids, trace_ids, metadata, created_at, updated_at
    )
    VALUES (
      ${edge.id}, ${edge.tenantId}, ${edge.sourceNodeId}, ${edge.targetNodeId}, ${edge.relation},
      ${edge.weight}, ${edge.evidenceCount}, ${edge.memoryIds}, ${edge.traceIds},
      ${jsonbSafeStringify(edge.metadata)}::text::jsonb, ${edge.createdAt}, ${edge.updatedAt}
    )
  `;
}

async function saveGraphBuild(build: MemoryGraphBuildRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await insertGraphBuild(build);
    return;
  }

  await mutateGraphLedger((ledger) => ({
    ...ledger,
    builds: [build, ...ledger.builds].slice(0, 50),
  }));
}

async function insertGraphBuild(build: MemoryGraphBuildRecord, sql: GraphSqlClient = getSql()) {
  await sql`
    INSERT INTO omni_memory_graph_builds (
      id, tenant_id, status, source, memory_count, trace_count, node_count, edge_count,
      latency_ms, error, created_at
    )
    VALUES (
      ${build.id}, ${build.tenantId}, ${build.status}, ${build.source}, ${build.memoryCount},
      ${build.traceCount}, ${build.nodeCount}, ${build.edgeCount},
      ${build.latencyMs}, ${build.error || null}, ${build.createdAt}
    )
  `;
}

async function getLatestGraphBuild(tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_builds
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? memoryGraphBuildFromRow(rows[0]) : undefined;
  }

  const build = (await readGraphLedger()).builds
    .find((item) => graphTenantId(item) === tenantId);
  return build ? { ...build, tenantId } : undefined;
}

function mergeLedger(
  ledger: MemoryGraphLedger,
  aggregate: GraphAggregate,
  source: string,
  memoryCount: number,
  tenantId: string,
): MemoryGraphLedger {
  const otherNodes = ledger.nodes.filter((node) => graphTenantId(node) !== tenantId);
  const otherEdges = ledger.edges.filter((edge) => graphTenantId(edge) !== tenantId);
  const nodes = new Map(
    ledger.nodes
      .filter((node) => graphTenantId(node) === tenantId)
      .map((node) => [node.id, { ...node, tenantId }]),
  );
  const edges = new Map(
    ledger.edges
      .filter((edge) => graphTenantId(edge) === tenantId)
      .map((edge) => [edge.id, { ...edge, tenantId }]),
  );
  for (const node of aggregate.nodes.values()) {
    mergeNode(nodes, node);
  }
  for (const edge of aggregate.edges.values()) {
    mergeEdge(edges, edge);
  }

  return {
    nodes: [...otherNodes, ...nodes.values()].sort(sortNodes).slice(0, 2000),
    edges: [...otherEdges, ...edges.values()].sort(sortEdges).slice(0, 5000),
    builds: [
      buildRecord({
        tenantId,
        status: "completed",
        source,
        memoryCount,
        traceCount: 0,
        nodeCount: aggregate.nodes.size,
        edgeCount: aggregate.edges.size,
        latencyMs: 0,
      }),
      ...ledger.builds,
    ].slice(0, 50),
  };
}

async function readGraphLedger() {
  return readJsonFile<MemoryGraphLedger>(getGraphFile(), { nodes: [], edges: [], builds: [] });
}

async function mutateGraphLedger(mutator: (ledger: MemoryGraphLedger) => MemoryGraphLedger) {
  await updateJsonFile<MemoryGraphLedger>(
    getGraphFile(),
    { nodes: [], edges: [], builds: [] },
    (ledger) => {
      const next = mutator(ledger);
      return {
        nodes: next.nodes.slice(0, 2000),
        edges: next.edges.slice(0, 5000),
        builds: next.builds.slice(0, 50),
      };
    },
  );
}

function memoryGraphNodeFromRow(row: Record<string, unknown>): MemoryGraphNode {
  const tenantId = storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined);
  return {
    id: String(row.id),
    tenantId,
    kind: normalizeKind(String(row.kind || "concept")),
    label: String(row.label || ""),
    slug: logicalGraphSlug(tenantId, String(row.slug || "")),
    aliases: stringArray(row.aliases),
    summary: String(row.summary || ""),
    weight: Number(row.weight || 0),
    sourceCount: Number(row.source_count || 0),
    memoryIds: stringArray(row.memory_ids),
    traceIds: stringArray(row.trace_ids),
    tags: stringArray(row.tags),
    metadata: objectValue(row.metadata),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function memoryGraphEdgeFromRow(row: Record<string, unknown>): MemoryGraphEdge {
  return {
    id: String(row.id),
    tenantId: storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined),
    sourceNodeId: String(row.source_node_id || ""),
    targetNodeId: String(row.target_node_id || ""),
    relation: normalizeRelation(String(row.relation || "co_occurs")),
    weight: Number(row.weight || 0),
    evidenceCount: Number(row.evidence_count || 0),
    memoryIds: stringArray(row.memory_ids),
    traceIds: stringArray(row.trace_ids),
    metadata: objectValue(row.metadata),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function memoryGraphBuildFromRow(row: Record<string, unknown>): MemoryGraphBuildRecord {
  return {
    id: String(row.id),
    tenantId: storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined),
    status: row.status === "failed" ? "failed" : "completed",
    source: String(row.source || ""),
    memoryCount: Number(row.memory_count || 0),
    traceCount: Number(row.trace_count || 0),
    nodeCount: Number(row.node_count || 0),
    edgeCount: Number(row.edge_count || 0),
    latencyMs: Number(row.latency_ms || 0),
    error: row.error ? String(row.error) : undefined,
    createdAt: normalizeDate(row.created_at),
  };
}

function traceSeedFromRow(row: Record<string, unknown>): TraceSeed {
  const profile = objectValue(row.profile) as TraceSeed["profile"];
  const results = Array.isArray(row.results) ? (row.results as TraceSeed["results"]) : [];
  return {
    id: String(row.id),
    query: String(row.query || ""),
    profile,
    results,
    createdAt: normalizeDate(row.created_at || row.createdAt),
  };
}

function buildAdjacency(edges: MemoryGraphEdge[]) {
  const adjacency = new Map<string, Array<{ nodeId: string; edge: MemoryGraphEdge }>>();
  for (const edge of edges) {
    const left = adjacency.get(edge.sourceNodeId) || [];
    left.push({ nodeId: edge.targetNodeId, edge });
    adjacency.set(edge.sourceNodeId, left);

    const right = adjacency.get(edge.targetNodeId) || [];
    right.push({ nodeId: edge.sourceNodeId, edge });
    adjacency.set(edge.targetNodeId, right);
  }
  return adjacency;
}

function componentIds(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const adjacency = buildAdjacency(edges);
  const visited = new Set<string>();
  const components = new Map<string, string>();
  let index = 0;

  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    index += 1;
    const componentId = `community-${index}`;
    const stack = [node.id];
    while (stack.length) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      components.set(current, componentId);
      for (const link of adjacency.get(current) || []) {
        if (!visited.has(link.nodeId)) {
          stack.push(link.nodeId);
        }
      }
    }
  }

  return components;
}

function neighborhoodFor(
  nodeId: string,
  adjacency: Map<string, Array<{ nodeId: string; edge: MemoryGraphEdge }>>,
  byId: Map<string, MemoryGraphNode>,
) {
  return (adjacency.get(nodeId) || [])
    .map((link) => ({
      node: byId.get(link.nodeId),
      relation: link.edge.relation,
      weight: link.edge.weight,
    }))
    .filter((item): item is { node: MemoryGraphNode; relation: MemoryGraphEdgeRelation; weight: number } =>
      Boolean(item.node),
    )
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 6);
}

function boundedPairs(candidates: GraphCandidate[]) {
  const pairs: Array<[GraphCandidate, GraphCandidate]> = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      pairs.push([candidates[left], candidates[right]]);
    }
  }
  return pairs.slice(0, 32);
}

function relationFor(left: GraphCandidate, right: GraphCandidate): MemoryGraphEdgeRelation {
  if (left.kind === "tag" || right.kind === "tag") {
    return "tagged_with";
  }
  if (left.kind === "memory" || right.kind === "memory") {
    return "mentions";
  }
  return "co_occurs";
}

function traceRelationFor(left: GraphCandidate, right: GraphCandidate): MemoryGraphEdgeRelation {
  if (left.kind === "trace" || right.kind === "trace") {
    return "query_about";
  }
  return "retrieved_with";
}

function inferKind(label: string): MemoryGraphNodeKind {
  const slug = slugify(label);
  if (["workflow", "queue", "approval", "cron"].some((term) => slug.includes(term))) {
    return "workflow";
  }
  if (["tool", "connector", "api", "openapi", "mcp"].some((term) => slug.includes(term))) {
    return "tool";
  }
  if (["memory", "rag", "retrieval", "context", "vector", "postgres", "security", "auth"].some((term) => slug.includes(term))) {
    return "system";
  }
  return "concept";
}

function nodeId(slug: string, tenantId: string) {
  const prefix = tenantId === "default" ? "" : `${tenantNamespace(tenantId)}-`;
  return `graph-node-${prefix}${slug}`.slice(0, 240);
}

function edgeId(
  sourceNodeId: string,
  targetNodeId: string,
  relation: MemoryGraphEdgeRelation,
  tenantId: string,
) {
  const digest = createHash("sha256")
    .update(`${tenantId}\0${sourceNodeId}\0${targetNodeId}\0${relation}`)
    .digest("hex")
    .slice(0, 32);
  return tenantId === "default"
    ? `graph-edge-${sourceNodeId.replace(/^graph-node-/, "")}-${relation}-${targetNodeId.replace(/^graph-node-/, "")}`.slice(0, 240)
    : `graph-edge-${tenantNamespace(tenantId)}-${digest}`;
}

function buildRecord(input: Omit<MemoryGraphBuildRecord, "id" | "createdAt">): MemoryGraphBuildRecord {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  };
}

function nodeLabel(nodes: MemoryGraphNode[], nodeIdValue: string) {
  return nodes.find((node) => node.id === nodeIdValue)?.label || "neighbor";
}

function cleanLabel(value: string) {
  const cleaned = value
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) {
    return "";
  }
  if (cleaned.toUpperCase() === cleaned && cleaned.length <= 8) {
    return cleaned;
  }
  return cleaned
    .split(" ")
    .map((part) => {
      const lower = part.toLowerCase();
      if (["api", "rag", "rbac", "hnsw", "mcp", "llm"].includes(lower)) {
        return lower.toUpperCase();
      }
      if (["pgvector"].includes(lower)) {
        return "pgvector";
      }
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((term) => term.replace(/^-|-$/g, ""))
        .filter((term) => term.length > 2 && !stopWords.has(term)),
    ),
  );
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function longer(left: string, right: string) {
  return jsonbSafeTruncate(right.length > left.length ? right : left, 1200);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeKind(value: string): MemoryGraphNodeKind {
  const kinds: MemoryGraphNodeKind[] = ["concept", "tag", "system", "workflow", "tool", "memory", "trace"];
  return kinds.includes(value as MemoryGraphNodeKind) ? (value as MemoryGraphNodeKind) : "concept";
}

function normalizeRelation(value: string): MemoryGraphEdgeRelation {
  const relations: MemoryGraphEdgeRelation[] = [
    "co_occurs",
    "tagged_with",
    "mentions",
    "retrieved_with",
    "query_about",
    "supports",
  ];
  return relations.includes(value as MemoryGraphEdgeRelation) ? (value as MemoryGraphEdgeRelation) : "co_occurs";
}

function sortNodes(left: MemoryGraphNode, right: MemoryGraphNode) {
  return right.weight - left.weight || right.sourceCount - left.sourceCount || right.updatedAt.localeCompare(left.updatedAt);
}

function sortEdges(left: MemoryGraphEdge, right: MemoryGraphEdge) {
  return right.weight - left.weight || right.evidenceCount - left.evidenceCount || right.updatedAt.localeCompare(left.updatedAt);
}

function roundScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function graphTenantId(record: { tenantId?: string }) {
  return storedTenantId(record.tenantId);
}

function storedTenantId(value?: string) {
  return normalizeTenantId(
    value || process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  );
}

function tenantNamespace(tenantId: string) {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

function storageGraphSlug(tenantId: string, slug: string) {
  return tenantId === "default" ? slug : `${tenantNamespace(tenantId)}-${slug}`.slice(0, 120);
}

function logicalGraphSlug(tenantId: string, slug: string) {
  if (tenantId === "default") {
    return slug;
  }
  const prefix = `${tenantNamespace(tenantId)}-`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
}

function getGraphFile() {
  return getDataPath("memory-graph.json");
}
