import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { GroundingReport } from "@/lib/rag/citations";

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "resuming"
  | "completed"
  | "failed"
  | "canceled";

export type AgentRunFeedback = {
  verdict: "useful" | "needs_work";
  correction?: string;
  updatedAt: string;
};

export type AgentRunContinuation = {
  /** Full conversation array for ZDR-safe resume (replaces previousResponseId). */
  conversationItems: Array<Record<string, unknown>>;
  instructions: string;
  response: string;
  toolSteps: number;
  outputsBeforeApproval: Array<{ type: "function_call_output"; call_id: string; output: string }>;
  pendingToolCall: {
    callId: string;
    toolId: string;
    toolName: string;
    riskLevel?: number;
    executionId: string;
  };
  context: {
    tenantId: string;
    actorId: string;
    role: "viewer" | "operator" | "admin" | "system";
  };
  toolPolicy?: {
    allowedToolIds: string[];
    readOnly: boolean;
    forceApproval: boolean;
  };
  createdAt: string;
  resumeClaimedAt?: string;
};

export type AgentRunRecord = {
  id: string;
  tenantId?: string;
  threadId?: string;
  mode: AgentMode;
  status: RunStatus;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
  agentId?: string;
  specialistIds?: string[];
  feedback?: AgentRunFeedback;
  memoryContextCount: number;
  consolidationCount?: number;
  response?: string;
  grounding?: GroundingReport;
  error?: string;
  consolidationError?: string;
  continuation?: AgentRunContinuation;
  startedAt: string;
  completedAt?: string;
  consolidatedAt?: string;
};

export type AgentRunEventRecord = {
  id: string;
  tenantId?: string;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type RunLedger = {
  runs: AgentRunRecord[];
  events: AgentRunEventRecord[];
};
