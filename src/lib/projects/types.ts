import type { SupervisorAgentId } from "@/lib/orchestration/supervisor";
import type { WorkflowRunStatus } from "@/lib/workflows/types";

export type ProjectStatus = "draft" | "active" | "completed" | "archived";
export type ProjectTaskStatus = "open" | "doing" | "done";
export type ProjectTaskPriority = "low" | "medium" | "high";
export type ProjectAutonomyMode = "manual" | "supervised" | "autonomous";
export type ProjectExecutionStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_approval"
  | "completed"
  | "failed";
export type ProjectTaskWorkflowStatus = WorkflowRunStatus | "dispatching";
export type ProjectArtifactStatus = "verified" | "failed";
export type ProjectArtifactVerdict = "useful" | "needs_work";

export type PersonalProject = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  objective: string;
  status: ProjectStatus;
  autonomyMode: ProjectAutonomyMode;
  executionStatus: ProjectExecutionStatus;
  taskBudget: number;
  tasksDispatched: number;
  maxParallelTasks: number;
  requireApproval: boolean;
  lastSyncedAt?: string;
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ProjectSummary = PersonalProject & {
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  artifactCount: number;
};

export type ProjectTask = {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  detail: string;
  status: ProjectTaskStatus;
  priority: ProjectTaskPriority;
  agentId: SupervisorAgentId;
  position: number;
  origin: "manual" | "agent";
  dueAt?: string;
  dependsOn: string[];
  workflowRunId?: string;
  workflowStatus?: ProjectTaskWorkflowStatus;
  executionError?: string;
  dispatchedAt?: string;
  dispatchAttempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ProjectArtifact = {
  id: string;
  tenantId: string;
  projectId: string;
  taskId: string;
  workflowRunId: string;
  agentId: SupervisorAgentId;
  status: ProjectArtifactStatus;
  title: string;
  content: string;
  memoryId?: string;
  sourceMemoryId?: string;
  verdict?: ProjectArtifactVerdict;
  lesson?: string;
  reflectionMemoryId?: string;
  reviewedAt?: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectLedger = {
  projects: PersonalProject[];
  tasks: ProjectTask[];
  artifacts: ProjectArtifact[];
};
