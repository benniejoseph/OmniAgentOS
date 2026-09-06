import type { RequestMemoryAccessV1 } from "@/lib/memory/request-access";
import type { GroundingReport } from "@/lib/rag/citations";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { AiUsageCallInput } from "@/lib/usage/types";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AgentMode = "orchestrate" | "research" | "execute" | "learn";

export type AgentToolEvent = {
  type: "tool";
  toolId: string;
  toolName: string;
  status: "running" | "executed" | "dry_run" | "approval_required" | "blocked" | "failed";
  riskLevel?: number;
  dryRun?: boolean;
  summary?: string;
  executionId?: string;
};

export type AgentCouncilEvent = {
  type: "council_member";
  agentId: "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne";
  agentName: string;
  role: string;
  status: "thinking" | "completed" | "failed";
  summary?: string;
  confidence?: number;
  durationMs?: number;
};

export type AgentHarnessEvent = {
  type: "harness";
  version: 1 | 2;
  mode: AgentMode;
  provider: "openai" | "google" | "anthropic" | "aws_bedrock" | "fallback";
  model: string;
  tier: "fast" | "reasoning";
  memoryScope: "session" | "project" | "all";
  contextDecision:
    | "disabled_session"
    | "excluded_by_user"
    | "selected_by_user"
    | "retrieved"
    | "skipped";
  contextMode: string;
  contextCount: number;
  contextTraceId?: string;
  contextEvidenceIds: string[];
  contextRationale: string[];
  liveWeb: boolean;
  toolCount: number;
  toolIds: string[];
  approvalToolCount: number;
  skillIds: string[];
  toolboxSha256: string;
  instructionsSha256: string;
  maxToolSteps: number;
  maxToolCallsPerTurn: number;
  maxToolResultChars: number;
  maxOutputTokens: number;
  approvalPolicy: "always" | "risk_based" | "read_only";
  autonomy: "assist" | "governed" | "execute";
  learningState?: "cold_start" | "observing" | "reinforced" | "supported";
  learningSampleSize?: number;
  learningGuidanceCount?: number;
  learningGuidanceSha256?: string;
};

export type AgentEvent =
  | { type: "run"; runId: string; threadId?: string; missionId?: string }
  | {
      type: "delegated";
      threadId: string;
      workflowId: string;
      missionId?: string;
      acknowledgement: string;
      reason: string;
    }
  | {
      type: "clarification";
      threadId: string;
      message: string;
      reasonCode: "ambiguous_destructive_target" | "ambiguous_known_procedure";
    }
  | { type: "status"; label: string; detail?: string }
  | AgentHarnessEvent
  | { type: "delta"; text: string }
  | { type: "memory"; title: string; count?: number }
  | { type: "model"; model: string; provider?: "openai" | "google" | "anthropic" | "aws_bedrock" | "local"; tier: "fast" | "reasoning"; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs: number; fallbackUsed: boolean; estimatedCostUsd?: number; costKnown?: boolean; iteration?: number; iterationCount?: number; attemptCount?: number; failedAttemptCount?: number; callReceipts?: AiUsageCallInput[]; assignmentId?: string; credentialSource?: "tenant_vault" | "deployment_environment"; providerRequestId?: string; usageReceiptRecorded?: boolean; usageReceiptId?: string }
  | AgentCouncilEvent
  | { type: "council_verdict"; status: "passed" | "revised" | "failed"; score: number; assessment: string; requiredChanges: string[] }
  | AgentToolEvent
  | { type: "waiting_approval"; executionId: string; toolId: string; message: string }
  | { type: "done"; response: string; grounding?: GroundingReport }
  | { type: "canceled"; message: string }
  | { type: "error"; message: string };

export type AgentRunRequest = {
  messages: ChatMessage[];
  /** Trusted server-created attribution; authorization remains in SecurityContext. */
  executionScope?: ExecutionScope;
  /** Server-validated saved-context selection using canonical `kind:id` evidence IDs. */
  contextSelection?: {
    query: string;
    evidenceIds: string[];
  };
  /** Trusted request-bound access for an explicit owner-reviewed selection. */
  promptMemoryAccess?: RequestMemoryAccessV1;
  /** Internal durable dispatch: the worker has already CAS-claimed this run. */
  preclaimedRunId?: string;
  threadId?: string;
  mode?: AgentMode;
  tenantId?: string;
  actorId?: string;
  role?: string;
  agentId?: string;
  specialistIds?: string[];
  learning?: {
    state: "cold_start" | "observing" | "reinforced" | "supported";
    sampleSize: number;
    completionRate: number | null;
    verifiedRate: number | null;
    adjustments: string[];
  };
  agentProfile?: {
    name: string;
    role: string;
    description: string;
    instructions: string;
    modelPolicy: "auto" | "openai_fast" | "openai_reasoning" | "gemini_fast" | "anthropic_fast" | "anthropic_reasoning";
    autonomy: "assist" | "governed" | "execute";
    approvalPolicy: "always" | "risk_based" | "read_only";
    memoryScope: "session" | "project" | "all";
    toolIds: string[];
    skills: Array<{ id: string; name: string; description: string; instructions: string; toolIds: string[] }>;
  };
};
