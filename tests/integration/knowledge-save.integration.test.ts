/** Opt-in PostgreSQL save/readback proof; only embeddings use a fixture. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ serving: false, embedTexts: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1, 0.2])) }));
vi.mock("@/lib/db/client", async original => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => state.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
vi.mock("@/lib/openai/client", async original => ({ ...await original<typeof import("@/lib/openai/client")>(), embedTexts: state.embedTexts }));
vi.mock("@/lib/trust/ledger", () => ({ actionClassFor: (toolId: string) => toolId, recordActionOutcome: vi.fn(), resolveAutonomy: vi.fn() }));
vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { executeGovernedTool } from "@/lib/tools/executor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { getCanonicalKnowledgeEvidenceByChunkIds, listKnowledgeChunks, listKnowledgeDocuments } from "@/lib/rag/store";

const enabled = process.env.ASAEL_AGENT_CANDIDATE_DATABASE === "1";
const candidate = enabled ? describe : describe.skip;
const adminUrl = process.env.ASAEL_CANDIDATE_DATABASE_URL;
const tenant = `agent-candidate-${randomUUID()}`;
const authUserId = randomUUID(), email = `${tenant}@example.test`, actor = `actor:${authUserId}`;
const roleName = `candidate_${randomBytes(6).toString("hex")}`;
const evidence: Record<string, unknown> = { tenant, scenario: "governed knowledge save, source lineage, readback and one-write replay", provider: "deterministic embeddings", storage: "isolated loopback PostgreSQL" };

candidate("governed knowledge save in PostgreSQL", () => {
  let admin: ReturnType<typeof postgres>;
  const scoped = <T>(operation: () => Promise<T>) => runWithDatabaseActorScope(tenant, [email, actor], operation);
  beforeAll(async () => {
    if (!adminUrl) throw new Error("ASAEL_CANDIDATE_DATABASE_URL is required.");
    const url = new URL(adminUrl);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_agents_candidate") throw new Error("Only the isolated candidate database is allowed.");
    await closeDatabaseClient();
    admin = postgres(adminUrl, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${authUserId},${email},'isolated-candidate-no-login')`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenant},'Atlas candidate',${tenant})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${randomUUID()},${tenant},${authUserId},'operator')`;
    url.username = roleName; url.password = password;
    url.searchParams.set("sslmode", "disable");
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); vi.stubEnv("VERCEL", "");
    state.serving = true;
    evidence.rls = await scoped(async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_knowledge_documents') AS active FROM pg_roles WHERE rolname=current_user`)[0]);
    expect(evidence.rls).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    await scoped(() => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenant},${email})`);
  });
  afterAll(async () => {
    if (admin) {
      evidence.tools = await admin`SELECT id,tool_id,status,reason,output FROM omni_tool_executions WHERE tenant_id=${tenant} ORDER BY created_at`;
      await closeDatabaseClient();
      await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); await admin.end();
    }
    if (process.env.ASAEL_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_CANDIDATE_EVIDENCE_FILE, JSON.stringify(evidence, null, 2)+"\n", { mode: 0o600 });
    vi.unstubAllEnvs();
  });
  test("saves once with actor-private source evidence and verifies the saved recommendation", async () => {
    await scoped(async () => {
      const context = { tenantId: tenant, actorId: email, role: "operator" as const, source: "service" as const };
      const executionScope = createExecutionScope({ tenantId: tenant, initiatingActorId: email, executingPrincipalType: "agent", executingPrincipalId: "atlas", correlationId: randomUUID(), purpose: "agent.run" });
      const document = { title: "Verified vendor recommendation", content: "Vendor A: USD 600, 7 days. Vendor B: USD 450, 10 days. Vendor A qualifies for the 8-day deadline." };
      const request = { toolId: "app.knowledge.ingest", input: document, context, executionScope, dryRun: false, idempotencyKey: "save-vendor-recommendation" };
      const saved = await executeGovernedTool(request);
      expect(saved.record.status, saved.record.reason).toBe("executed");
      const replay = await executeGovernedTool(request);
      expect(replay.record.id).toBe(saved.record.id);
      expect(replay.record.status).toBe("executed");
      const readback = await executeGovernedTool({ toolId: "app.knowledge.list", input: { limit: 20 }, context, executionScope, dryRun: false, idempotencyKey: "verify-saved-recommendation" });
      expect(readback.record.status, readback.record.reason).toBe("executed");
      expect(readback.result).toMatchObject({ documents: [{ title: document.title }] });
      expect(await listKnowledgeDocuments(20, { tenantId: tenant })).toHaveLength(1);
      const chunks = await listKnowledgeChunks(20, { tenantId: tenant });
      const lineage = await getCanonicalKnowledgeEvidenceByChunkIds(chunks.map(chunk => chunk.id), { tenantId: tenant });
      expect(lineage).toHaveLength(1);
      expect(lineage[0]).toMatchObject({ chunk: { content: document.content }, evidenceUnit: { ownerActorId: email, tenantId: tenant, visibility: "user_private", capturedAt: saved.record.createdAt } });
      expect(state.embedTexts).toHaveBeenCalledTimes(1);
      evidence.accepted = true; evidence.documentId = chunks[0].documentId; evidence.sourceRevisionId = chunks[0].sourceRevisionId; evidence.toolExecutionId = saved.record.id;
    });
  });
});
