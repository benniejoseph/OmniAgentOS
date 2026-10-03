import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import type { SqlClient } from "@/lib/db/sql-types";
import { buildUserPrivateMemoryAccessBindingV1, buildWorkspaceSharedMemoryAccessBindingV1, MEMORY_PURPOSE_IDS, type MemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { readOwnedResponsibilityProcedures } from "@/lib/responsibilities/procedure-reference";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { SAVED_PROCEDURE_V1_TAG } from "@/lib/workflows/saved-procedures";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const owner = { tenantId: "responsibility-procedure-lock", actorId: "actor:11111111-1111-4111-8111-111111111111" };
const content = JSON.stringify({ schemaVersion: 1, id: "observe-native-meeting", aliases: ["Observe native meeting"],
  toolBindings: [{ toolId: "app.meetings.show", input: { workspaceId: "workspace:fixture", meetingId: "meeting:fixture" } }] });

// Serving-role proof: SELECT FOR UPDATE/SHARE requires the UPDATE USING lane,
// but must never confer UPDATE WITH CHECK authority. Run against a disposable
// database only; this fixture sends no tool/provider/Calendar effect.
databaseDescribe("Responsibility private procedure locking under serving RLS", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    // Placeholder roles created by migrations do not receive legacy table
    // grants. Reproduce a provisioned serving reader/writer in this fixture.
    await admin`GRANT SELECT, UPDATE ON omni_memories, omni_memory_lifecycle_states TO omni_runtime`;
    const own = buildUserPrivateMemoryAccessBindingV1({ ...owner, ownerActorId: owner.actorId, originPurpose: "responsibility.fixture" });
    await seed("procedure-private", own);
    await seed("procedure-archived", own);
    await seed("procedure-foreign", buildUserPrivateMemoryAccessBindingV1({ ...owner, ownerActorId: "actor:22222222-2222-4222-8222-222222222222", originPurpose: "responsibility.fixture" }));
    await seed("procedure-other-tenant", buildUserPrivateMemoryAccessBindingV1({ tenantId: "other-tenant", ownerActorId: owner.actorId, originPurpose: "responsibility.fixture" }));
    await seed("procedure-shared", buildWorkspaceSharedMemoryAccessBindingV1({ ...owner, ownerActorId: owner.actorId, workspaceId: "workspace:fixture", originPurpose: "responsibility.fixture" }));
    await admin`INSERT INTO omni_memories (id,tenant_id,type,title,content,tags,scope,source)
      VALUES ('procedure-legacy',${owner.tenantId},'procedure','Legacy procedure',${content},${[SAVED_PROCEDURE_V1_TAG]},'workspace','manual')`;
    await admin`INSERT INTO omni_memory_lifecycle_states (memory_id,tenant_id,access_contract_version,owner_actor_id,archived_at,archive_reason)
      VALUES ('procedure-private',${owner.tenantId},1,${owner.actorId},NULL,NULL),
        ('procedure-archived',${owner.tenantId},1,${owner.actorId},statement_timestamp(),'manual')`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); });

  async function seed(id: string, binding: MemoryAccessBindingV1) {
    await admin`INSERT INTO omni_memories (id,tenant_id,type,title,content,tags,scope,source,
      access_contract_version,access_state,owner_actor_id,owner_agent_id,workspace_id,project_id,mission_id,visibility,sensitivity,
      origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES (${id},${binding.tenantId},'procedure','Stored procedure',${content},${[SAVED_PROCEDURE_V1_TAG]},'workspace','manual',
        1,'scope_bound',${binding.ownerActorId},${binding.ownerAgentId},${binding.workspaceId},${binding.projectId},${binding.missionId},${binding.visibility},${binding.sensitivity},
        ${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
  }
  function serving<T>(work: (sql: SqlClient) => Promise<T>) {
    return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], () => getSql().transaction(async (sql: SqlClient) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      expect((await sql`SELECT current_user AS role`)[0].role).toBe("omni_runtime");
      return work(sql);
    }) as Promise<T>);
  }
  async function install(sql: SqlClient, purposeId: string) {
    return setTransactionLocalDatabaseMemoryAccessScope(sql, databaseMemoryAccessScopeFromExecutionScope(createExecutionScope({
      ...owner, initiatingActorId: owner.actorId, executingPrincipalType: "user", executingPrincipalId: owner.actorId,
      correlationId: "procedure-lock-fixture", purpose: "responsibility.procedure.read.v1",
    }), { purposeId, auditPurpose: "Verify exact private procedure row locking." }));
  }

  test("reads only the exact private unarchived procedure and clears temporary scope", async () => {
    await serving(async (sql) => {
      const result = await readOwnedResponsibilityProcedures(sql, owner, { lock: false, now: new Date().toISOString() });
      expect(result.map((row) => row.sourceMemoryId)).toEqual(["procedure-private"]);
      expect((await sql`SELECT NULLIF(current_setting('omni.memory_access_scope_v1',true),'') AS scope`)[0].scope).toBeNull();
    });
  });

  test("locks exact private memory and archival rows without hiding their read-visible state", async () => {
    await serving(async (sql) => {
      await install(sql, MEMORY_PURPOSE_IDS.read);
      const visible = await sql`SELECT id FROM omni_memories ORDER BY id`;
      expect(visible.map((row) => row.id)).toEqual(["procedure-archived", "procedure-private"]);
      const locked = await sql`SELECT id FROM omni_memories ORDER BY id FOR UPDATE`;
      expect(locked.map((row) => row.id)).toEqual(visible.map((row) => row.id));
      const lifecycle = await sql`SELECT memory_id,archived_at FROM omni_memory_lifecycle_states ORDER BY memory_id FOR SHARE`;
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0].archived_at).not.toBeNull();
      expect(lifecycle[1].archived_at).toBeNull();
    });
    await serving(async (sql) => {
      expect((await readOwnedResponsibilityProcedures(sql, owner, { lock: true, now: new Date().toISOString() })).map((row) => row.sourceMemoryId)).toEqual(["procedure-private"]);
      expect((await sql`SELECT NULLIF(current_setting('omni.memory_access_scope_v1',true),'') AS scope`)[0].scope).toBeNull();
    });
  });

  test("read purpose cannot update even the same value in either locked table", async () => {
    for (const update of [
      (sql: SqlClient) => sql`UPDATE omni_memories SET title = title WHERE id = 'procedure-private' RETURNING id`,
      (sql: SqlClient) => sql`UPDATE omni_memory_lifecycle_states SET updated_at = updated_at WHERE memory_id = 'procedure-private' RETURNING memory_id`,
    ]) {
      await expect(serving(async (sql) => { await install(sql, MEMORY_PURPOSE_IDS.read); return update(sql); })).rejects.toMatchObject({ code: "42501" });
    }
  });

  test("existing write, correction and forget purpose UPDATE paths retain their authority", async () => {
    for (const purpose of [MEMORY_PURPOSE_IDS.write, MEMORY_PURPOSE_IDS.correct, MEMORY_PURPOSE_IDS.forget]) {
      await serving(async (sql) => {
        await install(sql, purpose);
        expect(await sql`UPDATE omni_memories SET title = title WHERE id = 'procedure-private' RETURNING id`).toEqual([{ id: "procedure-private" }]);
      });
    }
  });
});
