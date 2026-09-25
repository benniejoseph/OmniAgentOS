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
vi.mock("@/lib/tools/audit-store", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/tools/audit-store")
  >();
  return {
    getToolExecution: mocks.getToolExecution,
    isLocalComputerTaskAuthorityExecution:
      actual.isLocalComputerTaskAuthorityExecution,
    localComputerTaskAuthorityIntentOutput:
      actual.localComputerTaskAuthorityIntentOutput,
    openToolExecutionInput: mocks.openToolExecutionInput,
  };
});

import {
  claimLocalComputerCommand,
  executeLocalComputerCommand,
} from "@/lib/local-computer/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { localComputerTaskAuthorityIntentOutput } from "@/lib/tools/audit-store";
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

  const taskAuthorityChecks = [
    ["press", "local.macos.press", { elementId: "e:aaaaaaaaaaaa:3" }],
    ["click", "local.macos.click", { elementId: "e:aaaaaaaaaaaa:4" }],
    ["key", "local.macos.key", { key: "tab" }],
    ["type", "local.macos.type", { text: "XAUUSD" }],
  ] as const;

  it.each(taskAuthorityChecks)(
    "never hands an older Mac client a %s that runs on task authority alone",
    async (action, toolId, fields) => {
      for (const clientContractVersion of [13, 29]) {
        const toolInput = { snapshotRevision: "a".repeat(64), ...fields };
        const sql = claimSql(action, toolInput);
        mocks.getToolExecution.mockResolvedValueOnce({
          toolId,
          output: localComputerTaskAuthorityIntentOutput(),
        });
        mocks.openToolExecutionInput.mockReturnValueOnce(toolInput);

        const claimed = await claimLocalComputerCommand(
          nativeSecurityContext(clientContractVersion),
        );

        // This client cannot check the real on-screen target, so the command
        // fails at claim and the executor asks the user instead.
        expect(claimed).toMatchObject({ command: null, pollAfterMs: 0 });
        const gate = sql.mock.calls[3];
        expect(sqlText(gate?.[0])).toContain("SET state = 'failed'");
        expect(sqlText(gate?.[0])).toContain("AND state = 'claimed'");
        expect(gate?.slice(1)).toContain("task_authority_unattested");
        expect(gate?.slice(1)).toContain(`local_computer_command_${"c".repeat(48)}`);
      }
    },
  );

  it.each(taskAuthorityChecks)(
    "hands a v30 Mac client a task-authorized %s marked for its target check",
    async (action, toolId, fields) => {
      const toolInput = { snapshotRevision: "a".repeat(64), ...fields };
      const sql = claimSql(action, toolInput);
      mocks.getToolExecution.mockResolvedValueOnce({
        toolId,
        output: localComputerTaskAuthorityIntentOutput(),
      });
      mocks.openToolExecutionInput.mockReturnValueOnce(toolInput);

      const claimed = await claimLocalComputerCommand(nativeSecurityContext(30));

      expect(claimed).toMatchObject({
        command: { action, authority: "task" },
        pollAfterMs: 0,
      });
      // The helper refuses a target that task authority does not cover, so
      // the claim itself changes nothing more.
      expect(sql).toHaveBeenCalledTimes(3);
    },
  );

  it("delivers reviewed and URL commands that carry no on-screen check", async () => {
    for (const clientContractVersion of [13, 30]) {
      const click = { snapshotRevision: "a".repeat(64), elementId: "e:aaaaaaaaaaaa:5" };
      claimSql("click", click);
      mocks.getToolExecution.mockResolvedValueOnce({
        toolId: "local.macos.click",
        output: {},
      });
      mocks.openToolExecutionInput.mockReturnValueOnce(click);
      const reviewed = await claimLocalComputerCommand(
        nativeSecurityContext(clientContractVersion),
      );
      expect(reviewed).toMatchObject({ command: { action: "click" } });
      expect(reviewed.command).not.toHaveProperty("authority");

      // The executor bounds task-authorized navigation to sites the user
      // named; the helper has no on-screen target to check for a URL.
      const url = { browser: "chrome", url: "https://www.tradingview.com/" };
      claimSql("open_url", url);
      mocks.getToolExecution.mockResolvedValueOnce({
        toolId: "local.macos.open_url",
        output: localComputerTaskAuthorityIntentOutput(),
      });
      mocks.openToolExecutionInput.mockReturnValueOnce(url);
      const navigation = await claimLocalComputerCommand(
        nativeSecurityContext(clientContractVersion),
      );
      expect(navigation).toMatchObject({ command: { action: "open_url" } });
      expect(navigation.command).not.toHaveProperty("authority");
    }
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

function nativeSecurityContext(clientContractVersion = 13) {
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
      clientContractVersion,
    },
  };
}

/** Scrub, stale-claim, and claim queries, then any follow-up update. */
function claimSql(action: string, toolInput: Record<string, unknown>) {
  const sql = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{
      id: `local_computer_command_${"c".repeat(48)}`,
      run_id: `run-claim-${action}`,
      execution_id: `run-claim-${action}:execution`,
      action,
      input_sha256: canonicalJsonSha256(toolInput),
      claim_generation: 1,
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    }])
    .mockResolvedValue([]);
  mocks.getSql.mockReturnValue(sql);
  return sql;
}

function sqlText(strings: unknown) {
  return Array.isArray(strings) ? strings.join("?").replace(/\s+/g, " ") : "";
}
