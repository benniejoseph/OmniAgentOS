import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runs: new Map<string, Record<string, unknown>>(), children: [] as Record<string, unknown>[],
  checkpoint: {} as Record<string, unknown>, membership: "operator", turns: new Map<string, string>(),
  identityPin: undefined as unknown, execute: vi.fn(), complete: vi.fn(), fail: vi.fn(), defer: vi.fn(), scope: {} as Record<string, unknown>, events: vi.fn() }));
vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(async (parts: TemplateStringsArray) => parts.join("").includes("omni_events") ? [] : parts.join("").includes("omni_auth_memberships")
    ? mocks.membership ? [{ role: mocks.membership }] : [] : [{ status: mocks.runs.get("parent")?.status }],
  { transaction: async (operation: (sql: unknown) => unknown) => operation(sql) });
  return { getSql: () => sql, runWithDatabaseActorScope: async (_tenant: string, _actors: string[], operation: () => unknown) => operation() };
});
vi.mock("@/lib/events/store", () => ({ listStreamEvents: async (_id: string, options: { type?: string }) => options.type === "delegation.parent_canceled" ? [] : [{ type: "delegation.parent_checkpoint", payload: mocks.checkpoint }], appendScopedDomainEvent: mocks.events }));
vi.mock("@/lib/delegation/execution-store", () => ({ listDelegationExecutions: async () => mocks.children }));
vi.mock("@/lib/operations/job-queue", () => ({ completeOperationJob: mocks.complete, failOperationJob: mocks.fail, deferOperationJob: mocks.defer, heartbeatOperationJob: async () => true }));
vi.mock("@/lib/runs/store", () => ({ getAgentRun: async (id: string) => mocks.runs.get(id), getAgentRunExecutionScope: async () => mocks.scope, getAgentRunIdentityPin: async () => mocks.identityPin,
  failAgentRun: async (id: string) => mocks.runs.set(id, { ...mocks.runs.get(id), status: "failed" }) }));
vi.mock("@/lib/orchestration/agent-runner", () => ({ runAgent: async function* (request: Record<string, unknown>) {
  mocks.execute(request); mocks.runs.set(String(request.runId), { id: request.runId, status: "completed", response: "The requested document is saved." }); yield { type: "done" };
} }));
vi.mock("@/lib/threads/store", () => ({ appendOwnedThreadTurnInTransaction: async (_sql: unknown, input: { id: string; content: string }) => {
  if (!mocks.turns.has(input.id)) mocks.turns.set(input.id, input.content); return { turn: input };
} }));
import { parentContinuationDisposition, parentContinuationRunId, processParentContinuationJob } from "@/lib/delegation/parent-continuation";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import { parentContinuationAuthority } from "@/lib/delegation/parent-continuation-checkpoint";
import type { AgentRunRequest } from "@/lib/orchestration/types";

import { buildAgentRunIdentityPinV1, buildBuiltInAgentIdentityForVersionV1 } from "@/lib/agents/identity-contracts";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const job = () => ({ id: "job-parent", tenantId: "tenant-a", type: "agent.execute", status: "running", priority: 50, attempt: 1, maxAttempts: 3, runAt: new Date().toISOString(), updatedAt: new Date().toISOString(), leaseOwner: "lease-a", createdAt: new Date().toISOString(),
  payload: { kind: "delegation_parent_v1", actorId, parentRunId: "parent", parentOwnerActorId: "owner@example.com", threadOwnerActorId: "owner@example.com", threadId: "thread-a" } } as OperationJobRecord);
describe("durable parent continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.runs.clear(); mocks.turns.clear(); mocks.membership = "operator";
    mocks.scope = createExecutionScope({ tenantId: "tenant-a", initiatingActorId: "owner@example.com", executingPrincipalType: "agent", executingPrincipalId: parentIdentity().principal.principalId, correlationId: "parent", purpose: "agent.run" });
    mocks.identityPin = buildAgentRunIdentityPinV1({ runId: "parent", identity: parentIdentity() });
    mocks.runs.set("parent", { id: "parent", ownerActorId: "owner@example.com", threadId: "thread-a", agentId: "atlas", status: "completed", mode: "orchestrate", prompt: "Compare the two sources and save a document.", messages: [{ role: "user", content: "Compare the two sources and save a document." }] });
    mocks.children = ["a", "b"].map(id => ({ executionId: id, state: "verified", delegateAgentId: "scout", contract: { objective: "Read source", acceptance: { criteria: [] }, conversationDelivery: { disposition: "resume_parent", threadId: "thread-a", parentOwnerActorId: "owner@example.com" } }, result: { summary: `Source ${id}`, acceptanceChecks: [] } }));
    mocks.checkpoint = { resumable: true, role: "admin", remaining: { modelTurns: 4, tokens: 20_000, costMicrousd: 400_000, wallTimeMs: 60_000, toolCalls: 4, browserActions: 0, agents: 0, fanOut: 0, retries: 0, replans: 0 }, actorBinding: { version: 1, kind: "auth_user", authUserId: actorId.slice(6), canonicalActorId: actorId, legacyOwnerActorIds: ["owner@example.com"], readableOwnerActorIds: [actorId, "owner@example.com"] } };
  });
  it("joins siblings in either order and consumes one parent continuation with one final delivery", async () => {
    mocks.children.reverse();
    expect((await processParentContinuationJob(job())).status).toBe("completed");
    expect((await processParentContinuationJob(job())).status).toBe("completed");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.turns.size).toBe(1);
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ role: "operator", budgetLimits: mocks.checkpoint.remaining, requestActorBinding: { canonicalActorId: actorId } });
    expect(JSON.stringify(mocks.execute.mock.calls[0][0])).toContain("Source a");
    expect(JSON.stringify(mocks.execute.mock.calls[0][0])).toContain("Source b");
  });
  it.each([1, 2] as const)("keeps the canonical Atlas identity at version %s for a legacy-owned continuation", async version => {
    const identity = parentIdentity(version);
    mocks.identityPin = buildAgentRunIdentityPinV1({ runId: "parent", identity });
    expect((await processParentContinuationJob(job())).status).toBe("completed");
    const request = mocks.execute.mock.calls[0][0] as AgentRunRequest;
    expect(request.actorId).toBe("owner@example.com");
    expect(request.agentIdentity).toEqual(identity);
    const pin = buildAgentRunIdentityPinV1({ runId: request.runId!, identity: request.agentIdentity! });
    expect(pin.actorId).toBe(actorId);
    expect(pin.principalId).toBe(request.executionScope?.executingPrincipalId);
  });
  it("refuses a parent identity pin that does not match the original scope", async () => {
    mocks.identityPin = buildAgentRunIdentityPinV1({ runId: "parent", identity: buildBuiltInAgentIdentityForVersionV1({
      agentId: "atlas", tenantId: "tenant-a", controllerActorId: "different-actor", definitionVersion: 2,
    }) });
    expect((await processParentContinuationJob(job())).status).toBe("failed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves ordinary conversation scopes without extending selected memory grants", () => {
    const request = { mode: "execute", messages: [], requestActorBinding: mocks.checkpoint.actorBinding } as AgentRunRequest;
    for (const contextScope of ["session", "current_turn", "none"] as const) expect(parentContinuationAuthority({ ...request, contextScope })).toMatchObject({ resumable: true, contextScope });
    expect(parentContinuationAuthority({ ...request, contextScope: "personal" })?.resumable).toBe(false);
  });
  it("keeps an existing approval waiting without spending retries or repeating its action", async () => {
    mocks.runs.set(parentContinuationRunId("parent"), { status: "waiting_approval" });
    const waiting = job(); waiting.createdAt = new Date(Date.now()-3_600_000).toISOString();
    expect((await processParentContinuationJob(waiting)).status).toBe("stale");
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.defer).toHaveBeenCalledWith(waiting.id, waiting.leaseOwner, expect.objectContaining({ delaySeconds: 60 }));
  });
  it("waits for every sibling and for the original parent", async () => {
    mocks.children[0].state = "running";
    expect((await processParentContinuationJob(job())).status).toBe("stale");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(parentContinuationDisposition("running", ["verified", "verified"])).toBe("waiting");
  });
  it("never resumes a canceled owner", async () => {
    mocks.runs.get("parent")!.status = "canceled";
    await processParentContinuationJob(job());
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.turns.size).toBe(0);
  });
  it("reclaims a terminal run without replay and refuses an ambiguous interrupted run", async () => {
    mocks.runs.set(parentContinuationRunId("parent"), { status: "running" });
    expect((await processParentContinuationJob(job())).status).toBe("failed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("blocks revoked membership and changed actor bindings", async () => {
    mocks.membership = "";
    expect((await processParentContinuationJob(job())).status).toBe("failed");
    mocks.membership = "operator"; mocks.checkpoint.actorBinding = {};
    expect((await processParentContinuationJob(job())).status).toBe("failed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("carries a failed child as an explicit blocker, never a successful contribution", async () => {
    mocks.children[0].state = "failed"; mocks.children[0].failureCode = "source_unavailable";
    await processParentContinuationJob(job());
    const request = JSON.stringify(mocks.execute.mock.calls[0][0]);
    expect(request).toContain("source_unavailable"); expect(request).toContain("Do not repeat finished actions");
  });
});

function parentIdentity(definitionVersion: 1 | 2 = 2) {
  return buildBuiltInAgentIdentityForVersionV1({ agentId: "atlas", tenantId: "tenant-a", controllerActorId: actorId, definitionVersion });
}
