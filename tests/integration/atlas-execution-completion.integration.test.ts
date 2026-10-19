/** Opt-in isolated PostgreSQL proof: real RLS, outbox, leases and deliveries.
 * The model callback is deterministic; this does not claim live model success. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ serving: false, resumed: [] as unknown[] }));
vi.mock("@/lib/orchestration/agent-runner", () => ({ runAgent: async function* (request: import("@/lib/orchestration/types").AgentRunRequest) {
  state.resumed.push(request);
  const store = await import("@/lib/runs/store");
  await store.createAgentRun({ id: request.runId, tenantId: request.tenantId, actorId: request.actorId, threadId: request.threadId, mode: request.mode || "execute", messages: request.messages, prompt: "Continuation fixture", agentId: "atlas" });
  yield { type: "run", runId: request.runId };
  await store.completeAgentRun(request.runId!, "The two dependencies failed; the requested work is incomplete.", undefined, { tenantId: request.tenantId });
  yield { type: "done" };
} }));
vi.mock("@/lib/db/client", async original => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => state.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
// A test has no Next request lifecycle. Exercise the same durable queue explicitly.
vi.mock("next/server", () => ({ after: () => undefined }));
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createThread } from "@/lib/threads/store";
import { createCustomAgent } from "@/lib/skills/store";
import { createProject } from "@/lib/projects/store";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showProjectInventoryService } from "@/lib/app-services/projects";
import { getDelegationCustomProfile } from "@/lib/delegation/custom-profile";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { createAgentRun, completeAgentRun, bindAgentRunExecutionScope } from "@/lib/runs/store";
import { createDelegationExecution, transitionDelegationExecution, readConversationDelegationProgress } from "@/lib/delegation/execution-store";
import { buildExecutionContract, executionParentBudgets } from "@/lib/delegation/test-fixtures";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import { recordParentContinuationCheckpoint } from "@/lib/delegation/parent-continuation-checkpoint";
import { readParentContinuationProgress } from "@/lib/delegation/parent-continuation-progress";
import { cancelParentDependentWork } from "@/lib/delegation/parent-continuation-cancel";
import { parentContinuationRunId } from "@/lib/delegation/parent-continuation-identity";
import { leaseOperationJobByDedupeKey } from "@/lib/operations/job-queue";
import { processParentContinuationJob } from "@/lib/delegation/parent-continuation";

const enabled = process.env.ASAEL_AGENT_CANDIDATE_DATABASE === "1";
const candidate = enabled ? describe : describe.skip;
const adminUrl = process.env.ASAEL_CANDIDATE_DATABASE_URL;
const tenant = `agent-candidate-${randomUUID()}`;
const authUserId = randomUUID(), email = `${tenant}@example.test`, actor = `actor:${authUserId}`;
const roleName = `candidate_${randomBytes(6).toString("hex")}`;
const binding = { version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId: actor, legacyOwnerActorIds: [email], readableOwnerActorIds: [actor, email] };
const evidence: Record<string, unknown> = { tenant, scenario: "sibling outbox join, actor isolation, continuation, single delivery, cancellation and custom profile", provider: "deterministic callback", storage: "isolated loopback PostgreSQL" };

candidate("Atlas completes a delegated request with the candidate runtime", () => {
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
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); vi.stubEnv("VERCEL", "");
    state.serving = true;
    evidence.rls = await scoped(async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_delegation_executions') AS active FROM pg_roles WHERE rolname=current_user`)[0]);
    expect(evidence.rls).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    await scoped(() => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenant},${email})`);
  });
  afterAll(async () => {
    if (admin) {
      evidence.runs = await admin`SELECT id,agent_id,status,response,error FROM omni_agent_runs WHERE tenant_id=${tenant} ORDER BY started_at`;
      evidence.tools = await admin`SELECT id,tool_id,status,reason,output FROM omni_tool_executions WHERE tenant_id=${tenant} ORDER BY created_at`;
      evidence.jobs = await admin`SELECT id,type,status,last_error FROM omni_operation_jobs WHERE tenant_id=${tenant} ORDER BY created_at`;
      evidence.delegations = await admin`SELECT execution_id,delegate_agent_id,state,result,verification,failure_code FROM omni_delegation_executions WHERE tenant_id=${tenant} ORDER BY created_at`;
      await closeDatabaseClient();
      await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); await admin.end();
    }
    if (process.env.ASAEL_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_CANDIDATE_EVIDENCE_FILE, JSON.stringify(evidence, null, 2)+"\n", { mode: 0o600 });
    vi.unstubAllEnvs();
  });
  test("joins real terminal transactions and resumes once under current owner authority", async () => {
    await scoped(async () => {
      const rootId = randomUUID();
      const thread = await createThread({ tenantId: tenant, actorId: email, title: "Isolated continuation fixture", mode: "execute" });
      const identity = await resolveAgentIdentityForExecution({ tenantId: tenant, actorId: email, agentId: "atlas" });
      const scope = createExecutionScope({ tenantId: tenant, initiatingActorId: email, executingPrincipalType: "agent",
        executingPrincipalId: identity.principal.principalId, correlationId: rootId, purpose: "agent.run" });
      await createAgentRun({ id: rootId, tenantId: tenant, actorId: email, threadId: thread.id, agentId: "atlas", mode: "execute", messages: [{ role: "user", content: "Compare both sources." }], prompt: "Compare both sources." });
      await bindAgentRunExecutionScope(rootId, scope, { tenantId: tenant });
      const now = new Date().toISOString();
      const contracts = [0,1].map(() => {
        const childId = randomUUID();
        const template = buildExecutionContract({}, { tenantId: tenant, actorId: actor, rootExecutionId: rootId, childRunId: childId, delegationId: `delegation:${randomUUID()}` });
        return buildExecutionContract({ lineage: { ...template.lineage, parentOwnerActorIdSha256: createHash("sha256").update(email).digest("hex") },
          conversationDelivery: { schemaVersion: 1, threadId: thread.id, parentOwnerActorId: email, threadOwnerActorId: email, disposition: "resume_parent" },
          deadline: { createdAt: now, acceptBy: new Date(Date.now()+60_000).toISOString(), completeBy: new Date(Date.now()+240_000).toISOString() },
          parentAuthority: { grants: template.grants, budgets: executionParentBudgets, completeBy: new Date(Date.now()+300_000).toISOString() } },
          { tenantId: tenant, actorId: actor, rootExecutionId: rootId, childRunId: childId, delegationId: template.delegationId });
      });
      for (const contract of contracts) {
        await createAgentRun({ id: contract.delegateIdentity.runId, tenantId: tenant, actorId: actor, agentId: "scout", mode: "research", prompt: "Read fixture", messages: [{ role: "user", content: "Read fixture" }] });
        await createDelegationExecution({ contract, parentExecutionScope: createExecutionScope({ ...scope, initiatingActorId: actor }), rootBudgetLimits: executionParentBudgets });
      }
      await recordParentContinuationCheckpoint({ runId: rootId, scope, authority: { actorBinding: binding, role: "admin", resumable: true, profile: null, commandModelSelection: null, requireActionApproval: false }, remaining: executionParentBudgets });
      await completeAgentRun(rootId, "The work was assigned.", undefined, { tenantId: tenant });
      const progressInput = { tenantId: tenant, ownerActorId: actor, requestActorId: email, threadId: thread.id };
      expect((await readConversationDelegationProgress(progressInput)).pendingCount).toBe(2);
      for (const [i, contract] of contracts.entries()) {
        await transitionDelegationExecution({ tenantId: tenant, executionId: contract.delegateIdentity.runId, expectedRevision: 0,
          transition: { to: "failed", code: "fixture_source_unavailable" }, executionScope: executionScopeFromDelegationContract(contract) });
        expect((await admin`SELECT id FROM omni_operation_jobs WHERE tenant_id=${tenant} AND payload->>'kind'='delegation_parent_v1'`)).toHaveLength(i);
      }
      expect(await readConversationDelegationProgress(progressInput)).toMatchObject({ pendingCount: 1, parentPendingCount: 1, terminalCount: 2 });
      const lease = await leaseOperationJobByDedupeKey(`delegation-parent:${rootId}`, { tenantId: tenant, type: "agent.execute", owner: "candidate-parent", leaseSeconds: 300 });
      expect(lease.outcome).toBe("leased");
      if (lease.outcome !== "leased") throw new Error("No parent outbox job");
      const outcome = await processParentContinuationJob(lease.job, Date.now()+60_000);
      expect(outcome.status).toBe("completed");
      expect(state.resumed).toHaveLength(1);
      expect(state.resumed[0]).toMatchObject({ role: "operator", threadDelivery: "deferred", budgetLimits: executionParentBudgets });
      expect(JSON.stringify(state.resumed)).toContain("fixture_source_unavailable");
      await processParentContinuationJob(lease.job, Date.now()+60_000);
      expect(state.resumed).toHaveLength(1);
      const turns = await admin`SELECT id,content FROM omni_thread_turns WHERE tenant_id=${tenant} AND thread_id=${thread.id}`;
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toContain("incomplete");
      expect((await readConversationDelegationProgress(progressInput)).pendingCount).toBe(0);
      const handoff = { tenantId: tenant, ownerActorId: email, canonicalActorId: actor, runId: rootId, threadId: thread.id };
      expect(await readParentContinuationProgress(handoff)).toMatchObject({ runId: parentContinuationRunId(rootId), status: "accepted" });
      expect(await readParentContinuationProgress({ ...handoff, ownerActorId: "other@example.test" })).toBeUndefined();
      await cancelParentDependentWork({ tenantId: tenant, actorId: actor, parentRunId: rootId, reason: "Fixture stop", executionScope: scope, idempotencyKey: "fixture-stop" });
      expect(await readParentContinuationProgress(handoff)).toMatchObject({ status: "canceled" });
      const profile = await createCustomAgent({ name: "Candidate custom reader", role: "Reader", description: "Test reader", instructions: "Read the requested record.", status: "ready", accent: "blue", modelPolicy: "openai_fast", autonomy: "assist", approvalPolicy: "read_only", memoryScope: "session", skillIds: [], toolIds: ["app.projects.show"] }, { tenantId: tenant, actorId: email });
      expect((await getDelegationCustomProfile(tenant, actor, profile.id))?.id).toBe(profile.id);
      expect(await getDelegationCustomProfile(tenant, `actor:${randomUUID()}`, profile.id)).toBeUndefined();
      const project = await createProject({ tenantId: tenant, actorId: email, title: "Delegated read fixture", objective: "Fictional vendor: USD 600 in 7 days",
        mutation: { executionScope: createExecutionScope({ tenantId: tenant, initiatingActorId: email, executingPrincipalType: "user", executingPrincipalId: email, correlationId: randomUUID(), purpose: "project.create" }), idempotencyKey: randomUUID() } });
      const caller = createAppServiceCaller({ context: { tenantId: tenant, actorId: actor, role: "operator", source: "service" }, requestActorBinding: binding,
        executionScope: createExecutionScope({ ...executionScopeFromDelegationContract(contracts[0]), purpose: "agent.tool.execute" }) });
      const read = await showProjectInventoryService(caller, { projectId: project.id, includeFullObjective: true });
      expect(read.data.project?.objective).toBe(project.objective);
      evidence.accepted = true; evidence.rootId = rootId; evidence.threadId = thread.id; evidence.outcome = outcome.status;
    });
  });
});
