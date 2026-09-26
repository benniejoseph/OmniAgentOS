import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { SecurityContext } from "@/lib/security/types";

vi.mock("@/lib/events/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/store")>();
  return {
    ...actual,
    appendScopedDomainEvent: vi.fn(actual.appendScopedDomainEvent),
    listStreamEvents: vi.fn(actual.listStreamEvents),
  };
});

vi.mock("@/lib/runs/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs/store")>();
  return { ...actual, getAgentRun: vi.fn(actual.getAgentRun) };
});

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-request-admission-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  const events = await import("@/lib/events/store");
  const runs = await import("@/lib/runs/store");
  vi.mocked(events.appendScopedDomainEvent).mockClear();
  vi.mocked(events.listStreamEvents).mockClear();
  vi.mocked(runs.getAgentRun).mockClear();
});

const TENANT_ID = "tenant-admission";

function contextFor(actorId = "actor-a", tenantId = TENANT_ID): SecurityContext {
  return { tenantId, actorId, role: "operator", source: "session" };
}

function storedRun(
  runId: string,
  overrides: Partial<AgentRunRecord>,
): AgentRunRecord {
  return {
    id: runId,
    tenantId: TENANT_ID,
    ownerActorId: "actor-a",
    mode: "orchestrate",
    status: "running",
    prompt: "Summarize my week.",
    messages: [{ role: "user", content: "Summarize my week." }],
    agentId: "atlas",
    specialistIds: ["atlas"],
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function admit(requestId: string, fingerprint: string, context = contextFor()) {
  const admission = await import("@/lib/runs/request-admission");
  return admission.admitAgentRequest({
    context,
    requestId,
    requestFingerprintSha256: fingerprint,
  });
}

describe("request-derived identities", () => {
  it("are deterministic version-8 UUIDs the request schema accepts", async () => {
    const admission = await import("@/lib/runs/request-admission");
    const ids = [
      admission.agentRequestRunId("tenant-a", "actor-a", "request-a"),
      admission.agentRequestThreadId("tenant-a", "actor-a", "request-a"),
      admission.agentRequestUserTurnId("tenant-a", "actor-a", "thread-a", "request-a"),
      admission.agentRequestDelegatedTurnId("tenant-a", "actor-a", "thread-a", "request-a"),
    ];
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(z.string().uuid().safeParse(id).success).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(admission.agentRequestRunId("tenant-a", "actor-a", "request-a"))
      .toBe(ids[0]);
  });

  it("separate tenants, actors, requests, and part boundaries", async () => {
    const admission = await import("@/lib/runs/request-admission");
    const runId = admission.agentRequestRunId("tenant-a", "actor-a", "request-a");
    expect(admission.agentRequestRunId("tenant-b", "actor-a", "request-a")).not.toBe(runId);
    expect(admission.agentRequestRunId("tenant-a", "actor-b", "request-a")).not.toBe(runId);
    expect(admission.agentRequestRunId("tenant-a", "actor-a", "request-b")).not.toBe(runId);
    expect(admission.requestScopedUuid(["a", "bc"]))
      .not.toBe(admission.requestScopedUuid(["ab", "c"]));
    expect(
      admission.agentRequestUserTurnId("tenant-a", "actor-a", "thread-a", "request-a"),
    ).not.toBe(
      admission.agentRequestUserTurnId("tenant-a", "actor-a", "thread-b", "request-a"),
    );
  });
});

describe("request fingerprints", () => {
  it("ignore the requestId and the thread the request itself created", async () => {
    const admission = await import("@/lib/runs/request-admission");
    const fingerprint = (request: Record<string, unknown>) =>
      admission.agentRequestFingerprint("tenant-a", "actor-a", "request-a", request);
    const original = fingerprint({ message: "Summarize my week.", requestId: "request-a" });

    expect(fingerprint({ message: "Summarize my week." })).toBe(original);
    expect(fingerprint({
      message: "Summarize my week.",
      requestId: "request-a",
      threadId: admission.agentRequestThreadId("tenant-a", "actor-a", "request-a"),
    })).toBe(original);
    expect(fingerprint({
      message: "Summarize my week.",
      threadId: admission.agentRequestThreadId("tenant-a", "actor-a", "request-b"),
    })).not.toBe(original);
    expect(fingerprint({
      message: "Summarize my week.",
      threadId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    })).not.toBe(original);
    expect(fingerprint({ message: "Summarize my month." })).not.toBe(original);
    expect(fingerprint({ message: "Summarize my week.", agentId: "nova" }))
      .not.toBe(original);
  });
});

describe("agent request admission (file mode)", () => {
  it("binds a new request once and refuses the id for another instruction", async () => {
    const events = await import("@/lib/events/store");
    const admission = await import("@/lib/runs/request-admission");
    await expect(admit("admit-new-a", "a".repeat(64))).resolves.toEqual({ state: "new" });

    const bindings = await events.listStreamEvents("agent-request:admit-new-a", {
      tenantId: TENANT_ID,
      actorId: "actor-a",
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      type: admission.AGENT_REQUEST_BINDING_EVENT_TYPE,
      correlationId: "admit-new-a",
      payload: {
        schemaVersion: 1,
        requestFingerprintSha256: "a".repeat(64),
        runId: admission.agentRequestRunId(TENANT_ID, "actor-a", "admit-new-a"),
      },
    });

    // Nothing ran yet, so the same instruction runs under the same identities.
    await expect(admit("admit-new-a", "a".repeat(64))).resolves.toEqual({ state: "new" });
    expect(events.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
    await expect(admit("admit-new-a", "b".repeat(64))).resolves.toEqual({ state: "reused" });

    // Another actor's use of the same id is its own request.
    await expect(admit("admit-new-a", "b".repeat(64), contextFor("actor-b")))
      .resolves.toEqual({ state: "new" });
  });

  it("defers to a concurrent first attempt's binding", async () => {
    const events = await import("@/lib/events/store");
    await expect(admit("admit-race-a", "a".repeat(64))).resolves.toEqual({ state: "new" });
    // This attempt read before the first one's binding landed.
    vi.mocked(events.listStreamEvents).mockResolvedValueOnce([]);

    await expect(admit("admit-race-a", "b".repeat(64))).resolves.toEqual({ state: "reused" });
    expect(events.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the binding cannot be read or written", async () => {
    const events = await import("@/lib/events/store");
    vi.mocked(events.listStreamEvents).mockRejectedValueOnce(new Error("offline"));
    await expect(admit("admit-outage-a", "a".repeat(64))).rejects.toThrow("offline");

    vi.mocked(events.appendScopedDomainEvent).mockRejectedValueOnce(new Error("disk full"));
    await expect(admit("admit-outage-b", "a".repeat(64))).rejects.toThrow("disk full");
    await expect(
      events.listStreamEvents("agent-request:admit-outage-b", {
        tenantId: TENANT_ID,
        actorId: "actor-a",
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "completed",
      { status: "completed", response: "Recorded answer.", threadId: "thread-a" },
      [
        { type: "status", label: "Replayed" },
        { type: "done", response: "Recorded answer." },
      ],
    ],
    [
      "failed",
      { status: "failed", error: "Provider rejected sk-live-abcdefghijklmnopqrstuvwxyz0123456789." },
      [{ type: "error", message: expect.not.stringContaining("sk-live-abcdefghijklmnopqrstuvwxyz0123456789") }],
    ],
    [
      "canceled",
      { status: "canceled", error: "Canceled by the operator." },
      [{ type: "canceled", message: expect.stringContaining("was not run again") }],
    ],
    [
      "waiting_approval",
      {
        status: "waiting_approval",
        continuation: {
          conversationItems: [],
          instructions: "test",
          response: "partial",
          toolSteps: 1,
          outputsBeforeApproval: [],
          pendingToolCall: {
            callId: "call_1",
            toolId: "computer.local",
            toolName: "This Mac",
            riskLevel: 2,
            executionId: "exec-admit-approval",
          },
          context: { tenantId: TENANT_ID, actorId: "actor-a", role: "operator" },
          createdAt: new Date().toISOString(),
        },
      },
      [{
        type: "waiting_approval",
        executionId: "exec-admit-approval",
        toolId: "computer.local",
      }],
    ],
    [
      "waiting_clarification",
      {
        status: "waiting_clarification",
        threadId: "thread-a",
        response: "Which project do you mean?",
      },
      [{
        type: "clarification",
        threadId: "thread-a",
        message: "Which project do you mean?",
        reasonCode: "ambiguous_read_target",
      }],
    ],
  ] as const)("replays a %s run", async (status, overrides, expected) => {
    const admission = await import("@/lib/runs/request-admission");
    const runs = await import("@/lib/runs/store");
    const requestId = `admit-replay-${status}`;
    const runId = admission.agentRequestRunId(TENANT_ID, "actor-a", requestId);
    await admit(requestId, "a".repeat(64));
    vi.mocked(runs.getAgentRun).mockResolvedValueOnce(
      storedRun(runId, overrides as Partial<AgentRunRecord>),
    );

    const result = await admit(requestId, "a".repeat(64));
    expect(result.state).toBe("replay");
    if (result.state !== "replay") return;
    expect(result.events[0]).toMatchObject({ type: "run", runId });
    expect(result.events.slice(1)).toMatchObject(expected);
    expect(runs.getAgentRun).toHaveBeenLastCalledWith(runId, { tenantId: TENANT_ID });
  });

  it.each([
    ["running", {}],
    ["resuming", { status: "resuming" }],
    ["waiting_approval without its paused call", { status: "waiting_approval" }],
    ["waiting_clarification without its thread", { status: "waiting_clarification" }],
  ] as const)("reports a %s run as in progress", async (label, overrides) => {
    const admission = await import("@/lib/runs/request-admission");
    const runs = await import("@/lib/runs/store");
    const requestId = `admit-live-${label.replaceAll(" ", "-")}`;
    const runId = admission.agentRequestRunId(TENANT_ID, "actor-a", requestId);
    await admit(requestId, "a".repeat(64));
    const run = storedRun(runId, overrides as Partial<AgentRunRecord>);
    vi.mocked(runs.getAgentRun).mockResolvedValueOnce(run);

    await expect(admit(requestId, "a".repeat(64))).resolves.toEqual({
      state: "in_progress",
      runId,
      status: run.status,
    });
  });

  it("never replays a run another actor owns", async () => {
    const admission = await import("@/lib/runs/request-admission");
    const runs = await import("@/lib/runs/store");
    const requestId = "admit-foreign-run";
    const runId = admission.agentRequestRunId(TENANT_ID, "actor-a", requestId);
    await admit(requestId, "a".repeat(64));
    vi.mocked(runs.getAgentRun).mockResolvedValueOnce(
      storedRun(runId, {
        ownerActorId: "actor-b",
        status: "completed",
        response: "Someone else's answer.",
      }),
    );

    await expect(admit(requestId, "a".repeat(64))).resolves.toEqual({ state: "reused" });
  });

  it("replays the durable workflow the request started", async () => {
    const workflows = await import("@/lib/workflows/store");
    const requestId = "admit-workflow-a";
    await admit(requestId, "a".repeat(64));
    const detail = await workflows.createWorkflowRun({
      tenantId: TENANT_ID,
      goal: "Coordinate the launch.",
      mode: "orchestrate",
      requireApproval: true,
      metadata: {
        source: "atomic_supervisor",
        threadId: "thread-workflow",
        requestId,
        actorId: "actor-a",
        missionId: "mission-workflow",
      },
      idempotencyKey: `supervisor:actor-a:${requestId}`,
    });

    await expect(admit(requestId, "a".repeat(64))).resolves.toEqual({
      state: "replay",
      events: [{
        type: "delegated",
        threadId: "thread-workflow",
        workflowId: detail.run.id,
        missionId: "mission-workflow",
        acknowledgement: expect.stringContaining("pause before consequential external actions"),
        reason: "Replayed the workflow this request already started.",
      }],
    });
  });

  it.each([
    ["another actor", { actorId: "actor-b" }],
    ["another request", { requestId: "admit-workflow-other" }],
    ["no thread", { threadId: undefined }],
  ] as const)("does not replay a workflow bound to %s", async (label, metadata) => {
    const workflows = await import("@/lib/workflows/store");
    const requestId = `admit-workflow-${label.replaceAll(" ", "-")}`;
    await admit(requestId, "a".repeat(64));
    await workflows.createWorkflowRun({
      tenantId: TENANT_ID,
      goal: "Coordinate the launch.",
      mode: "orchestrate",
      requireApproval: false,
      metadata: {
        source: "atomic_supervisor",
        threadId: "thread-workflow",
        requestId,
        actorId: "actor-a",
        ...metadata,
      },
      idempotencyKey: `supervisor:actor-a:${requestId}`,
    });

    await expect(admit(requestId, "a".repeat(64))).resolves.toEqual({ state: "new" });
  });
});
