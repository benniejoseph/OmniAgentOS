export type MemoryType =
  | "preference"
  | "fact"
  | "episode"
  | "procedure"
  | "knowledge"
  | "decision"
  | "task";

export type MemoryRecord = {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  scope: "user" | "workspace" | "project";
  source: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
};

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
  reasons: string[];
};

export type MemoryGraphNodeKind = "concept" | "tag" | "system" | "workflow" | "tool" | "memory" | "trace";

export type MemoryGraphEdgeRelation =
  | "co_occurs"
  | "tagged_with"
  | "mentions"
  | "retrieved_with"
  | "query_about"
  | "supports";

export type MemoryGraphNode = {
  id: string;
  kind: MemoryGraphNodeKind;
  label: string;
  slug: string;
  aliases: string[];
  summary: string;
  weight: number;
  sourceCount: number;
  memoryIds: string[];
  traceIds: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryGraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: MemoryGraphEdgeRelation;
  weight: number;
  evidenceCount: number;
  memoryIds: string[];
  traceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryGraphBuildRecord = {
  id: string;
  status: "completed" | "failed";
  source: string;
  memoryCount: number;
  traceCount: number;
  nodeCount: number;
  edgeCount: number;
  latencyMs: number;
  error?: string;
  createdAt: string;
};

export type MemoryGraphSearchResult = {
  node: MemoryGraphNode;
  score: number;
  communityId: string;
  neighborhood: Array<{
    node: MemoryGraphNode;
    relation: MemoryGraphEdgeRelation;
    weight: number;
  }>;
  reasons: string[];
};

export type MemoryGraphStats = {
  nodes: number;
  edges: number;
  communities: number;
  averageDegree: number;
  latestBuild?: MemoryGraphBuildRecord;
  topNodes: MemoryGraphNode[];
};
