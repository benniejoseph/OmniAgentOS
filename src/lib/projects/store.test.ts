import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentPerformance } from "@/lib/agents/performance";
import { getAgentLearningGuidance } from "@/lib/agents/learning";
import { decomposeProject } from "@/lib/projects/planner";
import { syncProjectExecution } from "@/lib/projects/execution";
import { reflectOnProjectArtifact } from "@/lib/projects/reflection";
import { getMemory } from "@/lib/memory/store";
import {
  createProject,
  createProjectTasks,
  getOwnedProject,
  getProject,
  listProjectArtifacts,
  listProjectSummaries,
  listProjectTasks,
  listProjects,
  ProjectTransitionError,
  updateProject,
  updateProjectExecution,
  updateProjectTask,
} from "@/lib/projects/store";
import { transitionWorkflowRun } from "@/lib/workflows/store";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("personal projects", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "omni-projects-"));
  });

  it("enforces project and task lifecycle transitions", async () => {
    const project = await createProject({
      tenantId: "personal", actorId: "owner", title: "Build a second brain",
      objective: "A reliable daily system is in active use.", status: "draft",
    });
    await expect(updateProject(project.id, { status: "completed" }, { tenantId: "personal", actorId: "owner" }))
      .rejects.toBeInstanceOf(ProjectTransitionError);
    await expect(updateProject(project.id, { status: "active" }, { tenantId: "personal", actorId: "owner" }))
      .resolves.toMatchObject({ status: "active" });

    const [task] = await createProjectTasks(project.id, [{ title: "Define the workflow" }], { tenantId: "personal" });
    await expect(updateProjectTask(project.id, task.id, { status: "doing" }, { tenantId: "personal", actorId: "owner" }))
      .resolves.toMatchObject({ status: "doing" });
    await expect(updateProjectTask(project.id, task.id, { status: "done" }, { tenantId: "personal", actorId: "owner" }))
      .resolves.toMatchObject({ status: "done", completedAt: expect.any(String) });
    await expect(updateProjectTask(project.id, task.id, { status: "doing" }, { tenantId: "personal", actorId: "owner" }))
      .rejects.toBeInstanceOf(ProjectTransitionError);
  });

  it("keeps projects private to their owner", async () => {
    const project = await createProject({ tenantId: "personal", actorId: "owner", title: "Private goal", objective: "Only the owner can see this." });
    await expect(getProject(project.id, { tenantId: "personal", actorId: "someone-else" })).resolves.toBeUndefined();
    await expect(listProjects(10, { tenantId: "personal", actorId: "someone-else" })).resolves.toEqual([]);
  });

  it("persists an exact scoped creation event and replays one request idempotently", async () => {
    const executionScope = createExecutionScope({
      tenantId: "project-events",
      initiatingActorId: "owner",
      executingPrincipalType: "user",
      executingPrincipalId: "owner",
      correlationId: "request-project-create",
      purpose: "project.create",
    });
    const input = {
      tenantId: "project-events",
      actorId: "owner",
      title: "Private launch",
      objective: "Ship without leaking private project content into events.",
      mutation: {
        executionScope,
        idempotencyKey: "project-create-1",
      },
    } as const;

    const first = await createProject(input);
    const replay = await createProject(input);
    expect(replay.id).toBe(first.id);

    const events = await listStreamEvents(`project:${first.id}`, {
      tenantId: "project-events",
      actorId: "owner",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "project.created",
      correlationId: "request-project-create",
      payload: {
        schemaVersion: 1,
        projectId: first.id,
        taskId: null,
        operation: "project_created",
        status: "active",
        priorStatus: null,
      },
    });
    expect(JSON.stringify(events[0].payload)).not.toContain(input.title);
    expect(JSON.stringify(events[0].payload)).not.toContain(input.objective);

    const updateScope = createExecutionScope({
      tenantId: "project-events",
      initiatingActorId: "owner",
      executingPrincipalType: "user",
      executingPrincipalId: "owner",
      projectId: first.id,
      correlationId: "request-project-update",
      purpose: "project.update",
    });
    await updateProject(first.id, { title: "Renamed private launch" }, {
      tenantId: "project-events",
      actorId: "owner",
      mutation: {
        executionScope: updateScope,
        idempotencyKey: "project-update-1",
      },
    });
    const updatedEvents = await listStreamEvents(`project:${first.id}`, {
      tenantId: "project-events",
      actorId: "owner",
    });
    expect(updatedEvents).toHaveLength(2);
    expect(updatedEvents[1]).toMatchObject({
      type: "project.updated",
      correlationId: "request-project-update",
      payload: {
        schemaVersion: 1,
        operation: "project_updated",
        changedFieldIds: ["title"],
      },
    });
    expect(JSON.stringify(updatedEvents[1].payload)).not.toContain(
      "Renamed private launch",
    );

    await expect(createProject({
      ...input,
      title: "Conflicting launch",
    })).rejects.toThrow("already bound to a different project request");
  });

  it("keeps canonical bindings exact in file mode", async () => {
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const actorId = "file-project-owner@example.test";
    const canonicalActorId = `actor:${authUserId}`;
    const canonicalProject = await createProject({
      tenantId: "project-file-binding",
      actorId: canonicalActorId,
      title: "Canonical project",
      objective: "Remain outside the file-mode request scope.",
    });
    const emailProject = await createProject({
      tenantId: "project-file-binding",
      actorId,
      title: "Current email project",
      objective: "Remain visible to the exact file-mode owner.",
    });
    const requestActorBinding = {
      version: 1 as const,
      kind: "auth_user" as const,
      authUserId,
      canonicalActorId,
      legacyOwnerActorIds: Object.freeze([actorId]),
      readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
    };

    await expect(listProjects(10, {
      tenantId: "project-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toEqual([
      expect.objectContaining({ id: emailProject.id, actorId }),
    ]);
    await expect(listProjectSummaries(10, {
      tenantId: "project-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toEqual([
      expect.objectContaining({ id: emailProject.id, actorId }),
    ]);
    await expect(getOwnedProject(canonicalProject.id, {
      tenantId: "project-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toBeUndefined();
    await expect(getOwnedProject(emailProject.id, {
      tenantId: "project-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toEqual(expect.objectContaining({
      id: emailProject.id,
      actorId,
    }));
  });

  it("returns compact project summaries without embedding task or artifact bodies", async () => {
    const project = await createProject({
      tenantId: "personal",
      actorId: "owner",
      title: "Fast mission list",
      objective: "Open the workspace without loading every output.",
    });
    const [task] = await createProjectTasks(project.id, [
      { title: "Measure the payload" },
      { title: "Ship the bounded view" },
    ], { tenantId: "personal" });
    await updateProjectTask(project.id, task.id, { status: "done" }, {
      tenantId: "personal",
      actorId: "owner",
    });
    const summaries = await listProjectSummaries(10, {
      tenantId: "personal",
      actorId: "owner",
    });
    expect(summaries).toEqual([
      expect.objectContaining({
        id: project.id,
        taskCount: 2,
        completedTaskCount: 1,
        activeTaskCount: 0,
        artifactCount: 0,
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty("tasks");
    expect(summaries[0]).not.toHaveProperty("artifacts");
  });

  it("creates a deterministic specialist plan without duplicate tasks", async () => {
    const project = await createProject({
      tenantId: "personal", actorId: "owner", title: "Create an agent research system",
      objective: "Research requests produce grounded reusable reports.",
    });
    const first = await decomposeProject({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    const second = await decomposeProject({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    const tasks = await listProjectTasks(project.id, { tenantId: "personal" });
    expect(first).toMatchObject({ generatedBy: "system", tasks: expect.any(Array) });
    expect(first?.tasks).toHaveLength(5);
    expect(first?.tasks[0].dependsOn).toEqual([]);
    expect(first?.tasks[2].dependsOn).toEqual([first?.tasks[0].id, first?.tasks[1].id]);
    expect(first?.tasks[4].dependsOn).toEqual([first?.tasks[2].id, first?.tasks[3].id]);
    expect(new Set(tasks.map((task) => task.agentId))).toEqual(new Set(["atlas", "scout", "forge", "mnemosyne", "sentinel"]));
    expect(second?.tasks).toEqual([]);
    expect(tasks).toHaveLength(5);
  });

  it("dispatches only dependency-ready tasks and synchronizes workflow completion", async () => {
    const project = await createProject({
      tenantId: "personal", actorId: "owner", title: "Autonomous project",
      objective: "Agents complete a dependency-ordered plan.",
    });
    const [first] = await createProjectTasks(project.id, [{ title: "Research the constraints", agentId: "scout" }], { tenantId: "personal" });
    const [second] = await createProjectTasks(project.id, [{ title: "Build the artifact", agentId: "forge", dependsOn: [first.id] }], { tenantId: "personal" });
    await updateProjectExecution(project.id, {
      autonomyMode: "supervised", executionStatus: "running", taskBudget: 2, maxParallelTasks: 2,
    }, { tenantId: "personal", actorId: "owner" });

    const initial = await syncProjectExecution({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    expect(initial?.dispatchedTaskIds).toEqual([first.id]);
    let tasks = await listProjectTasks(project.id, { tenantId: "personal" });
    expect(tasks.find((task) => task.id === first.id)).toMatchObject({ status: "doing", workflowStatus: "queued", workflowRunId: expect.any(String) });
    expect(tasks.find((task) => task.id === second.id)?.status).toBe("open");
    expect(tasks.find((task) => task.id === second.id)?.workflowRunId).toBeUndefined();

    const firstRunId = tasks.find((task) => task.id === first.id)?.workflowRunId;
    expect(firstRunId).toBeTruthy();
    await transitionWorkflowRun(firstRunId!, ["queued"], {
      status: "completed", completedAt: new Date().toISOString(), result: { report: "Constraints verified." },
    }, { tenantId: "personal" });
    const next = await syncProjectExecution({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    expect(next?.dispatchedTaskIds).toEqual([second.id]);
    tasks = await listProjectTasks(project.id, { tenantId: "personal" });
    expect(tasks.find((task) => task.id === first.id)?.status).toBe("done");
    expect(tasks.find((task) => task.id === second.id)).toMatchObject({ status: "doing", workflowStatus: "queued" });
    await syncProjectExecution({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    const artifacts = await listProjectArtifacts(project.id, { tenantId: "personal" });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      taskId: first.id,
      workflowRunId: firstRunId,
      status: "verified",
      content: "Constraints verified.",
      memoryId: expect.any(String),
    });
    await expect(getMemory(artifacts[0].memoryId!, { tenantId: "personal" })).resolves.toMatchObject({
      scope: "project",
      source: `project-workflow:${firstRunId}`,
      confidence: 0.9,
      evidenceRefs: expect.arrayContaining([`project:${project.id}`, `project-task:${first.id}`, `workflow:${firstRunId}`]),
    });

    const firstReflection = await reflectOnProjectArtifact({
      artifactId: artifacts[0].id,
      projectId: project.id,
      tenantId: "personal",
      actorId: "owner",
      verdict: "useful",
      lesson: "Keep the evidence-first research sequence.",
    });
    expect(firstReflection).toMatchObject({
      verdict: "useful",
      lesson: "Keep the evidence-first research sequence.",
      reflectionMemoryId: expect.any(String),
      reviewedAt: expect.any(String),
    });
    await expect(getMemory(firstReflection!.reflectionMemoryId!, { tenantId: "personal" })).resolves.toMatchObject({
      scope: "project",
      assertedBy: "user",
      source: "feedback:owner",
      content: expect.stringContaining("Keep the evidence-first research sequence."),
      evidenceRefs: expect.arrayContaining([`project-artifact:${artifacts[0].id}`, `workflow:${firstRunId}`]),
    });

    const originalReflectionMemoryId = firstReflection!.reflectionMemoryId!;
    const revisedReflection = await reflectOnProjectArtifact({
      artifactId: artifacts[0].id,
      projectId: project.id,
      tenantId: "personal",
      actorId: "owner",
      verdict: "needs_work",
      lesson: "Compare at least two sources before drawing the conclusion.",
    });
    expect(revisedReflection).toMatchObject({
      verdict: "needs_work",
      lesson: "Compare at least two sources before drawing the conclusion.",
      reflectionMemoryId: expect.any(String),
    });
    expect(revisedReflection!.reflectionMemoryId).not.toBe(originalReflectionMemoryId);
    await expect(getMemory(originalReflectionMemoryId, { tenantId: "personal" })).resolves.toMatchObject({ claimStatus: "superseded" });
    await expect(getMemory(revisedReflection!.reflectionMemoryId!, { tenantId: "personal" })).resolves.toMatchObject({
      claimStatus: "active",
      supersedesId: originalReflectionMemoryId,
      content: expect.stringContaining("Compare at least two sources"),
    });

    const scoutPerformance = (await getAgentPerformance("personal")).find((agent) => agent.agentId === "scout");
    expect(scoutPerformance).toMatchObject({
      projectAssignments: 1,
      lessonsLearned: 1,
      needsWorkOutcomes: 1,
      usefulOutcomes: 0,
      userApprovalRate: 0,
      latestLessons: ["Compare at least two sources before drawing the conclusion."],
    });
    await expect(getAgentLearningGuidance("scout", { tenantId: "personal" })).resolves.toContain(
      "Improve: Compare at least two sources before drawing the conclusion.",
    );

    const failedRunId = tasks.find((task) => task.id === second.id)?.workflowRunId;
    await transitionWorkflowRun(failedRunId!, ["queued"], { status: "failed", error: "Transient build failure." }, { tenantId: "personal" });
    await syncProjectExecution({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    expect(await listProjectArtifacts(project.id, { tenantId: "personal" })).toHaveLength(2);
    await updateProjectTask(project.id, second.id, { status: "open" }, { tenantId: "personal", actorId: "owner" });
    await updateProjectExecution(project.id, { executionStatus: "running", taskBudget: 3 }, { tenantId: "personal", actorId: "owner" });
    await syncProjectExecution({ projectId: project.id, tenantId: "personal", actorId: "owner" });
    tasks = await listProjectTasks(project.id, { tenantId: "personal" });
    expect(tasks.find((task) => task.id === second.id)).toMatchObject({
      status: "doing", workflowStatus: "queued", dispatchAttempt: 2,
    });
    expect(tasks.find((task) => task.id === second.id)?.workflowRunId).not.toBe(failedRunId);
  });
});
