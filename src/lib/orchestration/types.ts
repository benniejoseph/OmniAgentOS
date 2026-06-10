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

export type AgentEvent =
  | { type: "status"; label: string; detail?: string }
  | { type: "delta"; text: string }
  | { type: "memory"; title: string; count?: number }
  | AgentToolEvent
  | { type: "done"; response: string }
  | { type: "error"; message: string };

export type AgentRunRequest = {
  messages: ChatMessage[];
  mode?: AgentMode;
  tenantId?: string;
  actorId?: string;
  role?: string;
};
