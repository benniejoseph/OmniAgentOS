import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: () => true,
  runWithDatabaseSystemScope: vi.fn(
    async (_purpose: string, operation: () => unknown) => operation(),
  ),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecution: vi.fn(),
  openToolExecutionInput: vi.fn(),
}));

import { executeLocalComputerCommand } from "@/lib/local-computer/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("local Computer Use command binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an execution-id conflict bound to another exact session", async () => {
    const toolInput = { includeScreenshot: true, presentScreenshot: true };
    const transactionSql = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "local_computer_session_new", device_id: "device-new-0001" },
      ])
      .mockResolvedValueOnce([
        {
          action: "observe",
          input_sha256: canonicalJsonSha256(toolInput),
          session_id: "local_computer_session_old",
          device_id: "device-old-0001",
        },
      ]);
    const sql = Object.assign(vi.fn(), {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    const operation = executeLocalComputerCommand({
      action: "observe",
      toolInput,
      executionId: "run-binding-test:execution-1",
      runId: "run-binding-test",
      executionScope: createExecutionScope({
        tenantId: "tenant-binding-test",
        initiatingActorId: "actor-binding-test",
        executingPrincipalType: "agent",
        executingPrincipalId: "principal:orchestrator:1",
        correlationId: "correlation-binding-test",
        purpose: "agent.run",
      }),
    });

    await expect(operation).rejects.toMatchObject({
      code: "command_binding_mismatch",
    });
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});
