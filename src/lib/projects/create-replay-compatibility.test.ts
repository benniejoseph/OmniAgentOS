import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService, createWorkItemService } from "@/lib/app-services/projects";
import { listStreamEvents } from "@/lib/events/store";
import { projectMutationSha256 } from "@/lib/projects/events";
import { getProject, listProjectTasks } from "@/lib/projects/store";
import type { ProjectLedger } from "@/lib/projects/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { executeGovernedTool } from "@/lib/tools/executor";

vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

const context = { tenantId: "legacy-create", actorId: "owner", role: "operator" as const, source: "session" as const };
const objective = "Owner: Maya.\n\nAccept 25 records.\n  Unresolved: sandbox access.";
const collapsed = (value: string) => value.replace(/\s+/g, " ").trim();
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "asael-create-replay-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_GRADUATED_AUTONOMY", "false");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function caller(key: string, projectId?: string) {
  return createRequestMutationAppServiceCaller(new Request("https://asael.example/api/projects", {
    method: "POST", headers: { "idempotency-key": key },
  }), context, { purpose: projectId ? "project.task.create" : "project.create", projectId });
}

// The previous writer/read mapper collapsed these two bodies. Preserve its
// exact unversioned digest shape as a compatibility fixture, independent of
// the new paragraph-preserving write representation.
async function legacyFixture(projectId: string, taskId?: string) {
  const projectFile = path.join(directory, "projects.json");
  const ledger: ProjectLedger = JSON.parse(await readFile(projectFile, "utf8"));
  const project = ledger.projects.find((item) => item.id === projectId)!;
  const task = taskId ? ledger.tasks.find((item) => item.id === taskId)! : undefined;
  if (task) task.detail = collapsed(task.detail);
  else project.objective = collapsed(project.objective);
  const events = await listStreamEvents(`project:${projectId}`, context);
  const event = events.find((item) => item.type === (task ? "project.task.created" : "project.created") &&
    item.payload.taskId === (taskId || null))!;
  const originalInput = task ? {
    title: task.title, detail: task.detail, priority: task.priority, agentId: task.agentId,
    origin: task.origin, dueAt: task.dueAt || null,
    ...(task.humanOwner ? { humanOwner: task.humanOwner } : {}),
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
    ...(task.dueTimeZone ? { dueTimeZone: task.dueTimeZone } : {}), dependsOn: task.dependsOn,
  } : { title: project.title, objective: project.objective, status: project.status, targetDate: project.targetDate || null };
  // A previous build's normalized request must append this same receipt.
  expect(event.payload.mutationInputSha256).toBe(projectMutationSha256(originalInput));
  await writeFile(projectFile, JSON.stringify(ledger));
  return { project, task, events };
}

describe("create receipt compatibility across text normalization", () => {
  it("retains the historical project receipt in both directions and returns the actual saved layout", async () => {
    const input = { title: "Legacy pilot", objective, targetDate: "2026-10-20T12:00:00.000Z" };
    const requestCaller = caller("legacy-project");
    const first = await createProjectService(requestCaller, input);
    expect(first.data.project.objective).toBe(objective);
    const fixture = await legacyFixture(first.data.project.id);

    const replay = await createProjectService(requestCaller, input);
    expect(replay.data.project).toMatchObject(fixture.project);
    expect(replay.data.project.objective).toBe(collapsed(objective));
    expect(await listStreamEvents(`project:${fixture.project.id}`, context)).toEqual(fixture.events);
    for (const changed of [{ title: "Different pilot" }, { targetDate: "2026-10-21T12:00:00.000Z" }, { objective: objective.replace("25", "26") }]) {
      await expect(createProjectService(requestCaller, { ...input, ...changed })).rejects.toThrow("Idempotency-Key");
    }
    expect(await getProject(fixture.project.id, context)).toEqual(fixture.project);
  });

  it("keeps the first saved layout for direct whitespace-only create replays", async () => {
    const input = { title: "New pilot", objective: collapsed(objective) };
    const requestCaller = caller("new-project");
    const first = await createProjectService(requestCaller, input);
    expect((await createProjectService(requestCaller, { ...input, objective })).data).toEqual(first.data);

    const multilineCaller = caller("new-multiline-project");
    const multiline = await createProjectService(multilineCaller, { ...input, objective });
    expect((await createProjectService(multilineCaller, input)).data).toEqual(multiline.data);
    expect(multiline.data.project.objective).toBe(objective);
    expect(await listStreamEvents(`project:${multiline.data.project.id}`, context)).toHaveLength(1);
  });

  it("keeps legacy task receipt digests, commitments and actual text unchanged while rejecting material changes", async () => {
    const project = (await createProjectService(caller("task-project"), { title: "Pilot", objective })).data.project;
    const predecessor = (await createWorkItemService(caller("dependency", project.id), { projectId: project.id, title: "Sandbox access" })).data.workItem!;
    const requestCaller = caller("legacy-task", project.id);
    const input = { projectId: project.id, title: "Validate records", detail: objective,
      humanOwner: "Maya", dueDate: "2026-10-20", dueTimeZone: "Asia/Kolkata", dependsOn: [predecessor.id] };
    const first = (await createWorkItemService(requestCaller, input)).data.workItem!;
    expect(first.detail).toBe(objective);
    const fixture = await legacyFixture(project.id, first.id);
    const savedTasks = await listProjectTasks(project.id, context);
    expect((await createWorkItemService(requestCaller, input)).data.workItem).toMatchObject(fixture.task!);
    expect(await listStreamEvents(`project:${project.id}`, context)).toEqual(fixture.events);
    for (const changed of [{ humanOwner: "Priya" }, { dueDate: "2026-10-21" }, { dependsOn: [] }, { detail: objective.replace("25", "26") }]) {
      await expect(createWorkItemService(requestCaller, { ...input, ...changed })).rejects.toThrow("Idempotency-Key");
    }
    expect(await listProjectTasks(project.id, context)).toEqual(savedTasks);

    const newCaller = caller("new-task", project.id);
    const multiline = { ...input, title: "New records" };
    const created = await createWorkItemService(newCaller, multiline);
    expect((await createWorkItemService(newCaller, { ...multiline, detail: collapsed(objective) })).data).toEqual(created.data);
    expect(created.data.workItem?.detail).toBe(objective);
  });

  it("still rejects even whitespace-only changed input under a governed execution identity", async () => {
    const executionScope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId,
      executingPrincipalType: "agent", executingPrincipalId: "agent:atlas:exact-create",
      correlationId: "exact-create", purpose: "project.create" });
    const request = { toolId: "app.projects.create", context, executionScope, dryRun: false,
      idempotencyKey: "exact-create", input: { title: "Exact create", objective } };
    const created = await executeGovernedTool(request);
    expect(created.record.status, created.record.reason).toBe("executed");
    expect(await executeGovernedTool(request)).toEqual(created);
    await expect(executeGovernedTool({ ...request, input: { ...request.input, objective: collapsed(objective) } })).rejects.toThrow();
    expect(created.result).toMatchObject({ project: { objective } });
    const projectId = (created.result as { project: { id: string } }).project.id;
    expect((await getProject(projectId, context))?.objective).toBe(objective);
    expect(await listStreamEvents(`project:${projectId}`, context)).toHaveLength(1);
  });
});
