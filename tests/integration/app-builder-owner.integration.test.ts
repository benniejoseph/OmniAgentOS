/** Runtime PostgreSQL/RLS and real service ownership; only the paid Sandbox is stubbed. */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProjectBuilderService } from "@/lib/app-services/app-builder";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService } from "@/lib/app-services/projects";
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const setup = vi.hoisted(() => ({ serving: false, provision: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
vi.mock("@/lib/app-builder/sandbox", () => ({ createBuilderSandbox: setup.provision, builderSandboxExists: async () => true, getBuilderPreviewUrl: async () => null }));
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `builder-owner-candidate-${randomUUID()}`;
const actors = [randomUUID(), randomUUID()].map((userId) => ({ userId, email: `${userId}@example.test`, canonicalId: `actor:${userId}` }));
const role = `builder_owner_${randomBytes(6).toString("hex")}`;
const context = (actor: typeof actors[number]): SecurityContext => ({ tenantId, actorId: actor.email, source: "session", role: "operator",
  auth: { userId: actor.userId, email: actor.email, sessionId: "isolated-no-login", tenantName: "Builder owner candidate" } });
const scoped = <T>(actor: typeof actors[number], run: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.canonicalId, actor.email], run);
const serviceCaller = (actor: typeof actors[number], projectId: string, withBinding = true) => createAppServiceCaller({
  context: { tenantId, actorId: actor.canonicalId, source: "service", role: "operator" },
  requestActorBinding: withBinding ? canonicalRequestActorBindingFromSecurityContext(context(actor)) : undefined,
  executionScope: createExecutionScope({ tenantId, initiatingActorId: actor.canonicalId, executingPrincipalType: "agent",
    executingPrincipalId: "atlas", projectId, correlationId: `builder-owner:${projectId}`, purpose: "self_improvement.cycle.v1" }),
  idempotencyKey: `builder-owner:${projectId}`,
});

candidate("Builder canonical service owner PostgreSQL regression", () => {
  let admin: ReturnType<typeof postgres>;
  const projectIds: string[] = [];
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the disposable candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the disposable loopback candidate database is allowed.");
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(264);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects,omni_app_builder_sessions,omni_app_builder_events TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_app_builder_checkpoints,omni_app_builder_verifications TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Builder owner candidate',${tenantId})`;
    for (const actor of actors) {
      await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${actor.userId},${actor.email},'synthetic-no-login')`;
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${actor.userId},'admin')`;
    }
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4"); setup.serving = true;
    setup.provision.mockResolvedValue({ previewUrl: null, install: { exitCode: 0, durationMs: 0, skipped: true } });
    for (let index = 0; index < 3; index++) {
      const actor = actors[index === 2 ? 1 : 0];
      await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
      const caller = createRequestMutationAppServiceCaller(new Request("https://fixture.invalid/api/projects", {
        method: "POST", headers: { "Idempotency-Key": `builder-owner-project-${index}` },
      }), context(actor), { purpose: "app.projects.create" });
      const created = await scoped(actor, () => createProjectService(caller, { title: "Synthetic Builder owner", objective: "Verify exact owner alias without provider calls." }));
      projectIds.push(created.data.project.id);
      expect((await admin`SELECT actor_id FROM omni_projects WHERE id=${created.data.project.id}`)[0].actor_id).toBe(actor.email);
    }
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it("opens an email-owned project for its canonical service owner and retains canonical session receipts", async () => {
    const actor = actors[0], projectId = projectIds[0], caller = serviceCaller(actor, projectId);
    expect(await scoped(actor, async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_app_builder_sessions') AS active FROM pg_roles WHERE rolname=current_user`)[0]))
      .toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    const result = await scoped(actor, () => createProjectBuilderService(caller, { projectId, workspaceMode: "source_only" }));
    expect(result.data).toMatchObject({ created: true, session: { status: "ready", projectId } });
    expect(setup.provision).toHaveBeenCalledWith(expect.objectContaining({ tenantId, ownerActorId: actor.canonicalId, projectId, workspaceMode: "source_only" }));
    const rows = await admin`SELECT owner_actor_id FROM omni_app_builder_sessions WHERE tenant_id=${tenantId} AND project_id=${projectId}`;
    expect(rows).toHaveLength(1); expect(rows[0].owner_actor_id).toBe(actor.canonicalId);
    const events = await admin`SELECT owner_actor_id,event_type FROM omni_app_builder_events WHERE tenant_id=${tenantId} AND session_id=${result.data.session.id}`;
    expect(events.map((event) => event.event_type).sort()).toEqual(["app_builder.session.provisioning_started", "app_builder.session.ready"]);
    expect(events.every((event) => event.owner_actor_id === actor.canonicalId)).toBe(true);
    const replay = await scoped(actor, () => createProjectBuilderService(caller, { projectId, workspaceMode: "source_only" }));
    expect(replay.data.created).toBe(false); expect(replay.data.session.id).toBe(result.data.session.id);
    expect(setup.provision).toHaveBeenCalledTimes(1);
  });
  it("rejects a missing alias binding before any session or provider effect", async () => {
    const actor = actors[0], projectId = projectIds[1], calls = setup.provision.mock.calls.length;
    await expect(scoped(actor, () => createProjectBuilderService(serviceCaller(actor, projectId, false), { projectId, workspaceMode: "source_only" })))
      .rejects.toThrow("Project was not found.");
    expect(await admin`SELECT id FROM omni_app_builder_sessions WHERE tenant_id=${tenantId} AND project_id=${projectId}`).toHaveLength(0);
    expect(setup.provision).toHaveBeenCalledTimes(calls);
  });
  it("rejects another owner's project despite a valid binding for the caller", async () => {
    const actor = actors[0], projectId = projectIds[2], calls = setup.provision.mock.calls.length;
    await expect(scoped(actor, () => createProjectBuilderService(serviceCaller(actor, projectId), { projectId, workspaceMode: "source_only" })))
      .rejects.toThrow("Project was not found.");
    expect(await admin`SELECT id FROM omni_app_builder_sessions WHERE tenant_id=${tenantId} AND project_id=${projectId}`).toHaveLength(0);
    expect(setup.provision).toHaveBeenCalledTimes(calls);
  });
  it("preserves ordinary signed-in email-owned Builder sessions", async () => {
    const actor = actors[1], projectId = projectIds[2];
    const caller = createRequestMutationAppServiceCaller(new Request("https://fixture.invalid/api/projects/builder", {
      method: "POST", headers: { "Idempotency-Key": "interactive-builder-owner" },
    }), context(actor), { purpose: "app.projects.builder.create", projectId });
    const result = await scoped(actor, () => createProjectBuilderService(caller, { projectId }));
    expect(result.data).toMatchObject({ created: true, session: { status: "ready" } });
    expect(setup.provision).toHaveBeenLastCalledWith(expect.objectContaining({ ownerActorId: actor.email, workspaceMode: "interactive" }));
    expect((await admin`SELECT owner_actor_id FROM omni_app_builder_sessions WHERE id=${result.data.session.id}`)[0].owner_actor_id).toBe(actor.email);
  });
});
