export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AgentMode = "orchestrate" | "research" | "execute" | "learn";

export type AgentEvent =
  | { type: "status"; label: string; detail?: string }
  | { type: "delta"; text: string }
  | { type: "memory"; title: string; count?: number }
  | { type: "done"; response: string }
  | { type: "error"; message: string };

export type AgentRunRequest = {
  messages: ChatMessage[];
  mode?: AgentMode;
  tenantId?: string;
};
