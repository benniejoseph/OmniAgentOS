export type KnowledgeSourceType = "text" | "url" | "file" | "api" | "manual";

export type KnowledgeDocument = {
  id: string;
  tenantId?: string;
  /** Present only for documents enrolled in canonical source lineage. */
  sourceItemId?: string;
  /** Present only for documents enrolled in canonical source lineage. */
  sourceRevisionId?: string;
  title: string;
  source: string;
  sourceType: KnowledgeSourceType;
  tags: string[];
  contentHash: string;
  chunkCount: number;
  totalCharacters: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeChunk = {
  id: string;
  tenantId?: string;
  documentId: string;
  /** Present only for chunks enrolled in canonical source lineage. */
  sourceRevisionId?: string;
  /** Exact canonical evidence unit for this chunk. */
  evidenceUnitId?: string;
  chunkIndex: number;
  title: string;
  content: string;
  tags: string[];
  source: string;
  tokenEstimate: number;
  characterCount: number;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSearchResult = {
  chunk: KnowledgeChunk;
  document?: KnowledgeDocument;
  score: number;
  vectorScore: number;
  lexicalScore: number;
  recencyScore: number;
  reasons: string[];
};

export type KnowledgeLedger = {
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
  sourceLineage?: import("@/lib/sources/store").CanonicalSourceLedger;
};

export type RetrievalMode = "direct" | "memory_first" | "local" | "global" | "hybrid";
export type RetrievalIntent = "casual" | "personal" | "factual" | "procedural" | "operational" | "global_synthesis";

export type RetrievalProfile = {
  mode: RetrievalMode;
  intent: RetrievalIntent;
  shouldRetrieve: boolean;
  complexity: number;
  queryTerms: string[];
  expandedQueries: string[];
  rationale: string[];
};

export type ContextEvidenceItem =
  | {
      id: string;
      kind: "memory";
      sourceKey: string;
      title: string;
      content: string;
      score: number;
      utilityScore: number;
      supportScore: number;
      diversityScore: number;
      freshnessScore: number;
      confidence: number;
      reasons: string[];
      result: import("@/lib/memory/types").MemorySearchResult;
    }
  | {
      id: string;
      kind: "knowledge";
      sourceKey: string;
      title: string;
      content: string;
      score: number;
      utilityScore: number;
      supportScore: number;
      diversityScore: number;
      freshnessScore: number;
      confidence: number;
      reasons: string[];
      result: KnowledgeSearchResult;
    }
  | {
      id: string;
      kind: "graph";
      sourceKey: string;
      title: string;
      content: string;
      score: number;
      utilityScore: number;
      supportScore: number;
      diversityScore: number;
      freshnessScore: number;
      confidence: number;
      reasons: string[];
      result: import("@/lib/memory/types").MemoryGraphSearchResult;
    };

export type RetrievalTraceRecord = {
  id: string;
  tenantId?: string;
  /** Present only for actor-scoped private retrieval traces. */
  accessBinding?: import("@/lib/memory/access-binding").MemoryAccessBindingV1;
  query: string;
  profile: RetrievalProfile;
  resultCount: number;
  selectedCount: number;
  latencyMs: number;
  results: Array<{
    id: string;
    kind: ContextEvidenceItem["kind"];
    sourceKey: string;
    title: string;
    score: number;
    utilityScore: number;
    confidence: number;
    reasons: string[];
  }>;
  createdAt: string;
};

export type ContextPack = {
  query: string;
  profile: RetrievalProfile;
  results: ContextEvidenceItem[];
  memoryResults: import("@/lib/memory/types").MemorySearchResult[];
  knowledgeResults: KnowledgeSearchResult[];
  graphResults: import("@/lib/memory/types").MemoryGraphSearchResult[];
  contextBlock: string;
  trace?: RetrievalTraceRecord;
};

export type ContextEngineStats = {
  traces: number;
  averageLatencyMs: number;
  averageSelectedCount: number;
  byMode: Record<string, number>;
  latest: RetrievalTraceRecord[];
};
