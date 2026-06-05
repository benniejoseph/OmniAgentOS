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
