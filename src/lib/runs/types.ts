import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { GroundingReport } from "@/lib/rag/citations";
import type {
  ModelToolCall,
  ModelToolContinuation,
  ModelToolResult,
  ModelTier,
  ProviderId,
} from "@/lib/models/types";

export type RunStatus =
  | "queued"
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

export type AgentProviderToolContinuation = {
  /** The opaque model state remains bound to the provider that produced it. */
  provider: Exclude<ProviderId, "local">;
  tier: ModelTier;
  model: string;
  prompt: string;
  continuation: ModelToolContinuation;
  pendingCall: ModelToolCall;
  queuedCalls: Array<ModelToolCall & { skipReason?: string }>;
  toolResultsBeforeApproval: ModelToolResult[];
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
  /** Preserves the owner's memory boundary across approval resumes. */
  memoryScope?: "session" | "project" | "all";
  /** Captured, validated source metadata needed to ground the resumed answer. */
  citationSources?: GroundingReport["sources"];
  /** Present for provider-neutral Gemini, Anthropic, Bedrock, and gateway tool turns. */
  providerToolState?: AgentProviderToolContinuation;
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
