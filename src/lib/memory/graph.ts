import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
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
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type RebuildMemoryGraphOptions = {
  source?: string;
  memoryLimit?: number;
  traceLimit?: number;
};

type SearchMemoryGraphOptions = {
  limit?: number;
  nodeLimit?: number;
};

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

let graphFileWriteQueue: Promise<void> = Promise.resolve();

export async function rebuildMemoryGraph(options: RebuildMemoryGraphOptions = {}) {
  const startedAt = Date.now();
  const source = options.source || "rebuild";

  try {
    const [memories, traces] = await Promise.all([
      listMemories(),
      listTraceSeeds(options.traceLimit || 200),
    ]);
    const selectedMemories = memories.slice(0, Math.min(Math.max(options.memoryLimit || 500, 1), 2000));
    const aggregate = aggregateGraph(selectedMemories, traces);
    const build = buildRecord({
      status: "completed",
      source,
      memoryCount: selectedMemories.length,
      traceCount: traces.length,
      nodeCount: aggregate.nodes.size,
      edgeCount: aggregate.edges.size,
      latencyMs: Date.now() - startedAt,
    });

    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      await getSql()`DELETE FROM omni_memory_graph_edges`;
      await getSql()`DELETE FROM omni_memory_graph_nodes`;
      for (const node of aggregate.nodes.values()) {
        await insertGraphNode(node);
      }
      for (const edge of aggregate.edges.values()) {
        await insertGraphEdge(edge);
      }
      await insertGraphBuild(build);
      return {
        build,
        stats: await getMemoryGraphStats(),
      };
    }

    await writeGraphLedger({
      nodes: [...aggregate.nodes.values()].sort(sortNodes),
      edges: [...aggregate.edges.values()].sort(sortEdges),
      builds: [build, ...(await readGraphLedger()).builds].slice(0, 50),
    });

    return {
      build,
      stats: await getMemoryGraphStats(),
    };
  } catch (error) {
    const build = buildRecord({
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

export async function indexMemoryGraphRecords(records: MemoryRecord[], source = "memory.write") {
  if (!records.length) {
    return getMemoryGraphStats();
  }

  const aggregate = aggregateGraph(records, []);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    for (const node of aggregate.nodes.values()) {
      await upsertGraphNode(node);
    }
    for (const edge of aggregate.edges.values()) {
      await upsertGraphEdge(edge);
    }
    await insertGraphBuild(
      buildRecord({
        status: "completed",
        source,
        memoryCount: records.length,
        traceCount: 0,
        nodeCount: aggregate.nodes.size,
        edgeCount: aggregate.edges.size,
        latencyMs: 0,
      }),
    );
    return getMemoryGraphStats();
  }

  await mutateGraphLedger((ledger) => mergeLedger(ledger, aggregate, source, records.length));
  return getMemoryGraphStats();
}

export async function searchMemoryGraph(
  query: string,
  options: SearchMemoryGraphOptions = {},
): Promise<MemoryGraphSearchResult[]> {
  const limit = Math.min(Math.max(options.limit || 6, 1), 24);
  const [nodes, edges] = await Promise.all([
    listMemoryGraphNodes(options.nodeLimit || 600),
    listMemoryGraphEdges((options.nodeLimit || 600) * 3),
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

export async function listMemoryGraphNodes(limit = 100) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_nodes
      ORDER BY weight DESC, source_count DESC, updated_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 2000)}
    `;
    return rows.map(memoryGraphNodeFromRow);
  }

  return (await readGraphLedger()).nodes.slice(0, limit);
}

export async function listMemoryGraphEdges(limit = 200) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_edges
      ORDER BY weight DESC, evidence_count DESC, updated_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 5000)}
    `;
    return rows.map(memoryGraphEdgeFromRow);
  }

  return (await readGraphLedger()).edges.slice(0, limit);
}

export async function getMemoryGraphStats(): Promise<MemoryGraphStats> {
  const [nodes, edges, latestBuild] = await Promise.all([
    listMemoryGraphNodes(1000),
    listMemoryGraphEdges(3000),
    getLatestGraphBuild(),
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

function aggregateGraph(memories: MemoryRecord[], traces: TraceSeed[]): GraphAggregate {
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
      summary: memory.content.slice(0, 360),
      baseWeight: memory.importance,
    }).slice(0, 14);

    for (const candidate of candidates) {
      mergeNode(aggregate.nodes, nodeFromCandidate(candidate, now, {
        sourceCount: 1,
        memoryIds: [memory.id],
        traceIds: [],
        tags: [...candidate.tags, ...memory.tags],
      }));
    }

    for (const [left, right] of boundedPairs(candidates.slice(0, 8))) {
      mergeEdge(
        aggregate.edges,
        edgeFromCandidates(left, right, relationFor(left, right), now, {
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
      mergeNode(aggregate.nodes, nodeFromCandidate(candidate, now, {
        sourceCount: 1,
        memoryIds: [],
        traceIds: [trace.id],
        tags: candidate.tags,
      }));
    }

    for (const [left, right] of boundedPairs(candidates.slice(0, 7))) {
      mergeEdge(
        aggregate.edges,
        edgeFromCandidates(left, right, traceRelationFor(left, right), now, {
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
  source: {
    sourceCount: number;
    memoryIds: string[];
    traceIds: string[];
    tags: string[];
  },
): MemoryGraphNode {
  return {
    id: nodeId(candidate.slug),
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
  source: {
    weight: number;
    memoryIds: string[];
    traceIds: string[];
  },
): MemoryGraphEdge {
  const [sourceNodeId, targetNodeId] = [nodeId(left.slug), nodeId(right.slug)].sort();
  return {
    id: edgeId(sourceNodeId, targetNodeId, relation),
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

  nodes.set(node.id, {
    ...existing,
    aliases: unique([...existing.aliases, ...node.aliases]),
    summary: longer(existing.summary, node.summary),
    weight: roundScore(Math.max(existing.weight, node.weight)),
    sourceCount: existing.sourceCount + node.sourceCount,
    memoryIds: unique([...existing.memoryIds, ...node.memoryIds]),
    traceIds: unique([...existing.traceIds, ...node.traceIds]),
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

  edges.set(edge.id, {
    ...existing,
    weight: roundScore(Math.max(existing.weight, edge.weight)),
    evidenceCount: existing.evidenceCount + edge.evidenceCount,
    memoryIds: unique([...existing.memoryIds, ...edge.memoryIds]),
    traceIds: unique([...existing.traceIds, ...edge.traceIds]),
    updatedAt: edge.updatedAt,
  });
}

async function listTraceSeeds(limit: number): Promise<TraceSeed[]> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, query, profile, results, created_at
      FROM omni_retrieval_traces
      ORDER BY created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 1000)}
    `;
    return rows.map(traceSeedFromRow);
  }

  const ledger = await readJsonFile<{ traces: TraceSeed[] }>(getDataPath("retrieval-traces.json"), { traces: [] });
  return ledger.traces.slice(0, limit).map(traceSeedFromRow);
}

async function upsertGraphNode(node: MemoryGraphNode) {
  await getSql()`
    INSERT INTO omni_memory_graph_nodes (
      id, kind, label, slug, aliases, summary, weight, source_count,
      memory_ids, trace_ids, tags, metadata, created_at, updated_at
    )
    VALUES (
      ${node.id}, ${node.kind}, ${node.label}, ${node.slug}, ${node.aliases},
      ${node.summary}, ${node.weight}, ${node.sourceCount}, ${node.memoryIds},
      ${node.traceIds}, ${node.tags}, ${JSON.stringify(node.metadata)}::jsonb,
      ${node.createdAt}, ${node.updatedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      aliases = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.aliases || EXCLUDED.aliases)),
      summary = CASE
        WHEN length(EXCLUDED.summary) > length(omni_memory_graph_nodes.summary)
        THEN EXCLUDED.summary
        ELSE omni_memory_graph_nodes.summary
      END,
      weight = GREATEST(omni_memory_graph_nodes.weight, EXCLUDED.weight),
      source_count = omni_memory_graph_nodes.source_count + EXCLUDED.source_count,
      memory_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.memory_ids || EXCLUDED.memory_ids)),
      trace_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.trace_ids || EXCLUDED.trace_ids)),
      tags = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_nodes.tags || EXCLUDED.tags)),
      updated_at = EXCLUDED.updated_at
  `;
}

async function upsertGraphEdge(edge: MemoryGraphEdge) {
  await getSql()`
    INSERT INTO omni_memory_graph_edges (
      id, source_node_id, target_node_id, relation, weight, evidence_count,
      memory_ids, trace_ids, metadata, created_at, updated_at
    )
    VALUES (
      ${edge.id}, ${edge.sourceNodeId}, ${edge.targetNodeId}, ${edge.relation},
      ${edge.weight}, ${edge.evidenceCount}, ${edge.memoryIds}, ${edge.traceIds},
      ${JSON.stringify(edge.metadata)}::jsonb, ${edge.createdAt}, ${edge.updatedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      weight = GREATEST(omni_memory_graph_edges.weight, EXCLUDED.weight),
      evidence_count = omni_memory_graph_edges.evidence_count + EXCLUDED.evidence_count,
      memory_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_edges.memory_ids || EXCLUDED.memory_ids)),
      trace_ids = ARRAY(SELECT DISTINCT unnest(omni_memory_graph_edges.trace_ids || EXCLUDED.trace_ids)),
      updated_at = EXCLUDED.updated_at
  `;
}

async function insertGraphNode(node: MemoryGraphNode) {
  await getSql()`
    INSERT INTO omni_memory_graph_nodes (
      id, kind, label, slug, aliases, summary, weight, source_count,
      memory_ids, trace_ids, tags, metadata, created_at, updated_at
    )
    VALUES (
      ${node.id}, ${node.kind}, ${node.label}, ${node.slug}, ${node.aliases},
      ${node.summary}, ${node.weight}, ${node.sourceCount}, ${node.memoryIds},
      ${node.traceIds}, ${node.tags}, ${JSON.stringify(node.metadata)}::jsonb,
      ${node.createdAt}, ${node.updatedAt}
    )
  `;
}

async function insertGraphEdge(edge: MemoryGraphEdge) {
  await getSql()`
    INSERT INTO omni_memory_graph_edges (
      id, source_node_id, target_node_id, relation, weight, evidence_count,
      memory_ids, trace_ids, metadata, created_at, updated_at
    )
    VALUES (
      ${edge.id}, ${edge.sourceNodeId}, ${edge.targetNodeId}, ${edge.relation},
      ${edge.weight}, ${edge.evidenceCount}, ${edge.memoryIds}, ${edge.traceIds},
      ${JSON.stringify(edge.metadata)}::jsonb, ${edge.createdAt}, ${edge.updatedAt}
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

async function insertGraphBuild(build: MemoryGraphBuildRecord) {
  await getSql()`
    INSERT INTO omni_memory_graph_builds (
      id, status, source, memory_count, trace_count, node_count, edge_count,
      latency_ms, error, created_at
    )
    VALUES (
      ${build.id}, ${build.status}, ${build.source}, ${build.memoryCount},
      ${build.traceCount}, ${build.nodeCount}, ${build.edgeCount},
      ${build.latencyMs}, ${build.error || null}, ${build.createdAt}
    )
  `;
}

async function getLatestGraphBuild() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_memory_graph_builds
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? memoryGraphBuildFromRow(rows[0]) : undefined;
  }

  return (await readGraphLedger()).builds[0];
}

function mergeLedger(
  ledger: MemoryGraphLedger,
  aggregate: GraphAggregate,
  source: string,
  memoryCount: number,
): MemoryGraphLedger {
  const nodes = new Map(ledger.nodes.map((node) => [node.id, node]));
  const edges = new Map(ledger.edges.map((edge) => [edge.id, edge]));
  for (const node of aggregate.nodes.values()) {
    mergeNode(nodes, node);
  }
  for (const edge of aggregate.edges.values()) {
    mergeEdge(edges, edge);
  }

  return {
    nodes: [...nodes.values()].sort(sortNodes).slice(0, 2000),
    edges: [...edges.values()].sort(sortEdges).slice(0, 5000),
    builds: [
      buildRecord({
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
  graphFileWriteQueue = graphFileWriteQueue.then(
    async () => {
      await writeGraphLedger(mutator(await readGraphLedger()));
    },
    async () => {
      await writeGraphLedger(mutator(await readGraphLedger()));
    },
  );
  await graphFileWriteQueue;
}

async function writeGraphLedger(ledger: MemoryGraphLedger) {
  await writeJsonFile(getGraphFile(), {
    nodes: ledger.nodes.slice(0, 2000),
    edges: ledger.edges.slice(0, 5000),
    builds: ledger.builds.slice(0, 50),
  });
}

function memoryGraphNodeFromRow(row: Record<string, unknown>): MemoryGraphNode {
  return {
    id: String(row.id),
    kind: normalizeKind(String(row.kind || "concept")),
    label: String(row.label || ""),
    slug: String(row.slug || ""),
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

function nodeId(slug: string) {
  return `graph-node-${slug}`;
}

function edgeId(sourceNodeId: string, targetNodeId: string, relation: MemoryGraphEdgeRelation) {
  return `graph-edge-${sourceNodeId.replace(/^graph-node-/, "")}-${relation}-${targetNodeId.replace(/^graph-node-/, "")}`.slice(0, 240);
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
  return right.length > left.length ? right.slice(0, 1200) : left.slice(0, 1200);
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

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
}

function getGraphFile() {
  return getDataPath("memory-graph.json");
}
