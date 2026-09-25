import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
  getToolExecution: vi.fn(),
  openToolExecutionInput: vi.fn(),
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
  getToolExecution: mocks.getToolExecution,
  openToolExecutionInput: mocks.openToolExecutionInput,
}));

import {
  claimLocalComputerCommand,
  executeLocalComputerCommand,
} from "@/lib/local-computer/store";
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
        {
          id: "local_computer_session_new",
          device_id: "device-new-0001",
          run_id: "run-binding-test",
        },
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

  it("accepts screenshot presentation from an exact active v12 run binding", async () => {
    const toolInput = { includeScreenshot: true, presentScreenshot: true };
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const completedAt = new Date().toISOString();
    const transactionSql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "local_computer_session_v12",
          device_id: "device-v12-0001",
          run_id: "run-v12-authorized",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "local_computer_command_v12",
          action: "observe",
          input_sha256: canonicalJsonSha256(toolInput),
          session_id: "local_computer_session_v12",
          device_id: "device-v12-0001",
          expires_at: expiresAt,
        },
      ]);
    const sqlCall = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "local_computer_command_v12",
          action: "observe",
          state: "completed",
          completed_at: completedAt,
          result_sha256: "c".repeat(64),
          result: {
            summary: "Observed the active Mac workspace.",
            observation: {
              snapshotRevision: "a".repeat(64),
              screenshot: {
                mimeType: "image/png",
                dataBase64: Buffer.from([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]).toString("base64"),
              },
            },
          },
        },
      ])
      .mockResolvedValueOnce([{ id: "local_computer_command_v12" }]);
    const sql = Object.assign(sqlCall, {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "observe",
      toolInput,
      executionId: "run-v12-authorized:observe",
      runId: "run-v12-authorized",
      executionScope: boundExecutionScope("run-v12-authorized"),
    })).resolves.toMatchObject({
      publicResult: { summary: "Observed the active Mac workspace." },
      observation: {
        snapshotRevision: "a".repeat(64),
        screenshot: { mimeType: "image/png" },
      },
    });

    expect(transactionSql).toHaveBeenCalledTimes(2);
    for (const call of transactionSql.mock.calls) {
      expect(call.slice(1)).toContain(12);
    }
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      boundary: "another run",
      sessionRows: [{
        id: "local_computer_session_cross_run",
        device_id: "device-v12-0001",
        run_id: "run-someone-else",
      }],
    },
    { boundary: "an expired native lease", sessionRows: [] },
    { boundary: "a pre-v12 native session", sessionRows: [] },
  ])("fails screenshot presentation closed for $boundary", async ({ sessionRows }) => {
    const transactionSql = vi.fn().mockResolvedValueOnce(sessionRows);
    const sql = Object.assign(vi.fn(), {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "observe",
      toolInput: { includeScreenshot: true, presentScreenshot: true },
      executionId: "run-v12-authorized:rejected-observe",
      runId: "run-v12-authorized",
      executionScope: boundExecutionScope("run-v12-authorized"),
    })).rejects.toMatchObject({
      name: "LocalComputerUnavailableError",
      status: 409,
    });

    const authorityQuery = sqlText(transactionSql.mock.calls[0]?.[0]);
    expect(authorityQuery).toContain("session.run_id IS NULL OR session.run_id = run.id");
    expect(authorityQuery).toContain("session.state = 'active'");
    expect(authorityQuery).toContain("session.expires_at > NOW()");
    expect(authorityQuery).toContain("device.lease_expires_at > NOW()");
    expect(authorityQuery).toContain("native_session.revoked_at IS NULL");
    expect(authorityQuery).toContain("native_session.refresh_expires_at > NOW()");
    expect(authorityQuery).toContain("device.native_contract_version >=");
    expect(authorityQuery).toContain("native_session.client_contract_version >=");
    expect(transactionSql.mock.calls[0]?.slice(1)).toContain(12);
    expect(transactionSql.mock.calls[0]?.slice(1)).toContain("run-v12-authorized");
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("requires the same server-authoritative v13 binding for native URL opening", async () => {
    const transactionSql = vi.fn().mockResolvedValueOnce([]);
    const sql = Object.assign(vi.fn(), {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "open_url",
      toolInput: { browser: "chrome", url: "https://example.test/chart" },
      executionId: "run-v13-authorized:open-url",
      runId: "run-v13-authorized",
      executionScope: boundExecutionScope("run-v13-authorized"),
    })).rejects.toMatchObject({
      name: "LocalComputerUnavailableError",
      status: 409,
    });

    expect(transactionSql.mock.calls[0]?.slice(1)).toContain(13);
    expect(sqlText(transactionSql.mock.calls[0]?.[0])).toContain(
      "native_session.client_contract_version >=",
    );
  });

  it("claims an open URL preview without forwarding preview policy to the helper", async () => {
    const toolInput = {
      browser: "chrome",
      url: "https://in.tradingview.com/chart/example?symbol=OANDA%3AXAUUSD",
      loadWaitSeconds: 8,
      presentScreenshot: true,
    };
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const sql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: `local_computer_command_${"b".repeat(48)}`,
        run_id: "run-open-url-preview",
        execution_id: "run-open-url-preview:execution-open-url",
        action: "open_url",
        input_sha256: canonicalJsonSha256(toolInput),
        claim_generation: 1,
        expires_at: expiresAt,
      }]);
    mocks.getSql.mockReturnValue(sql);
    mocks.getToolExecution.mockResolvedValueOnce({
      toolId: "local.macos.open_url",
    });
    mocks.openToolExecutionInput.mockReturnValueOnce(toolInput);

    const claimed = await claimLocalComputerCommand(nativeSecurityContext());

    expect(claimed).toMatchObject({
      command: {
        action: "open_url",
        presentScreenshot: true,
        input: {
          browser: "chrome",
          url: toolInput.url,
          loadWaitSeconds: 8,
        },
      },
      pollAfterMs: 0,
    });
    expect(claimed.command?.input).not.toHaveProperty("presentScreenshot");
  });

  it("requires v13 for an exact screenshot-pixel click", async () => {
    const transactionSql = vi.fn().mockResolvedValueOnce([]);
    const sql = Object.assign(vi.fn(), {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "click",
      toolInput: {
        snapshotRevision: "a".repeat(64),
        coordinateSpace: "screenshot_pixel",
        x: 720,
        y: 450,
        interactionPurpose: "selection",
      },
      executionId: "run-v13-authorized:screenshot-click",
      runId: "run-v13-authorized",
      executionScope: boundExecutionScope("run-v13-authorized"),
    })).rejects.toMatchObject({
      name: "LocalComputerUnavailableError",
      status: 409,
    });

    expect(transactionSql.mock.calls[0]?.slice(1)).toContain(13);
  });

  it("keeps exact accessibility-element clicks compatible with v12", async () => {
    const transactionSql = vi.fn().mockResolvedValueOnce([]);
    const sql = Object.assign(vi.fn(), {
      transaction: vi.fn(
        async (operation: (client: typeof transactionSql) => unknown) =>
          operation(transactionSql),
      ),
    });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "click",
      toolInput: {
        snapshotRevision: "a".repeat(64),
        elementId: "e:aaaaaaaaaaaa:7",
        interactionPurpose: "selection",
      },
      executionId: "run-v12-authorized:element-click",
      runId: "run-v12-authorized",
      executionScope: boundExecutionScope("run-v12-authorized"),
    })).rejects.toMatchObject({
      name: "LocalComputerUnavailableError",
      status: 409,
    });

    expect(transactionSql.mock.calls[0]?.slice(1)).toContain(11);
    expect(transactionSql.mock.calls[0]?.slice(1)).not.toContain(13);
  });

  it("refuses ambiguous raw coordinate clicks before opening a transaction", async () => {
    const sql = Object.assign(vi.fn(), { transaction: vi.fn() });
    mocks.getSql.mockReturnValue(sql);

    await expect(executeLocalComputerCommand({
      action: "click",
      toolInput: {
        snapshotRevision: "a".repeat(64),
        x: 720,
        y: 450,
        interactionPurpose: "selection",
      },
      executionId: "run-v12-authorized:ambiguous-click",
      runId: "run-v12-authorized",
      executionScope: boundExecutionScope("run-v12-authorized"),
    })).rejects.toMatchObject({
      name: "LocalComputerCommandError",
      code: "invalid_input",
    });

    expect(sql.transaction).not.toHaveBeenCalled();
  });
});

function boundExecutionScope(runId: string) {
  return createExecutionScope({
    tenantId: "tenant-binding-test",
    initiatingActorId: "actor-binding-test",
    executingPrincipalType: "agent",
    executingPrincipalId: "principal:orchestrator:1",
    correlationId: runId,
    purpose: "agent.run",
  });
}

function nativeSecurityContext() {
  return {
    tenantId: "tenant-binding-test",
    actorId: "actor-binding-test",
    role: "admin" as const,
    source: "mobile" as const,
    auth: {
      userId: "user-binding-test",
      email: "owner@example.test",
      sessionId: "session-binding-test",
      tenantName: "Example",
    },
    native: {
      deviceId: "device-v13-0001",
      platform: "macos" as const,
      clientContractVersion: 13,
    },
  };
}

function sqlText(strings: unknown) {
  return Array.isArray(strings) ? strings.join("?").replace(/\s+/g, " ") : "";
}
