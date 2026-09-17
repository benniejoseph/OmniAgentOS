import type { RequestMemoryAccessV1 } from "@/lib/memory/request-access";
import type { RequestPersonalContextMemoryAccessV1 } from "@/lib/memory/personal-context-access";
import type { RequestSharedMemoryAccessV1 } from "@/lib/memory/shared-context";
import type { RequestEntityAccessV1 } from "@/lib/entities/request-access";
import type { GroundingReport } from "@/lib/rag/citations";
import type { ContextSelectionLockBinding } from "@/lib/rag/context-selection-lock";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import type { ResolvedAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import type { AgentPersonaV1 } from "@/lib/agents/persona";
import type { ContextScopeId } from "@/lib/rag/context-scope";
import type { AiUsageCallInput } from "@/lib/usage/types";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AgentMode = "orchestrate" | "research" | "execute" | "learn";
/** Active Computer Use surfaces. Local control is always owner-selected. */
export type ComputerUseTarget = "local_macos";
/**
 * Persisted runs can outlive a release. Keep the retired value readable so a
 * legacy continuation can be terminated explicitly instead of being dropped
 * or, more dangerously, reinterpreted as authority over the local Mac.
 */
export type PersistedComputerUseTarget =
  | ComputerUseTarget
  | "isolated_browser";

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
  taskId?: string;
  delegationId?: string;
  lifecycleState?:
    | "proposed"
    | "accepted"
    | "working"
    | "waiting"
    | "challenged"
    | "completed_proposed"
    | "result_accepted"
    | "rejected"
    | "canceled"
    | "expired";
  lifecycleRevision?: number;
};

export type AgentHarnessEvent = {
  type: "harness";
  version: 1 | 2;
  conversationSchemaVersion?: 1;
  conversationRolesPreserved?: boolean;
  observationsStructured?: boolean;
  mode: AgentMode;
  provider: "openai" | "google" | "anthropic" | "aws_bedrock" | "fallback";
  model: string;
  tier: "fast" | "reasoning";
  memoryScope: "session" | "project" | "all";
  contextScope?: ContextScopeId;
  contextDecision:
    | "disabled_session"
    | "disabled_project_unavailable"
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
  budgetLimits: RunBudgetCountersV1;
  approvalPolicy: "always" | "risk_based" | "read_only";
  autonomy: "assist" | "governed" | "execute";
  /** Legacy P7.5-and-earlier receipt fields retained for replay. */
  learningState?: "cold_start" | "observing" | "reinforced" | "supported";
  learningSampleSize?: number;
  learningGuidanceCount?: number;
  learningGuidanceSha256?: string;
  adaptationState?: "baseline" | "evidence_ready" | "active";
  adaptationEvidenceCount?: number;
  adaptationConfidence?: number;
  adaptationActivationVersions?: number[];
  adaptationGuidanceSha256?: string;
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
      runId?: string;
      message: string;
      reasonCode:
        | "ambiguous_destructive_target"
        | "ambiguous_known_procedure"
        | "ambiguous_read_target";
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
  | {
      type: "budget_exhausted";
      dimension: string;
      limit: number;
      attempted: number;
      requiresAuthorization: true;
      message: string;
    }
  | {
      type: "execution_target_retired";
      code: "computer_use_target_retired";
      target: "isolated_browser";
      message: string;
    }
  | { type: "done"; response: string; grounding?: GroundingReport }
  | { type: "canceled"; message: string }
  | { type: "error"; message: string };

export type AgentRunRequest = {
  messages: ChatMessage[];
  /** Explicit owner-selected execution surface. Never inferred or silently changed. */
  computerUseTarget?: ComputerUseTarget;
  /**
   * Live authenticated request identity for owner-scoped governed tools.
   * This value is never persisted in a continuation; approval resumes under
   * the approving request's freshly authorized context.
   */
  securityContext?: SecurityContext;
  /**
   * Descriptive semantic discovery hints produced before the run. These are
   * never capability grants or allowlists; the toolbox still resolves active,
   * tenant-scoped tools through the governed catalog.
   */
  semanticRouting?: {
    capabilitySearchQuery: string;
    matchedCapabilityIds: readonly string[];
    policyVersion: string;
  };
  /** Trusted server-created attribution; authorization remains in SecurityContext. */
  executionScope?: ExecutionScope;
  /** Exact immutable behavior and authority versions selected before execution. */
  agentIdentity?: ResolvedAgentIdentityV1;
  /** Server-validated saved-context selection using canonical `kind:id` evidence IDs. */
  contextSelection?: ContextSelectionLockBinding;
  /** User-reviewed P4.2 context boundary for this direct run. */
  contextScope?: ContextScopeId;
  /** Trusted request-bound access for an explicit owner-reviewed selection. */
  promptMemoryAccess?: RequestMemoryAccessV1;
  /** Exact membership authority for explicitly selected project/workspace context. */
  promptSharedMemoryAccess?: RequestSharedMemoryAccessV1;
  /** Owner-controlled standing authority for automatic personal context. */
  promptPersonalMemoryAccess?: RequestPersonalContextMemoryAccessV1;
  /** Exact user-principal authority for a reviewed temporal graph path. */
  promptEntityGraphAccess?: RequestEntityAccessV1;
  /** Server-validated effective limits; delegated callers may only narrow them. */
  budgetLimits?: RunBudgetCountersV1;
  /** Trusted server-selected tool/model round cap for the chosen execution surface. */
  maxToolSteps?: number;
  /** Internal durable dispatch: the worker has already CAS-claimed this run. */
  preclaimedRunId?: string;
  /**
   * Content-free metadata for a visibly reviewed realtime voice command.
   * Its presence only narrows authority by forcing risk-bearing approvals.
   */
  voiceInput?: {
    schemaVersion: 1;
    source: "realtime_voice";
    sessionId: string;
    conversationId: string;
    provider: "openai";
    confidenceBand: "high" | "low" | "unavailable" | "edited";
    confidenceMean?: number;
    confidenceMinimum?: number;
    confidenceSampleCount: number;
    reviewMethod: "send_button" | "explicit_checkbox";
    reviewAttested: true;
  };
  threadId?: string;
  mode?: AgentMode;
  tenantId?: string;
  actorId?: string;
  role?: string;
  agentId?: string;
  specialistIds?: string[];
  adaptationEvidence?: {
    state: "baseline" | "evidence_ready";
    sampleSize: number;
    completionRate: number | null;
    verifiedRate: number | null;
    confidence: number;
  };
  agentProfile?: {
    name: string;
    role: string;
    description: string;
    instructions: string;
    persona: AgentPersonaV1;
    modelPolicy: "auto" | "openai_fast" | "openai_reasoning" | "gemini_fast" | "anthropic_fast" | "anthropic_reasoning";
    autonomy: "assist" | "governed" | "execute";
    approvalPolicy: "always" | "risk_based" | "read_only";
    memoryScope: "session" | "project" | "all";
    toolIds: string[];
    skills: Array<{ id: string; name: string; description: string; instructions: string; toolIds: string[] }>;
  };
};
