import type { AgentMode, AgentRunRequest } from "@/lib/orchestration/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export const DURABLE_SPECIALIST_SCOPE_PURPOSE =
  "agent.delegation.read_only" as const;

export type DurableSpecialistAgentId =
  | "atlas"
  | "scout"
  | "forge"
  | "sentinel"
  | "mnemosyne";

export type PreparedDurableSpecialist = {
  agentId: DurableSpecialistAgentId;
  requestId: string;
  delegationId: string;
  runId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  executionScope: ExecutionScope;
};

export type DurableSpecialistJobPayload = {
  actorId: string;
  missionId: string;
  taskId: string;
  runId: string;
  agentId: DurableSpecialistAgentId;
  requestId?: string;
  delegationId?: string;
  executionScope?: ExecutionScope;
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
