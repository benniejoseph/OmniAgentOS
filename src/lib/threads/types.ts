import type { AgentMode, ChatRole } from "@/lib/orchestration/types";

export type ThreadRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  projectId?: string;
  title: string;
  mode: AgentMode;
  createdAt: string;
  updatedAt: string;
};

export type ThreadTurnRecord = {
  id: string;
  tenantId: string;
  threadId: string;
  role: ChatRole;
  content: string;
  /** Agent-run storage reference; public views also project workflow:<id>. */
  runId?: string;
  /** The actual durable workflow ID, stored separately from the agent-run FK. */
  workflowRunId?: string;
  createdAt: string;
};

export type ThreadLedger = {
  threads: ThreadRecord[];
  turns: ThreadTurnRecord[];
  summaries?: import("@/lib/threads/summaries").ConversationSummaryRecord[];
};
