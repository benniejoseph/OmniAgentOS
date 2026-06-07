import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";

export type RunStatus = "running" | "completed" | "failed";

export type AgentRunRecord = {
  id: string;
  tenantId?: string;
  mode: AgentMode;
  status: RunStatus;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
  memoryContextCount: number;
  consolidationCount?: number;
  response?: string;
  error?: string;
  consolidationError?: string;
  startedAt: string;
  completedAt?: string;
  consolidatedAt?: string;
};

export type AgentRunEventRecord = {
  id: string;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type RunLedger = {
  runs: AgentRunRecord[];
  events: AgentRunEventRecord[];
};
