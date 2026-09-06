import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord } from "@/lib/runs/types";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getAgentRun: vi.fn(),
  listStreamEvents: vi.fn(),
  listCorrelatedEvents: vi.fn(),
  listRunForkLineage: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/runs/store", () => ({ getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/runs/fork-store", () => ({
  listRunForkLineage: mocks.listRunForkLineage,
}));
vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
  listCorrelatedEvents: mocks.listCorrelatedEvents,
}));

import { GET } from "@/app/api/runs/[id]/trajectory/route";

const run: AgentRunRecord = {
  id: "run-one",
  tenantId: "tenant-one",
  ownerActorId: "actor-one",
  mode: "execute",
  status: "completed",
  prompt: "private prompt",
  messages: [{ role: "user", content: "private prompt" }],
  memoryContextCount: 0,
  response: "private response",
  startedAt: "2026-09-06T00:00:00.000Z",
  completedAt: "2026-09-06T00:00:03.000Z",
};

function event(
  id: string,
  seq: number,
  streamId: string,
  type: string,
): DomainEvent {
  return {
    id,
    seq,
    streamId,
    type,
    tenantId: "tenant-one",
    actorId: "actor-one",
    payload: {},
    correlationId: "request-one",
    at: `2026-09-06T00:00:0${seq}.000Z`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-one",
    actorId: "actor-one",
    role: "operator",
    source: "session",
  });
  mocks.getAgentRun.mockResolvedValue(run);
  mocks.listStreamEvents.mockResolvedValue([
    event("run-plan", 2, "run:run-one", "run.harness"),
    event("run-model", 3, "run:run-one", "run.model"),
    event("run-done", 4, "run:run-one", "run.done"),
  ]);
  mocks.listCorrelatedEvents.mockResolvedValue([
    event("intent", 1, "intent:request-one", "intent.semantic_resolved"),
    event("run-plan", 2, "run:run-one", "run.harness"),
  ]);
  mocks.listRunForkLineage.mockResolvedValue({ parent: undefined, children: [] });
});

describe("run trajectory route", () => {
  it("adds one owner-scoped correlated trace hierarchy", async () => {
    const response = await GET(
      new Request("http://asael.test/api/runs/run-one/trajectory"),
      { params: Promise.resolve({ id: "run-one" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.traceHierarchy).toMatchObject({
      version: 1,
      runId: "run-one",
      outcome: "succeeded",
      summary: { eventCount: 4 },
    });
    expect(body.traceHierarchy.stages.map((stage: { id: string }) => stage.id))
      .toEqual([
        "intent", "plan", "agent", "model", "tool", "evidence",
        "effect", "verification", "memory",
      ]);
    expect(mocks.listStreamEvents).toHaveBeenCalledWith("run:run-one", {
      tenantId: "tenant-one",
      actorId: "actor-one",
      limit: 2_000,
    });
    expect(mocks.listCorrelatedEvents).toHaveBeenCalledWith("request-one", {
      tenantId: "tenant-one",
      actorId: "actor-one",
      limit: 2_000,
    });
    expect(JSON.stringify(body)).not.toContain("private prompt");
    expect(JSON.stringify(body)).not.toContain("private response");
  });

  it("does not expose an actor-owned run through another actor", async () => {
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-other",
      role: "admin",
      source: "session",
    });

    const response = await GET(
      new Request("http://asael.test/api/runs/run-one/trajectory"),
      { params: Promise.resolve({ id: "run-one" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.listStreamEvents).not.toHaveBeenCalled();
    expect(mocks.listCorrelatedEvents).not.toHaveBeenCalled();
  });
});
