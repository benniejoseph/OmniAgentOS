import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_MODES } from "@/lib/orchestration/modes";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sealJsonPayload } from "@/lib/security/sealed-payload";

// Only provider/identity selection is deterministic here. Storage, sealing,
// migrations, domain events, replay protection and PostgreSQL RLS are real.
vi.mock("@/lib/agents/identity-store", () => ({ resolveAgentIdentityForExecution: async () => ({
  definition: { logicalAgentId: "atlas", definitionId: "definition:atlas", definitionVersion: 1,
    definitionVersionId: "definition:atlas:v1", definitionSha256: "d".repeat(64), modelPolicy: {} },
  principal: { principalId: "principal:atlas", principalGeneration: 1,
    principalVersionId: "principal:atlas:v1", principalSha256: "e".repeat(64) },
}) }));
vi.mock("@/lib/models/deployment-route", () => ({ selectAgentModel: () => ({
  provider: "openai", model: "fixture-model", fallbackModel: "fixture-model", reason: "fixture", tier: "reasoning",
}) }));
vi.mock("@/lib/settings/runtime-models", () => ({ resolveRuntimeModelAssignment: async () => ({
  configured: true, provider: "openai", model: "fixture-model", scope: "agent:atlas:standard", source: "deployment_environment",
}) }));

const databaseUrl = process.env.ASSISTANT_MODES_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const tenantId = `assistant-modes-${randomUUID()}`;
const userId = randomUUID(), actorId = `actor:${userId}`;
const legacyId = randomUUID(), runtimeRole = `assistant_modes_${randomBytes(6).toString("hex")}`;
const target = { threadId: null, missionId: null, projectId: null, executionTarget: "asael" as const };

databaseDescribe("Assistant modes on an isolated PostgreSQL schema266 upgrade", () => {
  let admin: ReturnType<typeof postgres>;
  let db: typeof import("@/lib/db/client");
  let threads: typeof import("@/lib/threads/store");
  let queue: typeof import("@/lib/command/prompt-queue-store");
  let legacy: unknown;
  let beforePolicies: unknown;
  const authority = { tenantId, ownerActorId: actorId, requestActorId: actorId, sessionId: "assistant-mode-session",
    executionScope: createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user",
      executingPrincipalId: actorId, correlationId: "assistant-modes-db", purpose: "prompt_queue.test" }) };
  const owned = <T,>(operation: () => Promise<T>) => db.runWithDatabaseActorScope(tenantId, [actorId], operation);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/assistant_modes_')) {
      throw new Error("This focused migration scenario requires a dedicated loopback assistant_modes_ database.");
    }
    admin = postgres(databaseUrl!, { ssl: false, max: 1, onnotice: () => {} });
    vi.stubEnv("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", "assistant-mode-integration-fixture-key-2026");
    expect([266, 267]).toContain((await admin`SELECT max(version)::integer AS version FROM omni_schema_version`)[0].version);
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},${`${userId}@example.test`},'unused-fixture-hash')`;
    const prompt = "Retain this historical queue item", digest = createHash("sha256").update(prompt).digest("hex");
    const sealed = sealJsonPayload({ prompt }, `prompt-queue:v1:${tenantId}:${actorId}:${legacyId}:${digest}`);
    const agent = { logicalAgentId: "atlas", definitionId: "definition:atlas", definitionVersion: 1,
      definitionVersionId: "definition:atlas:v1", definitionSha256: "d".repeat(64), principalId: "principal:atlas",
      principalGeneration: 1, principalVersionId: "principal:atlas:v1", principalSha256: "e".repeat(64) };
    const model = { providerId: "openai", modelId: "fixture-model", tier: "reasoning", assignmentId: null,
      assignmentRevision: null, assignmentConfigurationSha256: null, routingPolicySha256: "f".repeat(64) };
    const now = new Date().toISOString();
    await admin`INSERT INTO omni_prompt_queue_items
      (id, tenant_id, owner_actor_id, origin_session_id, last_modified_session_id, client_correlation_id,
       sealed_prompt, prompt_sha256, prompt_characters, mode, strategy, target, target_sha256, agent_pin,
       model_pin, state, position_key, created_at, updated_at)
      VALUES (${legacyId},${tenantId},${actorId},'fixture','fixture','legacy',${admin.json(sealed)},${digest},${prompt.length},
       'orchestrate','direct',${admin.json(target)},${"a".repeat(64)},${admin.json(agent)},${admin.json(model)},'queued',1,${now},${now})`;
    legacy = (await admin`SELECT to_jsonb(q) AS row FROM omni_prompt_queue_items q WHERE id=${legacyId}`)[0].row;
    beforePolicies = await admin`SELECT policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE tablename='omni_prompt_queue_items' ORDER BY policyname`;
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    db = await import("@/lib/db/client");
    await db.migrateDatabaseSchema({ verifyRuntimeRole: false });
    await db.closeDatabaseClient();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    // The migration-created group carries feature-specific grants; a fresh
    // local cluster also needs the normal runtime's base table-read grants.
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT INSERT, UPDATE, DELETE ON omni_threads, omni_thread_turns, omni_conversation_summaries, omni_events TO ${runtimeRole}`);
    url.username = runtimeRole; url.password = password; url.searchParams.set("sslmode", "require");
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", "assistant-mode-integration-fixture-key-2026");
    threads = await import("@/lib/threads/store");
    queue = await import("@/lib/command/prompt-queue-store");
  });

  afterAll(async () => {
    await db?.closeDatabaseClient();
    if (admin) {
      await admin.unsafe(`DROP OWNED BY ${runtimeRole}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  it("preserves the sealed historical item, RLS policies, immutable mode and runtime grants", async () => {
    expect((await admin`SELECT to_jsonb(q) AS row FROM omni_prompt_queue_items q WHERE id=${legacyId}`)[0].row).toEqual(legacy);
    expect(await admin`SELECT policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE tablename='omni_prompt_queue_items' ORDER BY policyname`).toEqual(beforePolicies);
    expect((await admin`SELECT max(version)::integer AS version FROM omni_schema_version`)[0].version).toBe(267);
    expect(await owned(() => queue.getPromptQueueItem(legacyId, authority))).toMatchObject({ mode: "orchestrate", prompt: "Retain this historical queue item" });
    expect((await admin`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${runtimeRole}`)[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await expect(owned(() => db.getSql()`UPDATE omni_prompt_queue_items SET mode='coding' WHERE id=${legacyId}`)).rejects.toThrow();
    await expect(admin`UPDATE omni_prompt_queue_items SET mode='coding',lifecycle_revision=lifecycle_revision+1 WHERE id=${legacyId}`).rejects.toThrow("immutable");
  });

  it.each(AGENT_MODES)("persists and decrypts %s through the actual queue store without duplicating replay", async mode => {
    const request = { clientCorrelationId: `mode-${mode}`, prompt: `Continue ${mode} in the right workspace`,
      mode, strategy: "direct" as const, agentId: "atlas", target };
    const saved = await owned(() => queue.createPromptQueueItem({ authority, request }));
    expect(saved.created).toBe(true);
    expect(saved.item).toMatchObject({ mode, prompt: request.prompt, queueGrantsAuthority: false });
    const replay = await owned(() => queue.createPromptQueueItem({ authority, request }));
    expect(replay.created).toBe(false);
    expect(replay.item.id).toBe(saved.item.id);
    const stored = (await admin`SELECT sealed_prompt FROM omni_prompt_queue_items WHERE id=${saved.item.id}`)[0];
    expect(JSON.stringify(stored.sealed_prompt)).not.toContain(request.prompt);
    expect(await db.runWithDatabaseActorScope(tenantId, [`actor:${randomUUID()}`], () =>
      db.getSql()`SELECT id FROM omni_prompt_queue_items WHERE id=${saved.item.id}`)).toHaveLength(0);
    expect(await db.runWithDatabaseActorScope("another-tenant", [actorId], () =>
      db.getSql()`SELECT id FROM omni_prompt_queue_items WHERE id=${saved.item.id}`)).toHaveLength(0);
  });

  it("restores the last accepted mode, ignores a replay and fences another conversation owner", async () => {
    const thread = await owned(() => threads.createThread({ tenantId, actorId, title: "One continuous workspace", mode: "chat" }));
    const first = { id: randomUUID(), tenantId, actorId, threadId: thread.id, role: "user" as const,
      mode: "cowork" as const, content: "Prepare the brief" };
    await owned(() => threads.appendThreadTurn(first));
    await owned(() => threads.appendThreadTurn({ ...first, id: randomUUID(), mode: "coding", content: "Build the prototype" }));
    await owned(() => threads.appendThreadTurn(first));
    expect(await owned(() => threads.getThread(thread.id, { tenantId }))).toMatchObject({ mode: "coding" });
    expect(await owned(() => threads.listThreadTurns(thread.id, { tenantId }))).toHaveLength(2);
    await expect(db.runWithDatabaseActorScope(tenantId, [`actor:${randomUUID()}`], () =>
      threads.appendThreadTurn({ ...first, id: randomUUID(), actorId: "different-owner", mode: "chat" }))).rejects.toThrow();
    expect(await owned(() => threads.getThread(thread.id, { tenantId }))).toMatchObject({ mode: "coding" });
  });
});
