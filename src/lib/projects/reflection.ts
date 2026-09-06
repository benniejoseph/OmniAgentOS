import { correctMemory, getMemory, saveMemory } from "@/lib/memory/store";
import {
  getProjectArtifact,
  recordProjectArtifactFeedback,
  type ProjectMutationContext,
} from "@/lib/projects/store";
import type { ProjectArtifactVerdict } from "@/lib/projects/types";

export async function reflectOnProjectArtifact(input: {
  artifactId: string;
  projectId: string;
  tenantId?: string;
  actorId: string;
  verdict: ProjectArtifactVerdict;
  lesson: string;
  mutation: ProjectMutationContext;
}) {
  const artifact = await getProjectArtifact(input.artifactId, {
    tenantId: input.tenantId,
    projectId: input.projectId,
  });
  if (!artifact) return undefined;
  const content = [
    `Outcome verdict: ${input.verdict === "useful" ? "useful" : "needs work"}.`,
    `Agent: ${artifact.agentId}.`,
    `Artifact: ${artifact.title}.`,
    `Lesson: ${input.lesson.trim()}`,
  ].join("\n");
  let reflectionMemoryId = artifact.reflectionMemoryId;
  const existing = reflectionMemoryId
    ? await getMemory(reflectionMemoryId, { tenantId: input.tenantId })
    : null;
  if (existing && existing.content !== content) {
    const correction = await correctMemory(existing.id, {
      title: `Reflection: ${artifact.title}`,
      content,
      confidence: 0.98,
    }, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionScope: input.mutation.executionScope,
    });
    reflectionMemoryId = correction?.corrected.id;
  } else if (!existing) {
    const memory = await saveMemory({
      id: `project_reflection_${artifact.id}`,
      tenantId: input.tenantId,
      type: "decision",
      title: `Reflection: ${artifact.title}`,
      content,
      tags: ["project-reflection", `project:${artifact.projectId}`, `agent:${artifact.agentId}`, input.verdict],
      scope: "project",
      source: `feedback:${input.actorId}`,
      importance: input.verdict === "needs_work" ? 0.9 : 0.82,
      confidence: 0.98,
      assertedBy: "user",
      evidenceRefs: [
        `project-artifact:${artifact.id}`,
        `workflow:${artifact.workflowRunId}`,
        ...(artifact.memoryId ? [`memory:${artifact.memoryId}`] : []),
      ],
      executionScope: input.mutation.executionScope,
    });
    reflectionMemoryId = memory.id;
  }
  if (!reflectionMemoryId) throw new Error("Reflection memory could not be persisted.");
  return recordProjectArtifactFeedback(artifact.id, {
    verdict: input.verdict,
    lesson: input.lesson,
    reflectionMemoryId,
  }, {
    tenantId: input.tenantId,
    projectId: input.projectId,
    actorId: input.actorId,
    mutation: input.mutation,
  });
}
