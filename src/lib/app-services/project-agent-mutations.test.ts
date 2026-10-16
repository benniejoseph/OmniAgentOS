import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService, showProjectService, showProjectTaskService } from "@/lib/app-services/projects";
import { listStreamEvents } from "@/lib/events/store";
import { createProject, getProject, listProjects, listProjectTasks } from "@/lib/projects/store";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { approveAndClaimToolExecution } from "@/lib/tools/audit-store";
import { executeGovernedTool } from "@/lib/tools/executor";

// The project service, dispatcher, executor, policy, store and event ledger are
// real. Only the unrelated shared rate limiter is replaced in this file lane.
vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

const context: SecurityContext = {
  tenantId: "continuity-agent-mutations",
  actorId: "owner@example.test",
  role: "operator",
  source: "session",
};
const input = { title: "Synthetic client", objective: "Deliver the documented pilot commitments." };
const principalId = "agent:atlas:continuity-fixture";
let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-project-agent-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_GRADUATED_AUTONOMY", "false");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

function scope(overrides: Partial<Parameters<typeof createExecutionScope>[0]> = {}) {
  return createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: context.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: principalId,
    correlationId: "continuity-client-run",
    purpose: "continuity.client_work",
    ...overrides,
  });
}

function execute(
  toolId: string,
  toolInput: Record<string, unknown>,
  idempotencyKey: string,
  executionScope: ExecutionScope = scope(),
  options: Partial<Parameters<typeof executeGovernedTool>[0]> = {},
) {
  return executeGovernedTool({
    toolId, input: toolInput, idempotencyKey, executionScope, context, dryRun: false, ...options,
  });
}

describe("actor-bound Agent project mutations through the governed service path", () => {
  it("reports exact objective overage without saving rejected text, then reads valid briefs back unchanged", async () => {
    const created = await execute("app.projects.create", input, "objective:project");
    const project = (created.result as { project: PersonalProject }).project;
    const projectScope = scope({ projectId: project.id });
    const before = await getProject(project.id, context);
    const brief = (length: number) => "Private synthetic pilot requirements. ".repeat(Math.ceil(length / 37)).slice(0, length - 1) + ".";

    for (const length of [2_082, 2_018, 2_014]) {
      const objective = brief(length);
      expect(objective).toHaveLength(length);
      const change = { projectId: project.id, objective: `  ${objective}\n` };
      const failed = await execute("app.projects.update", change, `objective:rejected:${length}`, projectScope);
      expect(failed.record.status).toBe("failed");
      expect(failed.result).toBeNull();
      expect(failed.record.reason).toContain(`Project objective has ${length} characters after trimming; limit 2000 (${length - 2_000} over).`);
      expect(failed.record.reason).toContain("Aim for 1800 or fewer");
      expect(failed.record.reason).not.toContain("Private synthetic pilot requirements");
      expect(failed.record.output).toMatchObject({ recovery: {
        operation: "app.projects.update", field: "objective", actual: length, limit: 2_000,
        overBy: length - 2_000, mutationApplied: false, retry: "revise_input",
      } });
      expect(failed.record.input).toEqual(change);
      expect(await execute("app.projects.update", change, `objective:rejected:${length}`, projectScope)).toEqual(failed);
      await expect(execute("app.projects.update", { projectId: project.id, objective: brief(2_000) },
        `objective:rejected:${length}`, projectScope)).rejects.toThrow();
      expect(await getProject(project.id, context)).toEqual(before);
      expect((await listStreamEvents(`project:${project.id}`, context)).map((event) => event.type)).toEqual(["project.created"]);
    }

    for (const length of [2_000, 1_959]) {
      const objective = brief(length);
      const updated = await execute("app.projects.update", { projectId: project.id, objective: ` ${objective}\n` }, `objective:valid:${length}`, projectScope);
      expect(updated.record.status, updated.record.reason).toBe("executed");
      expect(updated.result).toMatchObject({ project: { id: project.id, objective } });
      const read = await execute("app.projects.show", { projectId: project.id, includeFullObjective: true }, `objective:readback:${length}`, projectScope);
      expect(read.record.status, read.record.reason).toBe("executed");
      expect(read.result).toMatchObject({ project: { id: project.id, objective } });
      expect((await getProject(project.id, context))?.objective).toBe(objective);
    }
    expect((await listStreamEvents(`project:${project.id}`, context)).map((event) => event.type)).toEqual(["project.created", "project.updated", "project.updated"]);
  });

  it("gives the same precise objective limit on create without creating a partial project", async () => {
    const objective = "Pilot condition. ".repeat(130).slice(0, 2_013) + ".";
    expect(objective).toHaveLength(2_014);
    const failed = await execute("app.projects.create", { ...input, objective }, "objective:invalid-create");
    expect(failed.record.status).toBe("failed");
    expect(failed.record.reason).toContain("Project objective has 2014 characters after trimming; limit 2000 (14 over).");
    expect(failed.record.output).toMatchObject({ recovery: { operation: "app.projects.create", field: "objective", actual: 2_014, limit: 2_000, mutationApplied: false } });
    expect(await listProjects(10, context)).toEqual([]);
  });

  it.each(["create", "update"] as const)("recovers a work-item %s with a new identity and reads every commitment back unchanged", async (operation) => {
    const createdProject = await execute("app.projects.create", input, `detail:${operation}:project`);
    const project = (createdProject.result as { project: PersonalProject }).project;
    const projectScope = scope({ projectId: project.id });
    const predecessorResult = await execute("app.work_items.create", { projectId: project.id, title: "Prepare dependency" }, `detail:${operation}:dependency`, projectScope);
    const predecessor = (predecessorResult.result as { workItem: ProjectTask }).workItem;
    const existingResult = operation === "update"
      ? await execute("app.work_items.create", { projectId: project.id, title: "Original task", detail: "Original criterion." }, "detail:update:original", projectScope)
      : undefined;
    const existing = (existingResult?.result as { workItem: ProjectTask } | undefined)?.workItem;
    const commitments = {
      projectId: project.id, ...(existing ? { workItemId: existing.id } : {}),
      title: "Validate sample mapping", humanOwner: "Maya Chen", dueDate: "2026-10-20",
      dueTimeZone: "Asia/Kolkata", dependsOn: [predecessor.id], priority: "high", agentId: "forge",
    };
    const acceptance = "Accept exactly 25 complete records; Priya must approve in writing. Unresolved: sandbox access.\n";
    const detail = acceptance + "Review recorded evidence. ".repeat(40).slice(0, 999 - acceptance.length) + ".";
    expect(detail).toHaveLength(1_000);
    const oversized = { ...commitments, detail: `  ${detail} Another sentence.\n` };
    const toolId = `app.work_items.${operation}`;
    const rejectedKey = `detail:${operation}:rejected`;
    const before = await listProjectTasks(project.id, context);
    const beforeEvents = await listStreamEvents(`project:${project.id}`, context);

    const failed = await execute(toolId, oversized, rejectedKey, projectScope);
    expect(failed.record.status, failed.record.reason).toBe("failed");
    expect(failed.result).toBeNull();
    expect(failed.record.reason).toContain("Work-item detail has 1018 characters after trimming; limit 1000 (18 over).");
    expect(failed.record.reason).not.toContain("Priya");
    expect(failed.record.output).toMatchObject({ recovery: {
      operation: toolId, field: "detail", actual: 1_018, limit: 1_000, overBy: 18,
      suggestedMax: 900, mutationApplied: false, retry: "revise_input",
    } });
    expect(await execute(toolId, oversized, rejectedKey, projectScope)).toEqual(failed);
    const corrected = { ...commitments, detail: ` ${detail}\n` };
    await expect(execute(toolId, corrected, rejectedKey, projectScope)).rejects.toThrow();
    expect(await listProjectTasks(project.id, context)).toEqual(before);
    expect(await listStreamEvents(`project:${project.id}`, context)).toEqual(beforeEvents);

    const saved = await execute(toolId, corrected, `detail:${operation}:corrected`, projectScope);
    expect(saved.record.status, saved.record.reason).toBe("executed");
    expect(saved.record.id).not.toBe(failed.record.id);
    const task = (saved.result as { workItem: ProjectTask }).workItem;
    const expected = { id: task.id, title: commitments.title, detail, humanOwner: commitments.humanOwner,
      dueDate: commitments.dueDate, dueTimeZone: commitments.dueTimeZone,
      dependsOn: commitments.dependsOn, priority: commitments.priority, agentId: commitments.agentId };
    expect(task).toMatchObject(expected);
    const read = await showProjectTaskService(createAppServiceCaller({ context }), { projectId: project.id, taskId: task.id });
    expect(read.data.task).toMatchObject(expected);
    expect(read.data.task?.dueAt).toBeUndefined();
    expect(await execute(toolId, corrected, `detail:${operation}:corrected`, projectScope)).toEqual(saved);
    expect(await listProjectTasks(project.id, context)).toHaveLength(2);
    const events = await listStreamEvents(`project:${project.id}`, context);
    expect(events).toHaveLength(beforeEvents.length + 1);
    expect(events.at(-1)?.type).toBe(operation === "create" ? "project.task.created" : "project.task.updated");
  });

  it("saves explicit human commitments, calendar dates and dependencies without changing authority or acceptance criteria", async () => {
    const createdProject = await execute("app.projects.create", input, "structured:project");
    const project = (createdProject.result as { project: PersonalProject }).project;
    const projectScope = scope({ projectId: project.id });
    const predecessorResult = await execute("app.work_items.create", {
      projectId: project.id, title: "Prepare sandbox", humanOwner: "Maya Chen", dueDate: "2026-10-14",
    }, "structured:sandbox", projectScope);
    expect(predecessorResult.record.status, predecessorResult.record.reason).toBe("executed");
    const predecessor = (predecessorResult.result as { workItem: ProjectTask }).workItem;
    const detail = "Accept 25 synthetic tickets with all required fields mapped and Priya's written approval.";
    const createInput = { projectId: project.id, title: "Validate ticket mapping", detail, humanOwner: "Jonah Patel",
      dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata", dependsOn: [predecessor.id] };
    const created = await execute("app.work_items.create", createInput, "structured:mapping", projectScope);
    expect(created.record.status, created.record.reason).toBe("executed");
    const task = (created.result as { workItem: ProjectTask }).workItem;
    expect(task).toMatchObject({ detail, humanOwner: "Jonah Patel", dueDate: "2026-10-17",
      dueTimeZone: "Asia/Kolkata", dependsOn: [predecessor.id], agentId: "atlas" });
    expect(task.dueAt).toBeUndefined();
    expect((await execute("app.work_items.create", createInput, "structured:mapping", projectScope)).result).toEqual(created.result);
    const changed = await execute("app.work_items.update", { projectId: project.id, workItemId: task.id,
      humanOwner: "Elena Ruiz", dueDate: "2026-10-18", dueTimeZone: null }, "structured:change", projectScope);
    expect(changed.record.status, changed.record.reason).toBe("executed");
    expect(changed.result).toMatchObject({ workItem: { id: task.id, detail, humanOwner: "Elena Ruiz", dueDate: "2026-10-18", dependsOn: [predecessor.id] } });
    expect((changed.result as { workItem: ProjectTask }).workItem.dueTimeZone).toBeUndefined();
    const timed = await execute("app.work_items.update", { projectId: project.id, workItemId: task.id,
      dueAt: "2026-10-18T09:30:00+05:30" }, "structured:timed", projectScope);
    expect(timed.record.status, timed.record.reason).toBe("executed");
    const timedTask = (timed.result as { workItem: ProjectTask }).workItem;
    expect(timedTask.dueAt).toBe("2026-10-18T04:00:00.000Z");
    expect(timedTask.dueDate).toBeUndefined();
    expect(timedTask.dueTimeZone).toBeUndefined();
    const cleared = await execute("app.work_items.update", { projectId: project.id, workItemId: task.id,
      humanOwner: null, dueAt: null, dependsOn: [] }, "structured:clear", projectScope);
    expect(cleared.record.status, cleared.record.reason).toBe("executed");
    expect((cleared.result as { workItem: ProjectTask }).workItem).toMatchObject({ id: task.id, detail, dependsOn: [] });
    expect((cleared.result as { workItem: ProjectTask }).workItem.humanOwner).toBeUndefined();
    const savedProject = await getProject(project.id, context);
    expect(savedProject?.actorId).toBe(context.actorId);
    expect(await listProjectTasks(project.id, context)).toHaveLength(2);
    const events = await listStreamEvents(`project:${project.id}`, context);
    expect(events.every((event) => event.actorId === context.actorId && event.executionScope?.executingPrincipalId === principalId)).toBe(true);
  });

  it("rejects conflicting deadlines and dependency cycles through the same governed mutation path", async () => {
    const createdProject = await execute("app.projects.create", input, "invalid-commitment:project");
    const project = (createdProject.result as { project: PersonalProject }).project;
    const projectScope = scope({ projectId: project.id });
    const created = await execute("app.work_items.create", { projectId: project.id, title: "First commitment" }, "invalid-commitment:first", projectScope);
    const first = (created.result as { workItem: ProjectTask }).workItem;
    const secondResult = await execute("app.work_items.create", { projectId: project.id, title: "Second commitment", dependsOn: [first.id] }, "invalid-commitment:second", projectScope);
    const second = (secondResult.result as { workItem: ProjectTask }).workItem;
    for (const [index, change] of [
      { dueDate: "2026-02-30" },
      { dueDate: "2026-10-17", dueAt: "2026-10-17T12:00:00Z" },
      { dueDate: "2026-10-17", dueTimeZone: "Mars/Olympus" },
      { dependsOn: [first.id] },
      { dependsOn: [second.id] },
      { dependsOn: ["task-in-another-project"] },
    ].entries()) {
      const refused = await execute("app.work_items.update", { projectId: project.id, workItemId: first.id, ...change }, `invalid-commitment:${index}`, projectScope);
      expect(refused.record.status).toBe("failed");
      expect(refused.result).toBeNull();
    }
    const saved = (await listProjectTasks(project.id, context)).find((task) => task.id === first.id)!;
    expect(saved.dependsOn).toEqual([]);
    expect(saved.dueAt).toBeUndefined();
    expect(saved.dueDate).toBeUndefined();
  });

  it("creates, replays and updates real owned records with distinct user/Agent event attribution", async () => {
    const first = await execute("app.projects.create", input, "client:create");
    expect(first.record.status, first.record.reason).toBe("executed");
    const project = (first.result as { project: PersonalProject }).project;
    expect(project).toMatchObject({ ...input, tenantId: context.tenantId, actorId: context.actorId });
    const replay = await execute("app.projects.create", input, "client:create");
    expect(replay).toEqual(first);
    expect(await listProjects(10, context)).toHaveLength(1);
    const events = await listStreamEvents(`project:${project.id}`, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "project.created", actorId: context.actorId,
      executionScope: {
        initiatingActorId: context.actorId,
        executingPrincipalType: "agent",
        executingPrincipalId: principalId,
      },
    });

    await expect(execute("app.projects.create", { ...input, title: "Conflicting request" }, "client:create"))
      .rejects.toThrow();
    expect(await listProjects(10, context)).toHaveLength(1);

    const projectScope = scope({ projectId: project.id });
    const taskInput = { projectId: project.id, title: "Validate ticket mapping", detail: "Owner: Jonah. Accept 25 valid tickets.", dueAt: "2026-10-15T06:30:00.000Z" };
    const created = await execute("app.work_items.create", taskInput, "mapping:create", projectScope);
    expect(created.record.status, created.record.reason).toBe("executed");
    const task = (created.result as { workItem: ProjectTask }).workItem;
    expect((await execute("app.work_items.create", taskInput, "mapping:create", projectScope)).result).toEqual(created.result);
    expect(await listProjectTasks(project.id, context)).toHaveLength(1);

    const change = { projectId: project.id, workItemId: task.id, status: "done", detail: "25 valid tickets and named acceptance recorded.", dueAt: "2026-10-17T06:30:00.000Z" };
    const updated = await execute("app.work_items.update", change, "mapping:change", projectScope);
    expect(updated.record.status, updated.record.reason).toBe("executed");
    expect(updated.result).toMatchObject({
      workItem: { id: task.id, status: "done", dueAt: change.dueAt, detail: change.detail, workItemStatus: { status: "unverified", sourceStatus: "done/unknown" } },
    });
    expect((await execute("app.work_items.update", change, "mapping:change", projectScope)).result).toEqual(updated.result);

    const changedProject = await execute("app.projects.update", { projectId: project.id, title: "Synthetic pilot" }, "client:change", projectScope);
    expect(changedProject.record.status, changedProject.record.reason).toBe("executed");
    const read = await execute("app.projects.show", { projectId: project.id }, "client:read", projectScope);
    expect(read.record.status, read.record.reason).toBe("executed");
    expect(read.result).toMatchObject({ project: { title: "Synthetic pilot", tasks: [{ id: task.id, status: "done", dueAt: change.dueAt, canonicalStatus: "unverified" }] }, omissions: { taskDetails: true, artifacts: true } });
    const fullRead = await showProjectService(createAppServiceCaller({ context }), { projectId: project.id });
    expect(fullRead.data.project?.tasks[0]).toMatchObject({ id: task.id, detail: change.detail });
    const finalEvents = await listStreamEvents(`project:${project.id}`, context);
    expect(finalEvents.map((event) => event.type)).toEqual([
      "project.created", "project.task.created", "project.task.updated", "project.updated",
    ]);
    expect(finalEvents.every((event) => event.executionScope?.executingPrincipalId === principalId)).toBe(true);
  });

  it.each([
    ["tenant", { tenantId: "other-tenant" }],
    ["actor", { initiatingActorId: "someone-else" }],
    ["user principal", { executingPrincipalType: "user", executingPrincipalId: "someone-else" }],
  ] as const)("rejects a mismatched %s before any project effect", async (_label, overrides) => {
    await expect(execute("app.projects.create", input, "client:invalid", scope(overrides))).rejects.toThrow();
    expect(await listProjects(10, context)).toEqual([]);
  });

  it.each([
    ["missing principal", { executingPrincipalId: null }],
    ["system principal", { executingPrincipalType: "system", executingPrincipalId: "workflow:fixture" }],
  ] as const)("does not admit a %s through the Agent-facing service", async (_label, overrides) => {
    const refused = await execute("app.projects.create", input, "client:invalid", scope(overrides));
    expect(refused.record.status).toBe("failed");
    expect(refused.result).toBeNull();
    expect(await listProjects(10, context)).toEqual([]);
  });

  it("preserves read-only policy, role permissions and the strict model argument schema", async () => {
    const readOnly = await execute("app.projects.create", input, "client:read-only", scope(), { requireReadOnly: true });
    expect(readOnly.record).toMatchObject({ status: "blocked", reason: "This run permits only read-only tools." });
    await expect(execute("app.projects.create", input, "client:viewer", scope(), { context: { ...context, role: "viewer" } }))
      .resolves.toMatchObject({ record: { status: "failed", reason: "Role viewer cannot perform run.agent." }, result: null });
    for (const [index, injected] of [{ actorId: "someone-else" }, { tenantId: "other" }, { principalMode: "user_or_agent" }, { executionScope: scope() }].entries()) {
      await expect(execute("app.projects.create", { ...input, ...injected }, `client:injected:${index}`))
        .resolves.toMatchObject({ record: { status: "failed", reason: expect.stringContaining("unrecognized_keys") }, result: null });
    }
    expect(await listProjects(10, context)).toEqual([]);
  });

  it("refuses a wrong target project and a task belonging to another project", async () => {
    const first = await execute("app.projects.create", input, "client:first");
    const second = await execute("app.projects.create", { ...input, title: "Other client" }, "client:second");
    const project = (first.result as { project: PersonalProject }).project;
    const other = (second.result as { project: PersonalProject }).project;
    const created = await execute("app.work_items.create", { projectId: project.id, title: "Exact task" }, "task:create", scope({ projectId: project.id }));
    const task = (created.result as { workItem: ProjectTask }).workItem;
    await expect(execute("app.work_items.update", { projectId: project.id, workItemId: task.id, status: "done" }, "task:wrong-scope", scope({ projectId: other.id })))
      .rejects.toThrow("projectId does not match its execution scope");
    const wrongParent = await execute("app.work_items.update", { projectId: other.id, workItemId: task.id, status: "done" }, "task:wrong-parent", scope({ projectId: other.id }));
    expect(wrongParent.result).toMatchObject({ workItem: null });
    expect(await listProjectTasks(project.id, context)).toMatchObject([{ id: task.id, status: "open" }]);
    expect(await listStreamEvents(`project:${project.id}`, context)).toHaveLength(2);
  });

  it("keeps forced approval pending until the bound claim is supplied, then replays one effect", async () => {
    const request = { toolId: "app.projects.create", input, idempotencyKey: "client:approved", executionScope: scope(), context, dryRun: false, forceApproval: true };
    const pending = await executeGovernedTool(request);
    expect(pending.record.status).toBe("approval_required");
    expect((await executeGovernedTool(request)).record.id).toBe(pending.record.id);
    expect(await listProjects(10, context)).toEqual([]);
    const claimToken = "continuity-project-approval-claim";
    const claim = await approveAndClaimToolExecution({
      id: pending.record.id, tenantId: context.tenantId, approvedBy: context.actorId,
      approvedRole: context.role, claimToken,
      mutation: { executionScope: scope({ executingPrincipalType: "user", executingPrincipalId: context.actorId, causationId: pending.record.id, purpose: "tool.approval.approve" }), idempotencyKey: "client:approval" },
    });
    expect(claim.outcome).toBe("claimed");
    const executed = await executeGovernedTool({ ...request, approved: true, existingRecord: claim.record!, executionClaimToken: claimToken });
    expect(executed.record.status, executed.record.reason).toBe("executed");
    const replay = await executeGovernedTool(request);
    expect(replay.result).toEqual(executed.result);
    const [project] = await listProjects(10, context);
    expect(await listProjects(10, context)).toHaveLength(1);
    expect(await listStreamEvents(`project:${project.id}`, context)).toHaveLength(1);
  });

  it("keeps direct interactive store calls user-only and existing request services working", async () => {
    await expect(createProject({ ...input, ...context, mutation: { executionScope: scope(), idempotencyKey: "direct:agent" } })).rejects.toThrow("Interactive project mutation scope");
    const caller = createRequestMutationAppServiceCaller(new Request("https://asael.example.test/api/projects", {
      method: "POST", headers: { "Idempotency-Key": "interactive:create" },
    }), context, { purpose: "project.create" });
    const saved = await createProjectService(caller, input);
    expect(await getProject(saved.data.project.id, context)).toMatchObject(input);
    expect((await listStreamEvents(`project:${saved.data.project.id}`, context))[0].executionScope).toMatchObject({ executingPrincipalType: "user", executingPrincipalId: context.actorId });

    await expect(createProjectService(createAppServiceCaller({ context, executionScope: scope({ executingPrincipalId: null }), idempotencyKey: "service:missing-principal" }), input)).rejects.toThrow("user or agent principal");
  });
});
