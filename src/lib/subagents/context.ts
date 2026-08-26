import {
  getMissionTask,
  listMissionArtifacts,
} from "@/lib/missions/store";
import type { SpecialistDependencyGate } from "@/lib/subagents/types";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

const MAX_SPECIALIST_CONTEXT_CHARS = 12_000;
const MAX_SPECIALIST_RESULT_CHARS = 6_000;

export async function inspectWorkflowSpecialistDependencies(
  detail: WorkflowRunDetail,
): Promise<SpecialistDependencyGate> {
  const metadata = detail.run.input.metadata;
  const taskIds = specialistTaskIds(metadata);
  if (!taskIds.length) return { state: "ready", taskIds };
  const actorId = metadataText(metadata, "actorId");
  if (!actorId) {
    return {
      state: "failed",
      taskIds,
      failedTaskIds: taskIds,
      reason: "Durable specialist dependencies are missing their actor scope.",
    };
  }
  const owner = { tenantId: detail.run.tenantId, actorId };
  const tasks = await Promise.all(
    taskIds.map((taskId) => getMissionTask(taskId, owner)),
  );
  const missing = taskIds.filter((_, index) => !tasks[index]);
  const failed = tasks
    .filter((task) => task && ["failed", "canceled"].includes(task.status))
    .map((task) => task!.id);
  if (missing.length || failed.length) {
    const failedTaskIds = [...missing, ...failed];
    return {
      state: "failed",
      taskIds,
      failedTaskIds,
      reason: `Durable specialist dependencies failed or disappeared: ${failedTaskIds.join(", ")}.`,
    };
  }
  const pendingTaskIds = tasks
    .filter((task) => task?.status !== "succeeded")
    .map((task) => task!.id);
  return pendingTaskIds.length
    ? { state: "pending", taskIds, pendingTaskIds }
    : { state: "ready", taskIds };
}

export async function buildWorkflowSpecialistContext(
  detail: WorkflowRunDetail,
) {
  const metadata = detail.run.input.metadata;
  const taskIds = specialistTaskIds(metadata);
  const actorId = metadataText(metadata, "actorId");
  const missionId = metadataText(metadata, "missionId");
  if (!taskIds.length || !actorId || !missionId) {
    return { count: 0, contextBlock: "", evidence: [] as SpecialistEvidence[] };
  }
  const artifacts = await listMissionArtifacts(
    missionId,
    { tenantId: detail.run.tenantId, actorId },
    50,
  );
  const relevant = artifacts.filter(
    (artifact) =>
      artifact.taskId &&
      taskIds.includes(artifact.taskId) &&
      artifact.kind === "specialist_result",
  );
  const evidence: SpecialistEvidence[] = [];
  const sections: string[] = [];
  let remaining = MAX_SPECIALIST_CONTEXT_CHARS;
  for (const artifact of relevant) {
    if (remaining <= 0) break;
    const response = typeof artifact.data.response === "string"
      ? artifact.data.response.slice(0, MAX_SPECIALIST_RESULT_CHARS)
      : "";
    if (!response) continue;
    const section = [
      `Specialist: ${String(artifact.data.agentId || artifact.title)}`,
      response,
    ].join("\n").slice(0, remaining);
    sections.push(section);
    remaining -= section.length;
    evidence.push({
      id: artifact.id,
      kind: "durable_specialist",
      title: artifact.title,
      confidence: 1,
      utilityScore: 1,
    });
  }
  return {
    count: evidence.length,
    contextBlock: sections.length
      ? `<untrusted_specialist_context provenance="durable_read_only_subagents">\n${sections.join("\n\n---\n\n")}\n</untrusted_specialist_context>`
      : "",
    evidence,
  };
}

type SpecialistEvidence = {
  id: string;
  kind: "durable_specialist";
  title: string;
  confidence: number;
  utilityScore: number;
};

function specialistTaskIds(metadata?: Record<string, unknown>) {
  const value = metadata?.specialistTaskIds;
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, 4)
    : [];
}

function metadataText(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}
