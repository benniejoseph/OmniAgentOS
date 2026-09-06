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

export type RetrievalQueryDomain =
  | "semantic"
  | "temporal"
  | "entity"
  | "relationship"
  | "procedural";

export type RetrievalTemporalMode =
  | "none"
  | "latest"
  | "as_of"
  | "before"
  | "after"
  | "between"
  | "relative"
  | "timeline";

export type RetrievalQueryPlan = {
  version: "p4.3-query-plan:1";
  source: "deterministic" | "model";
  domains: RetrievalQueryDomain[];
  queries: string[];
  entityTerms: string[];
  relationshipTerms: string[];
  proceduralTerms: string[];
  temporal: {
    mode: RetrievalTemporalMode;
    expressions: string[];
  };
  confidence: number;
  validation: {
    originalQueryAnchored: true;
    authorizationInputsExcluded: true;
    candidateAccepted: boolean;
    droppedQueryCount: number;
  };
  fallbackReason?:
    | "not_required"
    | "usage_scope_unavailable"
    | "model_unavailable"
    | "model_failed"
    | "model_usage_unrecorded"
    | "model_output_invalid";
  model?: {
    provider: import("@/lib/models/types").ProviderId;
    model: string;
    usageReceiptRecorded: true;
    usageReceiptId?: string;
  };
};

export type RetrievalProfile = {
  mode: RetrievalMode;
  intent: RetrievalIntent;
  shouldRetrieve: boolean;
  complexity: number;
  queryTerms: string[];
  expandedQueries: string[];
  rationale: string[];
  queryPlan: RetrievalQueryPlan;
  embedding?: import("@/lib/rag/retrieval-embedding").RetrievalEmbeddingReceipt;
  reranker?: import("@/lib/rag/learned-reranker").RetrievalRerankerReceipt;
  contextBudget?: import("@/lib/rag/context-budget").ContextBudgetReceipt;
};

export type ContextEvidenceItem = (
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
      result:
        | import("@/lib/memory/types").MemoryGraphSearchResult
        | import("@/lib/entities/graph-retrieval").GraphRelationshipPath;
    }
) & {
  /** Content-free digest shared by evidence derived from one underlying source. */
  lineageRefSha256?: string;
  /** P4.5 allocation tier applied after authorization and ranking. */
  contextTier?: import("@/lib/rag/context-budget").ContextBudgetTier;
  /** Provider-neutral estimate for the evidence content retained in this pack. */
  tokenEstimate?: number;
  /** True only when the allocator shortened content to honor the hard limit. */
  contentTruncated?: boolean;
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
    lineageRefSha256?: string;
    contextTier?: import("@/lib/rag/context-budget").ContextBudgetTier;
    tokenEstimate?: number;
  }>;
  contextBudget?: import("@/lib/rag/context-budget").ContextBudgetReceipt;
  createdAt: string;
};

export type ContextPack = {
  query: string;
  profile: RetrievalProfile;
  results: ContextEvidenceItem[];
  memoryResults: import("@/lib/memory/types").MemorySearchResult[];
  knowledgeResults: KnowledgeSearchResult[];
  graphResults: import("@/lib/memory/types").MemoryGraphSearchResult[];
  /** Authorized P5.5 paths; every hop retains at least one live evidence item. */
  graphRelationshipPaths?: import("@/lib/entities/graph-retrieval").GraphRelationshipPath[];
  graphRetrievalReceipt?: import("@/lib/entities/graph-retrieval").GraphRetrievalReceipt;
  contextBlock: string;
  budget: import("@/lib/rag/context-budget").ContextBudgetReceipt;
  trace?: RetrievalTraceRecord;
  /** Additive P4.1 comparison; it never changes the active prompt selection. */
  compilerV2Shadow?: import("@/lib/rag/context-compiler-v2").ContextCompilerV2Shadow;
  /** P4.1 canary decision for explicit actor-private context. */
  compilerV2Canary?: import("@/lib/rag/context-compiler-v2").ContextCompilerV2Canary;
};

export type ContextEngineStats = {
  traces: number;
  averageLatencyMs: number;
  averageSelectedCount: number;
  byMode: Record<string, number>;
  latest: RetrievalTraceRecord[];
};
