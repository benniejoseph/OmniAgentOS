import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showProjectInventoryService, showProjectService } from "@/lib/app-services/projects";
import { createProject, createProjectTasks, listOwnedProjectTasksPage, saveProjectArtifact } from "@/lib/projects/store";
import type { ProjectLedger } from "@/lib/projects/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { executeGovernedTool } from "@/lib/tools/executor";
import * as canonical from "@/lib/workspaces/read-model";

vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));

const context: SecurityContext = { tenantId: "inventory-fixture", actorId: "owner", role: "operator", source: "session" };
const caller = createAppServiceCaller({ context });
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "asael-project-inventory-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_GRADUATED_AUTONOMY", "false");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(count = 5) {
  const project = await createProject({ ...context, title: "Aster Vale pilot onboarding", objective: "Deliver documented acceptance criteria. ".repeat(45) });
  const tasks = await createProjectTasks(project.id, Array.from({ length: count }, (_, index) => ({
    title: `${index + 1}. ` + 'Pilot "acceptance" and responsible owner. '.repeat(6),
    detail: (`Criterion ${index + 1}: 12 trained agents, two exercises each, at least 10 score 80 percent. ` + "Retain coaching and retest evidence. ".repeat(26)).slice(0, 999) + ".",
    dueAt: "2026-10-17T06:30:00.000Z",
  })), context);
  await saveProjectArtifact({ ...context, id: "fixture-artifact", projectId: project.id, taskId: tasks[0].id,
    workflowRunId: "fixture-workflow", agentId: "atlas", status: "verified", title: "Large pilot evidence", content: "ARTIFACT BODY ".repeat(3_000) });
  return { project, tasks };
}

function withPersistedCanonicalLocators() {
  // File storage has no persisted canonical workspace. Supply only the real
  // canonical mapper's persistence/identity fields; service, executor and stores run.
  const real = canonical.canonicalWorkItemSurfaces;
  vi.spyOn(canonical, "canonicalWorkItemSurfaces").mockImplementation(async (...args) => {
    const surfaces = await real(...args);
    return new Map([...surfaces].map(([id, surface]) => [id, { ...surface,
      status: { ...surface.status, persistence: "postgres" as const, workspaceId: "workspace:canonical-client", projectId: "project:canonical-client", workItemId: `work-item:${id}` },
    }]));
  });
}

function inventoryData(result: Awaited<ReturnType<typeof showProjectInventoryService>>) {
  if (!("taskPage" in result.data) || !result.data.project) throw new Error("Expected owned inventory.");
  return result.data;
}

function governedEnvelope(result: unknown, executionId = "inventory-execution") {
  return JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
    executionId, status: "executed", dryRun: false, approvalRequired: false, note: "Executed for real.", result, admissibleEvidenceIds: [],
  } });
}

describe("bounded Agent project task inventory", () => {
  it("retains all five task IDs and exact inspection locators through the governed path despite long details and artifacts", async () => {
    const { project, tasks } = await fixture();
    withPersistedCanonicalLocators();
    const full = await showProjectService(caller, { projectId: project.id });
    expect(JSON.stringify(full.data).indexOf(tasks[4].id)).toBeGreaterThan(8_000);
    expect(full.data.project?.tasks[0].detail).toContain("Criterion 1:");
    expect(full.data.project?.artifacts[0].content).toContain("ARTIFACT BODY");
    const execution = await executeGovernedTool({ toolId: "app.projects.show", input: { projectId: project.id },
      context, dryRun: false, idempotencyKey: "inventory:five", executionScope: createExecutionScope({
        tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "agent:atlas:inventory",
        projectId: project.id, correlationId: "inventory-run", purpose: "project.inspect",
      }) });
    expect(execution.record.status, execution.record.reason).toBe("executed");
    const data = execution.result as ReturnType<typeof inventoryData>;
    expect(data.project).toMatchObject({ tenantId: context.tenantId, actorId: context.actorId });
    expect(data.project.tasks.map((task) => task.id)).toEqual(tasks.map((task) => task.id));
    expect(data.taskPage).toMatchObject({ returnedCount: 5, hasMore: false, nextCursor: null });
    expect(data.omissions).toEqual({ taskDetails: true, artifacts: true, objective: true });
    expect(data.project.tasks[4]).toMatchObject({ id: tasks[4].id, dueAt: "2026-10-17T06:30:00.000Z",
      readLocator: { workspaceId: "workspace:canonical-client", projectId: "project:canonical-client", workItemId: `work-item:${tasks[4].id}` } });
    expect(JSON.stringify(data)).not.toContain("Criterion 1:");
    expect(JSON.stringify(data)).not.toContain("ARTIFACT BODY");
    const envelope = governedEnvelope(execution.result, execution.record.id);
    expect(envelope.length).toBeLessThanOrEqual(8_000);
    expect(JSON.parse(envelope).data.result.project.tasks).toHaveLength(5);
    const wire = JSON.stringify({ type: "function_call_output", call_id: "fixture-call", output: envelope });
    expect(JSON.parse(wire).output).toBe(envelope);
  });

  it("pages complete rows after the last emitted ID without omissions when positions and timestamps tie", async () => {
    const { project } = await fixture(18);
    const file = path.join(directory, "projects.json");
    const ledger: ProjectLedger = JSON.parse(await readFile(file, "utf8"));
    ledger.tasks = ledger.tasks.map((task, index) => ({ ...task, id: `tied-task-${String(index).padStart(2, "0")}`, position: 0, createdAt: "2026-10-13T00:00:00.000Z" })).reverse();
    await writeFile(file, JSON.stringify(ledger));
    withPersistedCanonicalLocators();
    let taskCursor: string | undefined;
    const seen: string[] = [];
    let pageCount = 0;
    do {
      const service = await showProjectInventoryService(caller, { projectId: project.id, taskLimit: 200, taskCursor });
      const data = inventoryData(service);
      expect(data.taskPage.requestedCursor).toBe(taskCursor ?? null);
      expect(data.taskPage.returnedCount).toBe(data.project.tasks.length);
      expect(data.project.tasks.length).toBeGreaterThan(0);
      expect(governedEnvelope({ ...service.data, serviceReceipt: service.receipt }).length).toBeLessThanOrEqual(8_000);
      seen.push(...data.project.tasks.map((task) => task.id));
      if (data.taskPage.hasMore) {
        const cursor = JSON.parse(Buffer.from(data.taskPage.nextCursor!, "base64url").toString("utf8"));
        expect(cursor.id).toBe(data.project.tasks.at(-1)!.id);
        expect(data.project.tasks.length).toBeLessThan(18);
      } else expect(data.taskPage.nextCursor).toBeNull();
      taskCursor = data.taskPage.nextCursor ?? undefined;
      pageCount += 1;
    } while (taskCursor && pageCount < 20);
    expect(taskCursor).toBeUndefined();
    expect(pageCount).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 18 }, (_, index) => `tied-task-${String(index).padStart(2, "0")}`));
    expect(new Set(seen).size).toBe(18);
  });

  it("reads the full objective before rewriting it and continues any task rows displaced by its size", async () => {
    const { project, tasks } = await fixture();
    withPersistedCanonicalLocators();
    const compact = inventoryData(await showProjectInventoryService(caller, { projectId: project.id }));
    expect(compact.project.objective).toHaveLength(400);
    const seen: string[] = [];
    let taskCursor: string | undefined;
    let pageCount = 0;
    do {
      const service = await showProjectInventoryService(caller, { projectId: project.id, taskCursor, includeFullObjective: true });
      const data = inventoryData(service);
      expect(data.project.objective).toBe(project.objective);
      expect(data.omissions.objective).toBe(false);
      expect(governedEnvelope({ ...service.data, serviceReceipt: service.receipt }).length).toBeLessThanOrEqual(8_000);
      expect(data.taskPage.returnedCount).toBe(data.project.tasks.length);
      if (pageCount === 0) {
        expect(data.taskPage.hasMore).toBe(true);
        expect(data.project.tasks.length).toBeLessThan(compact.project.tasks.length);
      }
      seen.push(...data.project.tasks.map((task) => task.id));
      taskCursor = data.taskPage.nextCursor ?? undefined;
      pageCount += 1;
    } while (taskCursor && pageCount < 10);
    expect(taskCursor).toBeUndefined();
    expect(seen).toEqual(tasks.map((task) => task.id));
  });

  it("rechecks tenant, owner, project and cursor anchor scope on continuation", async () => {
    const { project, tasks } = await fixture();
    const first = await listOwnedProjectTasksPage(project.id, { ...context, limit: 1 });
    expect(first?.hasMore).toBe(true);
    expect(first?.entries).toHaveLength(1);
    const cursor = first!.entries[0].cursor;
    for (const otherContext of [{ ...context, actorId: "foreign-owner" }, { ...context, tenantId: "foreign-tenant" }]) {
      const otherCaller = createAppServiceCaller({ context: otherContext });
      await expect(showProjectInventoryService(otherCaller, { projectId: project.id })).resolves.toMatchObject({ data: { project: null } });
      await expect(showProjectInventoryService(otherCaller, { projectId: project.id, taskCursor: cursor })).rejects.toThrow("invalid for this owner and project");
    }
    const other = await createProject({ ...context, title: "Other owned project", objective: "Keep inventory separate." });
    await expect(showProjectInventoryService(caller, { projectId: other.id, taskCursor: cursor })).rejects.toThrow("invalid for this owner and project");
    const forged = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    forged.id = "task-from-another-project";
    await expect(showProjectInventoryService(caller, { projectId: project.id, taskCursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).rejects.toThrow("cursor changed or is unavailable");
    await expect(showProjectInventoryService(caller, { projectId: project.id, taskCursor: "bad cursor" })).rejects.toThrow("cursor is invalid");
    const file = path.join(directory, "projects.json");
    const ledger: ProjectLedger = JSON.parse(await readFile(file, "utf8"));
    ledger.tasks.find((task) => task.id === tasks[0].id)!.position += 100;
    await writeFile(file, JSON.stringify(ledger));
    await expect(showProjectInventoryService(caller, { projectId: project.id, taskCursor: cursor })).rejects.toThrow("cursor changed or is unavailable");
  });

  it("discloses unavailable canonical inspection and a genuinely empty task page", async () => {
    const { project } = await fixture(1);
    const local = inventoryData(await showProjectInventoryService(caller, { projectId: project.id }));
    expect(local.project.tasks[0].readLocator).toBeNull();
    const empty = await createProject({ ...context, title: "Empty project", objective: "No task created yet." });
    const data = inventoryData(await showProjectInventoryService(caller, { projectId: empty.id }));
    expect(data.project.tasks).toEqual([]);
    expect(data.taskPage).toMatchObject({ returnedCount: 0, hasMore: false, nextCursor: null });
    expect(data.omissions.artifacts).toBe(true);
  });
});
