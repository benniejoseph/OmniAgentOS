import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createProject, createProjectTasks, listProjectTasks, updateProjectTask, replaceProjectTaskDependencies, claimProjectTaskForDispatch } from "@/lib/projects/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { readOwnedWorkItemWithSql, type WorkItemSourceRead } from "@/lib/responsibilities/work-item-source";
import type { SqlClient } from "@/lib/db/sql-types";
import { parseCanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import { removeEmptyProjectTaskCommitmentsForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "68686868-6868-4868-8868-686868686868";
const owner = { tenantId: "project-commitments", actorId: `actor:${userId}` };
const asOwner = <T,>(operation: () => Promise<T>) => runWithDatabaseActorScope(owner.tenantId, [owner.actorId], operation);
const mutation = (key: string, projectId?: string) => ({ principalMode: "user_or_agent" as const, idempotencyKey: `commitments:${key}`,
  executionScope: createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId,
    executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId, correlationId: `commitments:${key}`, purpose: "project.commitments.fixture" }) });

// Explicitly disposable database only. All scenarios use synthetic records.
databaseDescribe("Structured task commitments through migrated serving-role storage", () => {
  let admin: ReturnType<typeof postgres>;
  let project: Awaited<ReturnType<typeof createProject>>;
  let tasks: Awaited<ReturnType<typeof createProjectTasks>>;
  let servingRoleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema(); await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${owner.tenantId},'Commitments','project-commitments')`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},'commitments@example.test','fixture-only')`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES ('commitments-membership',${owner.tenantId},${userId},'operator')`;
    project = await asOwner(() => createProject({ ...owner, title: "Client commitments", objective: "Verify structured fields", mutation: mutation("project") }));
    const runtimePassword = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE project_commitments_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    servingRoleCreated = true;
    // Legacy object privileges are normally provisioned by hosting. Retain real
    // tenant/actor FORCE RLS and the exact migrated workspace read-fence grants.
    await admin`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_memberships,omni_auth_tenants,omni_project_artifacts,omni_agent_runs,omni_mission_attempts,omni_workflow_runs,omni_tool_executions TO project_commitments_runtime`;
    await admin`GRANT SELECT,INSERT,UPDATE ON omni_projects,omni_project_tasks,omni_events TO project_commitments_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO project_commitments_runtime`;
    await closeDatabaseClient();
    const runtimeUrl = new URL(databaseUrl!); runtimeUrl.username = "project_commitments_runtime"; runtimeUrl.password = runtimePassword;
    vi.stubEnv("DATABASE_URL", runtimeUrl.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4");
    await ensureDatabaseSchema();
    const [role] = await asOwner(() => getSql()`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toMatchObject({ name: "project_commitments_runtime", rolsuper: false, rolbypassrls: false });
    tasks = await asOwner(() => createProjectTasks(project.id, [{ title: "Sandbox" }, { title: "Mapping" }, { title: "Training" }], { ...owner, mutation: mutation("tasks", project.id) }));
  });
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (servingRoleCreated) { await admin`DROP OWNED BY project_commitments_runtime`; await admin`DROP ROLE project_commitments_runtime`; }
      await admin.end();
    }
  });

  test("persists exact human/date/dependency fields and reads them with a distinct Agent principal", async () => {
    const saved = await asOwner(() => updateProjectTask(project.id, tasks[1].id, { humanOwner: "Jonah Patel", dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata", dependsOn: [tasks[0].id] }, { ...owner, mutation: mutation("mapping", project.id) }));
    expect(saved).toMatchObject({ humanOwner: "Jonah Patel", dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata", agentId: "atlas", dependsOn: [tasks[0].id] });
    expect(saved?.dueAt).toBeUndefined();
    const read = await asOwner(() => getSql().transaction(async (sql: SqlClient) => readOwnedWorkItemWithSql(sql, owner, {
      workspaceId: `workspace:personal:${userId}`, projectId: project.id, workItemId: tasks[1].id,
    }, new Date().toISOString())) as Promise<WorkItemSourceRead>);
    expect(read.workItem).toMatchObject({ humanOwner: "Jonah Patel", ownerActorIds: [owner.actorId], schedule: { dueAt: null, dueDate: "2026-10-17", timeZone: "Asia/Kolkata" } });
    expect(read.dependencies).toMatchObject([{ id: tasks[0].id, state: "available" }]);
    const events = await asOwner(() => getSql()`SELECT payload,actor_id FROM omni_events WHERE tenant_id = ${owner.tenantId} AND stream_id = ${`project:${project.id}`} AND type = 'project.task.updated'`);
    expect(events).toHaveLength(1); expect(events[0].actor_id).toBe(owner.actorId);
    expect(events[0].payload).toMatchObject({ changedFieldIds: ["dependsOn", "dueDate", "dueTimeZone", "humanOwner"] });
    expect(JSON.stringify(events[0].payload)).not.toContain("Jonah");
  });

  test("serializes opposing dependency edges and rejects foreign IDs without partial updates", async () => {
    await asOwner(() => updateProjectTask(project.id, tasks[1].id, { dependsOn: [] }, { ...owner, mutation: mutation("clear-mapping", project.id) }));
    const results = await Promise.allSettled([
      asOwner(() => updateProjectTask(project.id, tasks[0].id, { dependsOn: [tasks[1].id] }, { ...owner, mutation: mutation("edge-a", project.id) })),
      asOwner(() => updateProjectTask(project.id, tasks[1].id, { dependsOn: [tasks[0].id] }, { ...owner, mutation: mutation("edge-b", project.id) })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const before = await asOwner(() => listProjectTasks(project.id, owner));
    await expect(asOwner(() => replaceProjectTaskDependencies(project.id, [{ taskId: tasks[0].id, dependsOn: [] }, { taskId: tasks[1].id, dependsOn: ["foreign-task"] }], { ...owner, mutation: mutation("foreign", project.id) }))).rejects.toThrow("existing task");
    expect(await asOwner(() => listProjectTasks(project.id, owner))).toEqual(before);
    await expect(runWithDatabaseActorScope(owner.tenantId, ["actor:78787878-7878-4878-8878-787878787878"], () => updateProjectTask(project.id, tasks[0].id, { humanOwner: "Foreign" }, { ...owner, mutation: mutation("foreign-actor", project.id) }))).rejects.toMatchObject({ code: "42501" });
    expect(await asOwner(() => listProjectTasks(project.id, owner))).toEqual(before);
  });

  test("changes precision without altering untouched criteria and enforces the database invariant", async () => {
    await asOwner(() => updateProjectTask(project.id, tasks[2].id, { detail: "12 attendees and an acceptance report", dueAt: "2026-10-21T04:30:00.000Z" }, { ...owner, mutation: mutation("exact-time", project.id) }));
    const dated = await asOwner(() => updateProjectTask(project.id, tasks[2].id, { dueDate: "2026-10-21" }, { ...owner, mutation: mutation("date-only", project.id) }));
    expect(dated).toMatchObject({ detail: "12 attendees and an acceptance report", dueDate: "2026-10-21" }); expect(dated?.dueAt).toBeUndefined(); expect(dated?.dueTimeZone).toBeUndefined();
    await expect(asOwner(() => getSql()`UPDATE omni_project_tasks SET due_at = '2026-10-21T00:00:00Z' WHERE id = ${tasks[2].id}`)).rejects.toMatchObject({ code: "23514" });
    await asOwner(() => updateProjectTask(project.id, tasks[2].id, { dueDate: null }, { ...owner, mutation: mutation("clear-date", project.id) }));
    const rows = await asOwner(() => getSql()`SELECT projection FROM omni_work_items WHERE work_item_id = ${tasks[2].id}`);
    expect(parseCanonicalWorkItemV1(rows[0].projection).schedule).toEqual({ startsAt: null, dueAt: null, timeZone: null });
  });

  test("blocks execution until saved dependencies close and forbids changes during dispatch", async () => {
    const [gate] = await asOwner(() => createProjectTasks(project.id, [{ title: "Dispatch gate" }], { ...owner, mutation: mutation("dispatch-gate", project.id) }));
    const [task] = await asOwner(() => createProjectTasks(project.id, [{ title: "Dispatch follower", dependsOn: [gate.id] }], { ...owner, mutation: mutation("dispatch-task", project.id) }));
    expect(await asOwner(() => claimProjectTaskForDispatch(project.id, task.id, { ...owner, mutation: mutation("blocked-claim", project.id) }))).toBeUndefined();
    await asOwner(() => updateProjectTask(project.id, gate.id, { status: "done" }, { ...owner, mutation: mutation("gate-closed", project.id) }));
    expect(await asOwner(() => claimProjectTaskForDispatch(project.id, task.id, { ...owner, mutation: mutation("ready-claim", project.id) }))).toMatchObject({ workflowStatus: "dispatching" });
    await expect(asOwner(() => updateProjectTask(project.id, task.id, { dependsOn: [] }, { ...owner, mutation: mutation("change-running", project.id) }))).rejects.toThrow("active workflow");
    await expect(asOwner(() => replaceProjectTaskDependencies(project.id, [{ taskId: task.id, dependsOn: [] }], { ...owner, mutation: mutation("replace-running", project.id) }))).rejects.toThrow("active workflow");
  });

  test("historical replay refuses to remove populated commitment fields or their migration marker", async () => {
    await asOwner(() => updateProjectTask(project.id, tasks[2].id, { humanOwner: "Replay preservation fixture" },
      { ...owner, mutation: mutation("replay-preservation", project.id) }));
    const before = await asOwner(() => listProjectTasks(project.id, owner));
    expect(before.some((task) => task.humanOwner || task.dueDate || task.dueTimeZone)).toBe(true);
    await expect(admin.begin((sql) => removeEmptyProjectTaskCommitmentsForReplay(sql)))
      .rejects.toThrow("preserve populated project task commitments");
    expect(await asOwner(() => listProjectTasks(project.id, owner))).toEqual(before);
    expect(await admin`SELECT version FROM omni_schema_version WHERE version=256`).toEqual([{ version: 256 }]);
  });
});
