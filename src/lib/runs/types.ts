import type {
  AgentMode,
  ChatMessage,
  PersistedComputerUseTarget,
} from "@/lib/orchestration/types";
import type { GroundingReport } from "@/lib/rag/citations";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type {
  RunContractEnvelopeV1,
  TerminalReceiptV1,
} from "@/lib/runs/contracts";
import type { ApprovalCheckpointShadowEnrollment } from "@/lib/runs/approval-checkpoint-shadow";
import type { RunBudgetStateV1 } from "@/lib/runs/budgets";
import type {
  ModelToolCall,
  ModelToolContinuation,
  ModelToolResult,
  ModelTier,
  ProviderId,
} from "@/lib/models/types";
import type { ModelConversationItem } from "@/lib/models/conversation";
import type { CommandModelSelectionRequest } from "@/lib/models/command-selection";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_clarification"
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
  /**
   * Server-selected execution surface retained across governed approvals.
   * The legacy isolated value is parse-only and must terminate as retired.
   */
  computerUseTarget?: PersistedComputerUseTarget;
  /** Canonical root attribution retained across approval pauses. */
  executionScope?: ExecutionScope;
  /** P0.2 shadow snapshot retained only while an approval-paused run resumes. */
  runContractEnvelope?: RunContractEnvelopeV1;
  /** New-run-only P1.6 rollout pin. The pin alone grants no resume authority. */
  checkpointShadowEnrollment?: ApprovalCheckpointShadowEnrollment;
  /** Complete budget counters survive governed approval pauses. */
  budgetState?: RunBudgetStateV1;
  /** Metadata-only checkpoint fence; the raw claim token is never persisted. */
  checkpointResumeClaim?: {
    schemaVersion: 1;
    checkpointId: string;
    checkpointSha256: string;
    operationJobId: string;
    leaseGeneration: number;
  };
  /** Exact Settings-constrained per-command model choice retained across approvals. */
  commandModelSelection?: CommandModelSelectionRequest;
  /** Full conversation array for ZDR-safe resume (replaces previousResponseId). */
  conversationItems: Array<Record<string, unknown>>;
  /** Provider-neutral replay form for every newly persisted continuation. */
  canonicalConversation?: ModelConversationItem[];
  instructions: string;
  response: string;
  toolSteps: number;
  /** Exact server-selected cap retained across governed approval pauses. */
  maxToolSteps?: number;
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
    authUserBinding?: {
      version: 1;
      source: "session" | "mobile";
      authUserId: string;
      email: string;
      canonicalActorId: string;
    };
  };
  toolPolicy?: {
    allowedToolIds: string[];
    readOnly: boolean;
    forceApproval: boolean;
    /** Force approval only when tool risk is greater than this threshold. */
    forceApprovalAboveRisk?: number;
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
  ownerActorId: string;
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
  /** Exact metadata-only outcome receipt; absent on legacy runs. */
  terminalReceipt?: TerminalReceiptV1;
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
