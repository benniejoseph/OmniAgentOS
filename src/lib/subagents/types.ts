import type { AgentMode, AgentRunRequest } from "@/lib/orchestration/types";

export type DurableSpecialistAgentId =
  | "atlas"
  | "scout"
  | "forge"
  | "sentinel"
  | "mnemosyne";

export type PreparedDurableSpecialist = {
  agentId: DurableSpecialistAgentId;
  runId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
};

export type DurableSpecialistJobPayload = {
  actorId: string;
  missionId: string;
  taskId: string;
  runId: string;
  agentId: DurableSpecialistAgentId;
  ready: boolean;
  preparedAt: string;
  workflowRunId?: string;
};

export type DurableSpecialistProfile = NonNullable<
  AgentRunRequest["agentProfile"]
> & {
  mode: AgentMode;
};

export type SpecialistDependencyGate =
  | { state: "ready"; taskIds: string[] }
  | { state: "pending"; taskIds: string[]; pendingTaskIds: string[] }
  | { state: "failed"; taskIds: string[]; failedTaskIds: string[]; reason: string };
