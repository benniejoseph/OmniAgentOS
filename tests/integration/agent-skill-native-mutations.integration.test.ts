import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildAgentSkillNativeIntent, type AgentSkillNativeRequest, type AgentSkillNativeScope } from "@/lib/skills/native-mutation-contracts";
import { readAgentSkillNativeAcceptance, reviewAgentSkillNativeMutation, submitAgentSkillNativeMutation } from "@/lib/skills/native-mutation-store";
import { catalogRequest } from "@/lib/skills/native-mutation.test-fixtures";
import { customAgentInputSchema } from "@/lib/skills/schema";
import { createCustomAgent } from "@/lib/skills/store";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "catalog-owner@example.test", other = "catalog-other@example.test", canonical = `actor:${user}`, roleName = "catalog_native_test_runtime";

// Disposable opt-in database. Only setup/rollback witnesses use admin. Stores
// use a real non-bypass login and their own production transaction boundaries.
integration("native catalog atomic acceptance under forced serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Explicit legacy grants model serving provisioning on an empty bootstrap.
    // The new acceptance table must inherit migration229's SELECT/INSERT only.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,
      omni_agent_runs,omni_tool_executions,omni_agent_release_evaluations,omni_plugin_installations,omni_moltbook_connections,
      omni_tenant_workspaces,omni_tenant_workspace_memberships TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_custom_skills,omni_custom_agents TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events,omni_agent_definition_versions,omni_agent_principal_policies,omni_trash_items,omni_trash_effect_receipts TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_tenant_execution_principals,omni_agent_release_channels TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},${owner},'fixture-only'),(${otherUser},${other},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", ""); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("catalog-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_agent_skill_native_mutations') AS active,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS identity_table_read,
      has_function_privilege(current_user,'public.omni_agent_persona_v1_is_valid(jsonb)','EXECUTE') AS persona_check
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true, persona_check: true, identity_table_read: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); }
  });
  async function fixture(tag: string): Promise<AgentSkillNativeScope> {
    const tenantId = `catalog-native-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${tenantId},${id},'operator')`;
    return { tenantId, ownerActorId: owner, canonicalActorId: canonical };
  }
  function submit(scope: AgentSkillNativeScope, request: AgentSkillNativeRequest = catalogRequest, key = "catalog-create") {
    const create = request.contract === "asael-skill-create:1", operation = create ? "skill.create" : request.review.operation;
    const purpose = operation === "agent.delete" ? "agent.move_to_trash" : operation === "skill.delete" ? "skill.move_to_trash" : operation;
    const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId,
      executingPrincipalType: "user", executingPrincipalId: scope.ownerActorId, correlationId: key,
      causationId: create ? "skills:create" : request.review.resourceId, purpose });
    return submitAgentSkillNativeMutation({ authority: { scope, executionScope }, idempotencyKey: key, request });
  }
  const review = (scope: AgentSkillNativeScope, resourceId: string, operation: "agent.delete" | "skill.update" | "skill.delete") =>
    reviewAgentSkillNativeMutation({ scope }, { resourceId, operation });
  const count = async (scope: AgentSkillNativeScope) => (await admin`SELECT
    (SELECT count(*)::INTEGER FROM omni_custom_skills WHERE tenant_id=${scope.tenantId}) AS skills,
    (SELECT count(*)::INTEGER FROM omni_agent_skill_native_mutations WHERE tenant_id=${scope.tenantId}) AS accepted,
    (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${scope.tenantId} AND type='agent_skill.native_mutation.accepted') AS events,
    (SELECT count(*)::INTEGER FROM omni_trash_items WHERE tenant_id=${scope.tenantId}) AS trash,
    (SELECT count(*)::INTEGER FROM omni_trash_effect_receipts WHERE tenant_id=${scope.tenantId}) AS trash_receipts`)[0];

  test("same-key overlap creates one Skill and immutable acceptance; changed intent conflicts", async () => {
    const scope = await fixture("replay"), results = await Promise.all([submit(scope), submit(scope)]);
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]); expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(await count(scope)).toMatchObject({ skills: 1, accepted: 1, events: 1, trash: 0 });
    await expect(submit(scope, { ...catalogRequest, skill: { ...catalogRequest.skill, name: "Changed Skill" } })).rejects.toMatchObject({ status: 409 });
    expect(await readAgentSkillNativeAcceptance({ scope }, { keySha256: results[0].acceptance.keySha256, resourceType: "agent_skill" })).toEqual(results[0].acceptance);
  });
  test("review CAS refuses stale changes while accepted replay survives later revisions and deletion", async () => {
    const scope = await fixture("review"), created = await submit(scope), id = created.acceptance.resourceId;
    const first = await review(scope, id, "skill.update");
    const request: AgentSkillNativeRequest = { contract: "asael-skill-update:1", review: first.pin, change: { description: "Reviewed description" } };
    const updated = await submit(scope, request, "update-one"); expect(updated.acceptance.afterVersion).toBe(2);
    await expect(submit(scope, request, "stale-new-key")).rejects.toMatchObject({ status: 409 });
    const deletion = await review(scope, id, "skill.delete");
    const deleted = await submit(scope, { contract: "asael-agent-skill-delete:1", review: deletion.pin, preview: deletion.preview! }, "delete-one");
    expect(deleted.acceptance.trash?.compensation).toBe("exact_restore");
    expect(await submit(scope, request, "update-one")).toEqual({ acceptance: updated.acceptance, replayed: true });
    expect(await count(scope)).toMatchObject({ skills: 0, accepted: 3, events: 3, trash: 1, trash_receipts: 1 });
  });
  test("event failure rolls back creation and later deletion plus its Trash graph", async () => {
    const scope = await fixture("rollback");
    await admin`CREATE FUNCTION catalog_native_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='catalog-native-rollback' AND NEW.type='agent_skill.native_mutation.accepted' THEN RAISE EXCEPTION 'fixture catalog event failure'; END IF; RETURN NEW; END $$`;
    const enable = () => admin`CREATE TRIGGER catalog_native_fixture_event_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION catalog_native_fixture_event_failure()`;
    const disable = () => admin`DROP TRIGGER catalog_native_fixture_event_failure ON omni_events`;
    await enable();
    try { await expect(submit(scope)).rejects.toMatchObject({ code: "P0001" }); expect(await count(scope)).toMatchObject({ skills: 0, accepted: 0, events: 0 }); }
    finally { await disable(); }
    const created = await submit(scope), deletion = await review(scope, created.acceptance.resourceId, "skill.delete"); await enable();
    try {
      await expect(submit(scope, { contract: "asael-agent-skill-delete:1", review: deletion.pin, preview: deletion.preview! }, "delete")).rejects.toMatchObject({ code: "P0001" });
      expect(await count(scope)).toMatchObject({ skills: 1, accepted: 1, events: 1, trash: 0, trash_receipts: 0 });
    } finally { await disable(); await admin`DROP FUNCTION catalog_native_fixture_event_failure()`; }
  });
  test("exact owner/canonical binding and forced RLS exclude other and actor-free callers", async () => {
    const scope = await fixture("owner"), accepted = await submit(scope), keySha256 = accepted.acceptance.keySha256;
    const otherScope = { ...scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` };
    expect(await readAgentSkillNativeAcceptance({ scope: otherScope }, { keySha256, resourceType: "agent_skill" })).toBeNull();
    await expect(readAgentSkillNativeAcceptance({ scope: { ...scope, canonicalActorId: otherScope.canonicalActorId } }, { keySha256, resourceType: "agent_skill" })).rejects.toMatchObject({ status: 403 });
    expect(await runWithDatabaseTenantScope(scope.tenantId, () => getSql()`SELECT acceptance FROM omni_agent_skill_native_mutations WHERE tenant_id=${scope.tenantId}`)).toEqual([]);
    expect(await runWithDatabaseActorScope(scope.tenantId, [other], () => getSql()`SELECT acceptance FROM omni_agent_skill_native_mutations WHERE tenant_id=${scope.tenantId}`)).toEqual([]);
    await expect(runWithDatabaseActorScope(scope.tenantId, [owner], () => getSql()`DELETE FROM omni_agent_skill_native_mutations WHERE tenant_id=${scope.tenantId}`)).rejects.toMatchObject({ code: "42501" });
    const intent = buildAgentSkillNativeIntent({ scope, request: catalogRequest, idempotencyKey: "catalog-create" }); expect(intent.keySha256).toBe(keySha256);
    await admin`UPDATE omni_auth_memberships SET role='viewer' WHERE tenant_id=${scope.tenantId} AND user_id=${user}`;
    expect(await readAgentSkillNativeAcceptance({ scope }, { keySha256, resourceType: "agent_skill" })).toEqual(accepted.acceptance);
    await expect(review(scope, accepted.acceptance.resourceId, "skill.update")).rejects.toMatchObject({ status: 403 });
    await expect(submit(scope)).rejects.toMatchObject({ status: 403 });
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${scope.tenantId} AND user_id=${user}`;
    await expect(readAgentSkillNativeAcceptance({ scope }, { keySha256, resourceType: "agent_skill" })).rejects.toMatchObject({ status: 403 });
  });
  test("Agent deletion retains reviewed identity retirement and exact equivalent-restore evidence", async () => {
    const scope = await fixture("agent");
    const agent = await runWithDatabaseActorScope(scope.tenantId, [owner, canonical], () => createCustomAgent(customAgentInputSchema.parse({
      name: "Reviewed Agent", role: "Review assistant", description: "A deterministic fixture Agent.", instructions: "Review the provided notes with clear citations.",
    }), { tenantId: scope.tenantId, actorId: owner }));
    const current = await review(scope, agent.id, "agent.delete"); expect(current.agentLifecycle?.releaseState).toBe("active");
    const request: AgentSkillNativeRequest = { contract: "asael-agent-skill-delete:1", review: current.pin, preview: current.preview! };
    const deleted = await submit(scope, request, "agent-delete"); expect(deleted.acceptance.trash?.compensation).toBe("equivalent_action");
    expect(await submit(scope, request, "agent-delete")).toEqual({ acceptance: deleted.acceptance, replayed: true });
    expect(await admin`SELECT id FROM omni_custom_agents WHERE tenant_id=${scope.tenantId} AND id=${agent.id}`).toEqual([]);
    expect((await admin`SELECT state FROM omni_agent_release_channels WHERE tenant_id=${scope.tenantId} AND agent_definition_id=${agent.id}`)[0].state).toBe("retired");
    expect((await admin`SELECT state FROM omni_tenant_execution_principals WHERE tenant_id=${scope.tenantId} AND agent_definition_id=${agent.id}`)[0].state).toBe("revoked");
    expect(await readAgentSkillNativeAcceptance({ scope }, { keySha256: deleted.acceptance.keySha256, resourceType: "custom_agent" })).toEqual(deleted.acceptance);
  });
  test("Moltbook parent locking remains invoker authority and protects every identity rebind", async () => {
    const [lock] = await admin`SELECT p.prosecdef,pg_get_functiondef(p.oid) AS body,pg_get_triggerdef(t.oid) AS trigger
      FROM pg_proc p JOIN pg_trigger t ON t.tgfoid=p.oid WHERE p.proname='omni_lock_moltbook_agent_parent_v1'`;
    expect(lock.prosecdef).toBe(false); expect(lock.body).toContain("FOR KEY SHARE");
    for (const field of ["tenant_id", "owner_actor_id", "agent_id", "principal_id", "principal_generation", "principal_sha256", "definition_version", "definition_sha256", "policy_boundary_sha256"]) expect(lock.trigger).toContain(field);
  });
});
