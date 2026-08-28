export type MissionPriority = "low" | "normal" | "high" | "urgent";

export type MissionStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "archived";

export type MissionTaskStatus =
  | "triage"
  | "pending"
  | "running"
  | "blocked"
  | "review"
  | "succeeded"
  | "failed"
  | "canceled";

export type MissionTaskBlockerKind =
  | "dependency"
  | "needs_input"
  | "capability"
  | "transient";

export type MissionTaskBoardMetadata = {
  assigneeKey?: string;
  assigneeName?: string;
  skillIds?: string[];
  scheduledAt?: string;
  blocker?: {
    kind: MissionTaskBlockerKind;
    reason: string;
  };
  reviewRequired?: boolean;
  reviewerKey?: string;
  reviewerName?: string;
  reviewRequestedAt?: string;
  reviewSummary?: string;
  changesRequestedReason?: string;
};

export type MissionAttemptStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled";

export type Mission = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  source: string;
  sourceKey: string;
  metadata: Record<string, unknown>;
  startedAt?: string;
  terminalAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MissionTask = {
  id: string;
  tenantId: string;
  actorId: string;
  missionId: string;
  parentTaskId?: string;
  title: string;
  instructions: string;
  definitionOfDone: string;
  status: MissionTaskStatus;
  priority: MissionPriority;
  position: number;
  sourceKey: string;
  dependencyIds: string[];
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  startedAt?: string;
  terminalAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MissionAttempt = {
  id: string;
  tenantId: string;
  actorId: string;
  missionId: string;
  taskId: string;
  executorKey: string;
  executorType: string;
  executorId: string;
  fenceToken: string;
  status: MissionAttemptStatus;
  agentRunId?: string;
  workflowRunId?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  terminalAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MissionArtifact = {
  id: string;
  tenantId: string;
  actorId: string;
  missionId: string;
  taskId?: string;
  attemptId?: string;
  sourceKey: string;
  kind: string;
  title: string;
  uri?: string;
  mimeType?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MissionDetail = {
  mission: Mission;
  tasks: MissionTask[];
  attempts: MissionAttempt[];
  artifacts: MissionArtifact[];
};

export type MissionLedger = {
  missions: Mission[];
  tasks: MissionTask[];
  attempts: MissionAttempt[];
  artifacts: MissionArtifact[];
};
