import type { AgentMode, ChatRole } from "@/lib/orchestration/types";

export type ThreadRecord = {
  id: string;
  tenantId: string;
  actorId: string;
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
  runId?: string;
  createdAt: string;
};

export type ThreadLedger = {
  threads: ThreadRecord[];
  turns: ThreadTurnRecord[];
};
