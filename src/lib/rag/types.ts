export type KnowledgeSourceType = "text" | "url" | "file" | "api" | "manual";

export type KnowledgeDocument = {
  id: string;
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
  documentId: string;
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
};
