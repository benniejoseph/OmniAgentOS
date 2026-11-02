import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const databaseUrl = process.env.ASSISTANT_LOCAL_DATABASE_URL;
const isolated = databaseUrl ? describe : describe.skip;
const tenant = `local-project-${randomUUID()}`, user = randomUUID(), actor = `actor:${user}`;
const sessionId = randomUUID(), deviceId = randomUUID(), runId = randomUUID();
const correlationId = `project-request-${randomUUID()}`, role = `local_project_${randomBytes(6).toString("hex")}`;
const first = `local_workspace_${"1".repeat(32)}`, other = `local_workspace_${"2".repeat(32)}`;
const scope = createExecutionScope({ tenantId: tenant, initiatingActorId: actor,
  executingPrincipalType: "user", executingPrincipalId: actor, correlationId, purpose: "local_project.validation" });
const context: SecurityContext = { tenantId: tenant, actorId: actor, role: "admin", source: "mobile",
  auth: { userId: user, email: `${user}@example.test`, sessionId, tenantName: "Local project fixture" },
  native: { deviceId, platform: "macos", clientContractVersion: 64 } };

isolated("selected Mac folder in real PostgreSQL", () => {
  let admin: ReturnType<typeof postgres>;
  let db: typeof import("@/lib/db/client");
  let store: typeof import("@/lib/local-computer/store");
  const owned = <T,>(operation: () => Promise<T>) => db.runWithDatabaseActorScope(tenant, [actor], operation);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/asael_agents_candidate") {
      throw new Error("Use the isolated loopback candidate database only.");
    }
    admin = postgres(databaseUrl!, { ssl: false, max: 1, onnotice: () => {} });
    expect((await admin`SELECT max(version)::integer AS version FROM omni_schema_version`)[0].version).toBe(267);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},${`${user}@example.test`},'isolated-no-login')`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenant},'Local project fixture',${tenant})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${randomUUID()},${tenant},${user},'admin')`;
    await admin`INSERT INTO omni_mobile_sessions
      (id,family_id,user_id,tenant_id,device_id,device_name,platform,app_version,
       access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at,client_contract_version,client_attested_at,app_build_number)
      VALUES (${sessionId},${randomUUID()},${user},${tenant},${deviceId},'Fixture Mac','macos','1.44.0',
        ${randomBytes(32).toString("hex")},${randomBytes(32).toString("hex")},NOW()+INTERVAL '1 hour',NOW()+INTERVAL '1 day',64,NOW(),123)`;
    await admin`INSERT INTO omni_local_computer_devices
      (tenant_id,owner_actor_id,user_id,mobile_session_id,device_id,platform,native_contract_version,enabled,
       helper_version,permission_status,command_runner,activity_state,lifecycle_revision,last_seen_at,lease_expires_at,created_at,updated_at)
      VALUES (${tenant},${actor},${user},${sessionId},${deviceId},'macos',64,true,'1.0.0',
        ${admin.json({ accessibility: "not_granted", screenRecording: "not_granted" })},
        ${admin.json({ helperInstalled: true, helperVersion: "1.0.0", workspaces: [{ id: first, name: "Selected" }, { id: other, name: "Other" }] })},
        'idle',1,NOW(),NOW()+INTERVAL '29 seconds',NOW(),NOW())`;
    await admin`INSERT INTO omni_agent_runs(id,tenant_id,owner_actor_id,mode,status,prompt)
      VALUES (${runId},${tenant},${actor},'coding','running','Inspect the selected project')`;
    url.username = role; url.password = password; url.searchParams.set("sslmode", "require");
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", "local-project-isolated-fixture-secret-2026");
    db = await import("@/lib/db/client"); store = await import("@/lib/local-computer/store");
    const events = await import("@/lib/events/store");
    await owned(() => events.appendScopedDomainEvent({ id: randomUUID(), streamId: `run:${runId}`,
      type: "run.scope_bound", executionScope: scope, payload: { schemaVersion: 1 } }));
    expect(await owned(async () => (await db.getSql()`SELECT rolsuper,rolbypassrls,
      row_security_active('omni_local_computer_sessions') AS active FROM pg_roles WHERE rolname=current_user`)[0]))
      .toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
  });

  afterAll(async () => {
    await db?.closeDatabaseClient();
    if (admin) {
      await admin.unsafe(`DROP OWNED BY ${role}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  it("keeps the selected folder immutable through retries and command dispatch", async () => {
    const selected = await owned(() => store.startLocalComputerSession(context, correlationId, "local_macos", first));
    expect(selected.workspaces).toEqual([{ id: first, name: "Selected" }]);
    expect((await owned(() => store.startLocalComputerSession(context, correlationId, "local_macos", first))).id).toBe(selected.id);
    await expect(owned(() => store.startLocalComputerSession(context, correlationId, "local_macos", other))).rejects.toThrow();
    const executionId = `local-project-execution-${randomUUID()}`;
    const command = { action: "run_command" as const, executionId, runId, executionScope: scope,
      toolInput: { workspaceId: other, executable: "git", arguments: ["status", "--short"], relativeDirectory: ".", timeoutSeconds: 5 } };
    await expect(owned(() => store.executeLocalComputerCommand(command))).rejects.toThrow(/selected device session/);
    expect(await admin`SELECT id FROM omni_local_computer_commands WHERE tenant_id=${tenant}`).toHaveLength(0);
    // Stop after admission: this scenario verifies the real SQL boundary and
    // never claims to execute a command on a physical Mac.
    const abort = new AbortController(); abort.abort(new Error("fixture-admission-complete"));
    await expect(owned(() => store.executeLocalComputerCommand({ ...command,
      toolInput: { ...command.toolInput, workspaceId: first }, abortSignal: abort.signal,
    }))).rejects.toThrow("fixture-admission-complete");
    expect(await admin`SELECT session_id,state FROM omni_local_computer_commands WHERE tenant_id=${tenant}`)
      .toEqual([expect.objectContaining({ session_id: selected.id, state: "queued" })]);
    expect(await admin`SELECT id FROM omni_events WHERE tenant_id=${tenant} AND type='local_computer.workspace.bound'`).toHaveLength(1);
    await expect(db.runWithDatabaseActorScope(tenant, ["other-actor"], () => store.startLocalComputerSession(
      { ...context, actorId: "other-actor" }, `foreign-${correlationId}`, "local_macos", first,
    ))).rejects.toThrow();
  });
});
