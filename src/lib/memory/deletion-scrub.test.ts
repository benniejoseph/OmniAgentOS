import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(),
  runWithDatabaseSystemScope: vi.fn(
    async (_reason: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  runWithDatabaseSystemScope: mocks.runWithDatabaseSystemScope,
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  memoryDeletionScrubSlaHours,
  processPendingMemoryDeletionScrubs,
} from "@/lib/memory/deletion-scrub";

beforeEach(() => {
  mocks.appendScopedDomainEvent.mockReset().mockResolvedValue(undefined);
  mocks.ensureDatabaseSchema.mockReset().mockResolvedValue(undefined);
  mocks.getSql.mockReset();
  mocks.hasDatabaseUrl.mockReset();
  mocks.runWithDatabaseSystemScope.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memory deletion physical scrub", () => {
  it("reports bounded local storage as already synchronously scrubbed", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);

    await expect(processPendingMemoryDeletionScrubs()).resolves.toMatchObject({
      backend: "bounded_local",
      processedReceipts: 0,
      scrubbedMemories: 0,
      completedReceiptIds: [],
      overdueReceiptIds: [],
      hasMore: false,
      slaHours: 24,
    });
    expect(mocks.ensureDatabaseSchema).not.toHaveBeenCalled();
  });

  it("scrubs a leased receipt manifest and records scoped completion", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(true);
    const queries: string[] = [];
    const transactionSql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT receipt.*")) {
        return [{
          id: "receipt-1",
          tenant_id: "tenant-a",
          memory_id: "memory-root",
          descendant_memory_ids: ["memory-child"],
          descendant_memory_count: 1,
          attribution_kind: "scope_bound",
          execution_scope: {
            version: 1,
            tenantId: "tenant-a",
            initiatingActorId: "actor-a",
            executingPrincipalType: "user",
            executingPrincipalId: "actor-a",
            workspaceId: null,
            projectId: null,
            missionId: null,
            delegationId: null,
            correlationId: "correlation-a",
            causationId: null,
            contextGrantIds: [],
            capabilityGrantIds: [],
            purpose: "memory.forget",
          },
          forgotten_at: "2026-09-05T00:00:00.000Z",
          created_at: new Date().toISOString(),
        }];
      }
      if (query.includes("UPDATE omni_memories memory")) {
        return [{ id: "memory-child" }];
      }
      if (query.includes("SELECT EXISTS")) {
        return [{ pending: false }];
      }
      throw new Error(`Unexpected scrub query: ${query}`);
    });
    const sql = Object.assign(
      vi.fn(async () => [{ present: 1 }]),
      {
        transaction: vi.fn(async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql)),
      },
    );
    mocks.getSql.mockReturnValue(sql);

    const result = await processPendingMemoryDeletionScrubs({
      receiptLimit: 2,
      memoryLimit: 5,
    });

    expect(result).toMatchObject({
      backend: "postgres",
      processedReceipts: 1,
      scrubbedMemories: 1,
      completedReceiptIds: ["receipt-1"],
      overdueReceiptIds: [],
      hasMore: false,
    });
    expect(queries.some((query) => query.includes("embedding_vector = NULL"))).toBe(true);
    expect(mocks.runWithDatabaseSystemScope).toHaveBeenCalledWith(
      expect.stringMatching(/immutable deletion receipts/i),
      expect.any(Function),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "memory:memory-root",
        type: "memory.deletion_scrub.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          executingPrincipalType: "system",
          executingPrincipalId: "memory-deletion-scrubber",
          causationId: "receipt-1",
        }),
        payload: expect.objectContaining({
          deletionReceiptId: "receipt-1",
          descendantMemoryCount: 1,
          status: "physical_scrub_completed",
        }),
      }),
      { sql: transactionSql },
    );
  });

  it("bounds the configured physical scrub SLA", () => {
    vi.stubEnv("OMNIAGENT_MEMORY_DELETION_SCRUB_SLA_HOURS", "0");
    expect(memoryDeletionScrubSlaHours()).toBe(1);
    vi.stubEnv("OMNIAGENT_MEMORY_DELETION_SCRUB_SLA_HOURS", "9999");
    expect(memoryDeletionScrubSlaHours()).toBe(720);
    vi.stubEnv("OMNIAGENT_MEMORY_DELETION_SCRUB_SLA_HOURS", "invalid");
    expect(memoryDeletionScrubSlaHours()).toBe(24);
  });
});
