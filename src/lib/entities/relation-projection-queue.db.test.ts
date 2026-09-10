import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  sql: vi.fn(),
  transaction: vi.fn(),
  actorScope: vi.fn(),
  appendEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureSchema,
  getSql: () => Object.assign(mocks.sql, { transaction: mocks.transaction }),
  hasDatabaseUrl: () => true,
  runWithDatabaseActorScope: mocks.actorScope,
  runWithDatabaseSystemScope: vi.fn((_purpose: string, operation: () => unknown) => operation()),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendEvent,
}));
vi.mock("@/lib/entities/relation-projector", () => ({
  rebuildTemporalRelationProjection: vi.fn(),
}));

import { queueTemporalRelationProjection } from "@/lib/entities/relation-projection-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("temporal relation projection queue database scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor-queue",
        generation: 1,
        requested_at: "2026-09-09T06:50:00.000Z",
      }]);
    mocks.transaction.mockImplementation(async (operation) => operation(mocks.sql));
    mocks.actorScope.mockImplementation(async (_tenantId, _actorIds, operation) => operation());
  });

  it("binds the owner actor before opening the queue transaction", async () => {
    await expect(queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: createExecutionScope({
        tenantId: "tenant-queue",
        initiatingActorId: "actor-queue",
        executingPrincipalType: "user",
        executingPrincipalId: "actor-queue",
        correlationId: "queue-test",
        purpose: "api.memory.write",
      }),
    })).resolves.toMatchObject({ queued: true, generation: "1" });

    expect(mocks.actorScope).toHaveBeenCalledWith(
      "tenant-queue",
      ["actor-queue"],
      expect.any(Function),
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("queues a canonical owner only after actor-scope identity proof", async () => {
    mocks.sql.mockReset()
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor:00000000-0000-4000-8000-000000000001",
        generation: 1,
        requested_at: "2026-09-09T06:50:00.000Z",
      }]);
    const executionScope = createExecutionScope({
      tenantId: "tenant-queue",
      initiatingActorId: "owner@example.com",
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      correlationId: "canonical-queue-test",
      purpose: "memory.forget.v1",
    });

    await expect(queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor:00000000-0000-4000-8000-000000000001",
      executionScope,
      sql: mocks.sql,
    })).resolves.toMatchObject({ queued: true });
    expect(mocks.sql.mock.calls[0]?.[0].join("?")).toContain(
      "omni_actor_scope_v1_allows_canonical",
    );
  });

  it("does not reuse a request event id after a completed queue generation resets", async () => {
    mocks.sql.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor-queue",
        generation: 1,
        requested_at: "2026-09-09T06:50:00.000Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor-queue",
        generation: 1,
        requested_at: "2026-09-09T06:55:00.000Z",
      }]);

    await queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: userScope(),
    });
    await queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: userScope(),
    });

    expect(mocks.appendEvent).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent.mock.calls[0]?.[0].id).not.toBe(
      mocks.appendEvent.mock.calls[1]?.[0].id,
    );
    expect(mocks.appendEvent.mock.calls[0]?.[0].payload).toMatchObject({
      requestedAt: "2026-09-09T06:50:00.000Z",
    });
    expect(mocks.appendEvent.mock.calls[1]?.[0].payload).toMatchObject({
      requestedAt: "2026-09-09T06:55:00.000Z",
    });
  });

  it("does not reuse a request event id when a reset result is identical for different callers", async () => {
    mocks.sql.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor-queue",
        generation: 1,
        requested_at: "2026-09-09T06:50:00.0004Z",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        tenant_id: "tenant-queue",
        owner_actor_id: "actor-queue",
        generation: 1,
        requested_at: "2026-09-09T06:50:00.0008Z",
      }]);

    await queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: userScope("queue-request-one"),
    });
    await queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: userScope("queue-request-two"),
    });

    expect(mocks.appendEvent).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent.mock.calls[0]?.[0].payload).toEqual(
      mocks.appendEvent.mock.calls[1]?.[0].payload,
    );
    expect(mocks.appendEvent.mock.calls[0]?.[0].id).not.toBe(
      mocks.appendEvent.mock.calls[1]?.[0].id,
    );
  });
});

function userScope(correlationId = "queue-test") {
  return createExecutionScope({
    tenantId: "tenant-queue",
    initiatingActorId: "actor-queue",
    executingPrincipalType: "user",
    executingPrincipalId: "actor-queue",
    correlationId,
    purpose: "api.memory.write",
  });
}
