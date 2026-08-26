import type { GroundingReport } from "@/lib/rag/citations";

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
  | { type: "status"; label: string; detail?: string }
  | { type: "delta"; text: string }
  | { type: "memory"; title: string; count?: number }
  | { type: "model"; model: string; provider?: "openai" | "google"; tier: "fast" | "reasoning"; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs: number; fallbackUsed: boolean; estimatedCostUsd?: number }
  | AgentCouncilEvent
  | { type: "council_verdict"; status: "passed" | "revised" | "failed"; score: number; assessment: string; requiredChanges: string[] }
  | AgentToolEvent
  | { type: "waiting_approval"; executionId: string; toolId: string; message: string }
  | { type: "done"; response: string; grounding?: GroundingReport }
  | { type: "canceled"; message: string }
  | { type: "error"; message: string };

export type AgentRunRequest = {
  messages: ChatMessage[];
  threadId?: string;
  mode?: AgentMode;
  tenantId?: string;
  actorId?: string;
  role?: string;
  agentId?: string;
  specialistIds?: string[];
  agentProfile?: {
    name: string;
    role: string;
    description: string;
    instructions: string;
    modelPolicy: "auto" | "openai_fast" | "openai_reasoning" | "gemini_fast";
    autonomy: "assist" | "governed" | "execute";
    approvalPolicy: "always" | "risk_based" | "read_only";
    memoryScope: "session" | "project" | "all";
    toolIds: string[];
    skills: Array<{ id: string; name: string; description: string; instructions: string; toolIds: string[] }>;
  };
};
