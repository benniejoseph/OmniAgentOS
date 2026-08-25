import { getMemory, saveMemory } from "@/lib/memory/store";
import { saveProjectArtifact } from "@/lib/projects/store";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

export async function ensureProjectWorkflowArtifact(input: {
  project: PersonalProject;
  task: ProjectTask;
  run: WorkflowRunRecord;
}) {
  const { project, task, run } = input;
  const evidenceRefs = [
    `project:${project.id}`,
    `project-task:${task.id}`,
    `workflow:${run.id}`,
  ];
  const completed = run.status === "completed";
  const report = completed
    ? String(run.result?.report || "Workflow completed without a persisted report.")
    : String(run.error || `Workflow ${run.status}.`);
  const sourceMemoryId = optionalString(run.result?.memoryId);
  let memoryId: string | undefined;

  if (completed) {
    const sourceMemory = sourceMemoryId
      ? await getMemory(sourceMemoryId, { tenantId: project.tenantId })
      : null;
    const memory = await saveMemory({
      id: `project_outcome_${run.id}`,
      tenantId: project.tenantId,
      type: task.agentId === "mnemosyne" ? "procedure" : task.agentId === "atlas" ? "decision" : "knowledge",
      title: `${project.title}: ${task.title}`,
      content: report,
      tags: ["project-outcome", `project:${project.id}`, `agent:${task.agentId}`, task.agentId],
      scope: "project",
      source: `project-workflow:${run.id}`,
      importance: task.priority === "high" ? 0.86 : task.priority === "low" ? 0.64 : 0.75,
      confidence: 0.9,
      assertedBy: "agent",
      evidenceRefs: sourceMemoryId ? [...evidenceRefs, `memory:${sourceMemoryId}`] : evidenceRefs,
      embedding: sourceMemory?.embedding,
    });
    memoryId = memory.id;
  }

  return saveProjectArtifact({
    id: `project_artifact_${run.id}`,
    tenantId: project.tenantId,
    projectId: project.id,
    taskId: task.id,
    workflowRunId: run.id,
    agentId: task.agentId,
    status: completed ? "verified" : "failed",
    title: task.title,
    content: report,
    memoryId,
    sourceMemoryId,
    evidenceRefs: memoryId ? [...evidenceRefs, `memory:${memoryId}`] : evidenceRefs,
  });
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
