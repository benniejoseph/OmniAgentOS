import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { searchOwnedThreadsPage } from "@/lib/threads/store";
import { searchPrivateMemoryPage, getPrivateSearchMemory } from "@/lib/memory/store";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { searchOwnedWorkPage, resolveOwnedSearchWork } from "@/lib/content-search/work-reader";
import { listWorkspaceLibrary } from "@/lib/library/store";
import { createProject, createProjectTasks, getOwnedProjectTask } from "@/lib/projects/store";
import { searchContext } from "@/lib/content-search/test-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const enabled = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const databaseDescribe = enabled ? describe : describe.skip;
const canonicalActorId = `actor:${searchContext.auth!.userId}`;
const owner = { tenantId: searchContext.tenantId, actorId: searchContext.actorId,
  requestActorBinding: canonicalRequestActorBindingFromSecurityContext(searchContext) };
const asOwner = <T,>(operation: () => Promise<T>) => runWithDatabaseActorScope(owner.tenantId, [canonicalActorId, owner.actorId], operation);
const access = requestMemoryAccessFromSecurityContext(searchContext, { purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: "search.integration", correlationId: "search-integration" })!;

// The same explicit disposable-database guard as the existing integration lane.
// All records are synthetic. Search invokes no model, embedding, connector or effect.
databaseDescribe("Content search real storage boundaries", () => {
  let admin: ReturnType<typeof postgres>;
  let project: Awaited<ReturnType<typeof createProject>>;
  let tasks: Awaited<ReturnType<typeof createProjectTasks>>;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema(); await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`INSERT INTO omni_auth_tenants (id, name, slug) VALUES (${owner.tenantId}, 'Search', 'content-search-test')`;
    await admin`INSERT INTO omni_auth_users (id, email, password_hash) VALUES (${searchContext.auth!.userId}, ${owner.actorId}, 'test-only')`;
    await admin`INSERT INTO omni_auth_users (id, email, password_hash) VALUES ('22222222-2222-4222-8222-222222222222', 'foreign@example.test', 'test-only')`;
    await admin`INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role) VALUES ('content-search-membership', ${owner.tenantId}, ${searchContext.auth!.userId}, 'operator')`;
    const mutation = (key: string) => ({ idempotencyKey: `search-${key}`, executionScope: createExecutionScope({
      tenantId: owner.tenantId, initiatingActorId: canonicalActorId, executingPrincipalType: "user", executingPrincipalId: canonicalActorId,
      correlationId: `search-${key}`, purpose: "search.fixture",
    }) });
    const sourceOwner = { tenantId: owner.tenantId, actorId: canonicalActorId };
    project = await asOwner(() => createProject({ ...sourceOwner, title: "Report launch", objective: "Synthetic report project", mutation: mutation("project") }));
    tasks = await asOwner(() => createProjectTasks(project.id, [{ title: "Report task A" }, { title: "Report task B" }], { ...sourceOwner, mutation: mutation("tasks") }));
    // Only fixture setup uses the administrator. The actual application readers
    // reconnect as an ordinary serving-role member, with production schema
    // verification and the real RLS policies, on a one-connection pool.
    // A new disposable credential for this test process; no reusable secret is checked in.
    const runtimePassword = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE content_search_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    // Legacy tables receive their normal object privileges from deployment
    // provisioning. These test-only SELECT grants do not alter any RLS policy.
    await admin`GRANT SELECT ON omni_schema_version, omni_threads, omni_memories,
      omni_memory_lifecycle_states, omni_projects, omni_project_tasks,
      omni_project_artifacts, omni_missions, omni_mission_artifacts,
      omni_capture_assets, omni_capture_recordings, omni_knowledge_documents,
      omni_source_items, omni_source_revisions, omni_source_sync_heads, omni_oauth_grants TO content_search_runtime`;
    await closeDatabaseClient();
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "content_search_runtime";
    runtimeUrl.password = runtimePassword;
    vi.stubEnv("DATABASE_URL", runtimeUrl.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    await ensureDatabaseSchema();
    const [role] = await asOwner(() => getSql()`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toMatchObject({ name: "content_search_runtime", rolsuper: false, rolbypassrls: false });
  });
  afterAll(async () => {
    await closeDatabaseClient();
    vi.unstubAllEnvs();
    if (admin) {
      await admin`DROP OWNED BY content_search_runtime`;
      await admin`DROP ROLE content_search_runtime`;
      await admin.end();
    }
  });

  test("conversation pages use exact owner/tenant, literal matching and microsecond ties", async () => {
    const records = [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", owner.tenantId, canonicalActorId],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", owner.tenantId, owner.actorId],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", owner.tenantId, "foreign@example.test"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "foreign-tenant", owner.actorId],
    ];
    for (const [id, tenant, actor] of records) await admin`
      INSERT INTO omni_threads (id, tenant_id, actor_id, title, mode, created_at, updated_at)
      VALUES (${id}, ${tenant}, ${actor}, 'Report 100%', 'orchestrate', '2026-10-04T00:00:00.123456Z', '2026-10-04T00:00:00.123456Z')`;
    const first = await asOwner(() => searchOwnedThreadsPage({ ...owner, query: "Report", limit: 1 }));
    expect(first.next).toEqual({ updatedAt: "2026-10-04T00:00:00.123456Z", id: records[0][0] });
    const second = await asOwner(() => searchOwnedThreadsPage({ ...owner, query: "Report", limit: 1, after: first.next! }));
    expect([first.items.map((item) => item.id), second.items.map((item) => item.id)]).toEqual([[records[0][0]], [records[1][0]]]);
    expect(first.next?.updatedAt).toBe("2026-10-04T00:00:00.123456Z"); expect(second.next).toBeNull();
    expect((await asOwner(() => searchOwnedThreadsPage({ ...owner, query: "report_", limit: 8 }))).items).toEqual([]);
    await admin`DELETE FROM omni_threads WHERE id = ${records[1][0]}`;
    expect((await asOwner(() => searchOwnedThreadsPage({ ...owner, query: "Report", limit: 8, after: first.next! }))).items).toEqual([]);
  });

  async function seedMemory(id: string, actor = canonicalActorId, tier = "semantic") {
    const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId: owner.tenantId, ownerActorId: actor, originPurpose: "search.fixture" });
    await admin`INSERT INTO omni_memories (
      id, tenant_id, type, title, content, scope, source, tier, access_contract_version, access_state,
      owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity,
      origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at
    ) VALUES (${id}, ${owner.tenantId}, 'fact', 'Report memory', 'Synthetic report', 'user', 'manual', ${tier}, 1, 'scope_bound',
      ${actor}, NULL, NULL, NULL, NULL, 'user_private', ${binding.sensitivity}, ${binding.originPurpose},
      ${[...binding.allowedPurposeIds]}, ${binding.accessScopeSha256}, ${binding.accessBoundAt})`;
  }
  test("private memory excludes legacy, foreign, expired, archived and working rows; exact open uses the same boundary", async () => {
    await seedMemory("search-memory-visible"); await seedMemory("search-memory-visible-next");
    await seedMemory("search-memory-other", "actor:22222222-2222-4222-8222-222222222222");
    await seedMemory("search-memory-working", canonicalActorId, "working"); await seedMemory("search-memory-expired"); await seedMemory("search-memory-archived");
    await admin`INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source) VALUES ('search-memory-legacy', ${owner.tenantId}, 'fact', 'Report legacy', 'Report legacy body', 'user', 'manual')`;
    await admin`UPDATE omni_memories SET retention_expires_at = NOW() - interval '1 day' WHERE id = 'search-memory-expired'`;
    await admin`INSERT INTO omni_memory_lifecycle_states (memory_id, tenant_id, access_contract_version, owner_actor_id, archived_at, archive_reason)
      VALUES ('search-memory-archived', ${owner.tenantId}, 1, ${canonicalActorId}, NOW(), 'manual')`;
    await admin`UPDATE omni_memories SET updated_at = '2026-10-04T00:00:00.123456Z' WHERE tenant_id = ${owner.tenantId}`;
    const input = { tenantId: owner.tenantId, accessScope: access.databaseAccessScope, query: "Report", limit: 20 };
    expect((await asOwner(() => searchPrivateMemoryPage(input))).items.map((item) => item.id)).toEqual(["search-memory-visible", "search-memory-visible-next"]);
    const first = await asOwner(() => searchPrivateMemoryPage({ ...input, limit: 1 }));
    expect(first.next?.updatedAt).toBe("2026-10-04T00:00:00.123456Z");
    const second = await asOwner(() => searchPrivateMemoryPage({ ...input, limit: 1, after: first.next! }));
    expect(second.items.map((item) => item.id)).toEqual(["search-memory-visible-next"]);
    expect(second.next).toBeNull();
    for (const id of ["search-memory-legacy", "search-memory-other", "search-memory-working", "search-memory-expired", "search-memory-archived"]) {
      expect(await asOwner(() => getPrivateSearchMemory({ ...input, id }))).toBeNull();
    }
    expect((await asOwner(() => getPrivateSearchMemory({ ...input, id: "search-memory-visible" })))?.id).toBe("search-memory-visible");
  });

  test("Work rechecks active mappings and owner membership and opens tasks independently of list windows", async () => {
    const [timestamp] = await admin`SELECT to_char((date_trunc('second', NOW() + interval '1 hour') + interval '0.123456 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`;
    const tiedUpdatedAt = String(timestamp.value);
    await admin`UPDATE omni_work_projects SET updated_at = ${tiedUpdatedAt}::text::timestamptz, lifecycle_revision = lifecycle_revision + 1 WHERE tenant_id = ${owner.tenantId}`;
    await admin`UPDATE omni_work_items SET updated_at = ${tiedUpdatedAt}::text::timestamptz, status_revision = status_revision + 1 WHERE tenant_id = ${owner.tenantId}`;
    const matches = await asOwner(() => searchOwnedWorkPage({ ...owner, query: "Report", limit: 20 }));
    expect(matches.items.filter((item) => item.projectId === project.id)).toHaveLength(3);
    const first = await asOwner(() => searchOwnedWorkPage({ ...owner, query: "Report", limit: 1 }));
    expect(first.next?.updatedAt).toBe(tiedUpdatedAt);
    const rest = await asOwner(() => searchOwnedWorkPage({ ...owner, query: "Report", limit: 20, after: first.next! }));
    expect([...first.items, ...rest.items].map((item) => item.id)).toEqual(matches.items.map((item) => item.id));
    expect(rest.next).toBeNull();
    expect(await asOwner(() => getOwnedProjectTask("wrong-parent", tasks[1].id, owner))).toBeNull();
    expect((await asOwner(() => getOwnedProjectTask(project.id, tasks[1].id, owner)))?.id).toBe(tasks[1].id);
    expect(await asOwner(() => getOwnedProjectTask(project.id, tasks[1].id, { ...owner, actorId: "foreign@example.test", requestActorBinding: undefined }))).toBeNull();
    const canonicalProject = await admin`SELECT project_id, workspace_id FROM omni_work_projects WHERE tenant_id = ${owner.tenantId} AND source_id = ${project.id}`;
    // Administrator fixture models a previously authorized membership becoming revoked.
    await admin`UPDATE omni_work_project_memberships SET state = 'revoked', membership_revision = membership_revision + 1, updated_at = NOW()
      WHERE tenant_id = ${owner.tenantId} AND project_id = ${canonicalProject[0].project_id} AND subject_actor_id = ${canonicalActorId}`;
    expect((await asOwner(() => searchOwnedWorkPage({ ...owner, query: "Report", limit: 20 }))).items).toEqual([]);
    expect(await asOwner(() => resolveOwnedSearchWork({ ...owner, projectId: project.id, taskId: tasks[1].id }))).toBeNull();
  });

  test("Library authority filtering and deletion happen before pagination", async () => {
    for (const [id, actor] of [["search-capture-own", canonicalActorId], ["search-capture-foreign", "foreign@example.test"]]) await admin`
      INSERT INTO omni_capture_assets (id, tenant_id, actor_id, filename, media_type, byte_count, content_sha256, content)
      VALUES (${id}, ${owner.tenantId}, ${actor}, 'Report.txt', 'text/plain', 4, ${"a".repeat(64)}, decode('74657374', 'hex'))`;
    const query = { ...owner, query: "Report", limit: 1, sourceAuthorities: ["capture_asset"] as const };
    expect((await asOwner(() => listWorkspaceLibrary(query))).items.map((item) => item.id)).toEqual(["library:capture_asset:search-capture-own"]);
    expect((await asOwner(() => listWorkspaceLibrary({ ...query, sourceAuthorities: [] }))).items).toEqual([]);
    await admin`DELETE FROM omni_capture_assets WHERE id = 'search-capture-own'`;
    expect((await asOwner(() => listWorkspaceLibrary(query))).items).toEqual([]);
  });
});
