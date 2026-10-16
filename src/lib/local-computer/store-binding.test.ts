import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(
    async (_event: { id: string; payload: Record<string, unknown> }) => ({
      id: "event",
    }),
  ),
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
  completeLocalComputerCommand,
  executeLocalComputerCommand,
  startLocalComputerSession,
} from "@/lib/local-computer/store";
import type { SecurityContext } from "@/lib/security/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { localComputerTaskAuthorityIntentOutput } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("local Computer Use command binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a retried request's session restart as its own start", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-27T08:00:00.000Z") });
    try {
      // The event store keeps an id bound to the first payload it recorded.
      const recorded = new Map<string, string>();
      mocks.appendScopedDomainEvent.mockImplementation(async (event) => {
        const payload = JSON.stringify(event.payload);
        if (recorded.has(event.id) && recorded.get(event.id) !== payload) {
          throw new Error("Domain event id is already bound to a different event.");
        }
        recorded.set(event.id, payload);
        return { id: event.id };
      });
      mocks.getSql.mockReturnValue(
        vi.fn(async (strings: TemplateStringsArray) =>
          strings.join("").includes("INSERT INTO omni_local_computer_sessions")
            ? [{ id: "local_computer_session_row" }]
            : [{ command_runner: null }],
        ),
      );
      const context: SecurityContext = {
        tenantId: "tenant-session-retry",
        actorId: "actor-session-retry",
        role: "operator",
        source: "mobile",
        auth: {
          userId: "user-session-retry",
          email: "operator@example.test",
          sessionId: "session-retry",
          tenantName: "Example",
        },
        native: {
          deviceId: "device-session-retry",
          platform: "macos",
          appVersion: "1.6.0",
          buildNumber: 7,
          clientContractVersion: 13,
          clientAttestedAt: "2026-09-27T07:59:00.000Z",
        },
      };

      const first = await startLocalComputerSession(context, "run-retried-request");
      vi.advanceTimersByTime(5_000);
      const retried = await startLocalComputerSession(context, "run-retried-request");

      expect(retried.id).toBe(first.id);
      expect(Date.parse(retried.expiresAt)).toBe(Date.parse(first.expiresAt) + 5_000);
      expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
      expect(recorded.size).toBe(2);
    } finally {
      vi.useRealTimers();
      mocks.appendScopedDomainEvent.mockImplementation(async () => ({ id: "event" }));
    }
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

  it.each([13, 58, 59])("advertises optional refusal receipts only to compatible Mac claims at v%d", async (version) => {
    const toolInput = { includeScreenshot: false };
    claimSql("observe", toolInput);
    mocks.getToolExecution.mockResolvedValueOnce({ toolId: "local.macos.observe" });
    mocks.openToolExecutionInput.mockReturnValueOnce(toolInput);

    const claimed = await claimLocalComputerCommand(nativeSecurityContext(version));
    expect(claimed.command).not.toBeNull();
    if (version >= 59) expect(claimed.command).toHaveProperty("failureDetailsVersion", 1);
    else expect(claimed.command).not.toHaveProperty("failureDetailsVersion");
  });

  it("enqueues Asael navigation only through the exact actor/run/device v58 binding", async () => {
    const transactionSql = vi.fn().mockResolvedValueOnce([]);
    mocks.getSql.mockReturnValue(Object.assign(vi.fn(), {
      transaction: vi.fn(async (operation: (sql: typeof transactionSql) => unknown) => operation(transactionSql)),
    }));
    await expect(executeLocalComputerCommand({
      action: "open_asael", toolInput: { destination: "work" },
      executionId: "run-navigation:open", runId: "run-navigation",
      executionScope: boundExecutionScope("run-navigation"),
    })).rejects.toMatchObject({ name: "LocalComputerUnavailableError" });
    const query = sqlText(transactionSql.mock.calls[0]?.[0]);
    expect(transactionSql.mock.calls[0]?.slice(1)).toContain(58);
    expect(query).toContain("run.owner_actor_id = session.owner_actor_id");
    expect(query).toContain("native_session.revoked_at IS NULL");
    expect(query).toContain("run.status = 'running'");
    expect(query).toContain("device.permission_status ->> 'screenRecording' = 'granted'");
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("rejects unsupported Asael routes before a command can be queued", async () => {
    await expect(executeLocalComputerCommand({
      action: "open_asael", toolInput: { destination: "approvals" },
      executionId: "run-navigation:open", runId: "run-navigation",
      executionScope: boundExecutionScope("run-navigation"),
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it("revalidates v58 and the exact executing governed input at navigation claim", async () => {
    for (const version of [57, 58]) {
      const input = { destination: "library" };
      const sql = claimSql("open_asael", input);
      mocks.getToolExecution.mockResolvedValueOnce({ id: "run-claim-open_asael:execution", tenantId: "tenant-binding-test", actorId: "actor-binding-test", toolId: "local.macos.open_asael", status: "executing", dryRun: false });
      mocks.openToolExecutionInput.mockReturnValueOnce(input);
      const result = await claimLocalComputerCommand(nativeSecurityContext(version));
      if (version === 57) expect(result.command).toBeNull();
      else expect(result.command).toMatchObject({ action: "open_asael", input, presentScreenshot: false });
      const query = sqlText(sql.mock.calls[2]?.[0]);
      expect(query).toContain("active_run.owner_actor_id = command.owner_actor_id");
      expect(query).toContain("command.action <> 'open_asael'");
      expect(query).toContain("device.permission_status ->> 'screenRecording' = 'granted'");
      expect(query).toContain("command.action IN ('observe', 'list_apps')");
    }
  });

  it.each([
    { toolId: "local.macos.open_asael", status: "approval_required", dryRun: false },
    { toolId: "local.macos.open_asael", status: "executing", dryRun: true },
    { toolId: "local.macos.open_url", status: "executing", dryRun: false },
    { toolId: "local.macos.open_asael", status: "executing", dryRun: false, actorId: "another-actor" },
    { toolId: "local.macos.open_asael", status: "executing", dryRun: false, tenantId: "another-tenant" },
    { toolId: "local.macos.open_asael", status: "executing", dryRun: false, id: "another-execution" },
  ])("refuses a non-authorizing navigation execution at claim: %j", async (execution) => {
    const input = { destination: "work" };
    claimSql("open_asael", input);
    mocks.getToolExecution.mockResolvedValueOnce({ id: "run-claim-open_asael:execution", tenantId: "tenant-binding-test", actorId: "actor-binding-test", ...execution });
    await expect(claimLocalComputerCommand(nativeSecurityContext(58))).rejects.toMatchObject({ code: "invalid_binding" });
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

  it("persists only validated refusal metadata and binds receipt replay to its unchanged code", async () => {
    const failure = { schemaVersion: 1 as const, code: "click_target_covered" as const,
      phase: "element_hit_test" as const, reason: "hit_outside_chosen_element" as const };
    const completion = { schemaVersion: 1 as const, claimToken: "a".repeat(32),
      outcome: "failed" as const, errorCode: failure.code, failure };
    const result = { failure };
    const row = { id: "local_computer_command_test", outcome: "failed", error_code: failure.code,
      claim_token_sha256: createHash("sha256").update(completion.claimToken).digest("hex"),
      result_sha256: canonicalJsonSha256(result), completed_at: new Date().toISOString() };
    const sql = vi.fn().mockResolvedValueOnce([row]);
    mocks.getSql.mockReturnValue(sql);
    expect(await completeLocalComputerCommand(nativeSecurityContext(), row.id, completion)).toMatchObject({ accepted: true, resultSha256: canonicalJsonSha256(result) });
    expect(sql.mock.calls[0]?.slice(1)).toContainEqual(result);
    expect(sql.mock.calls[0]?.slice(1)).toContain(canonicalJsonSha256(result));

    // The identical completion is idempotent; a changed failure is not.
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    await expect(completeLocalComputerCommand(nativeSecurityContext(), row.id, completion)).resolves.toMatchObject({ accepted: true });
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...row, error_code: "different_error" }]);
    await expect(completeLocalComputerCommand(nativeSecurityContext(), row.id, completion)).rejects.toMatchObject({ name: "LocalComputerUnavailableError" });
  });

  it("rejects mismatched refusal metadata before any completion write", async () => {
    const sql = vi.fn();
    mocks.getSql.mockReturnValue(sql);
    await expect(completeLocalComputerCommand(nativeSecurityContext(), "local_computer_command_test", {
      schemaVersion: 1, claimToken: "a".repeat(32), outcome: "failed", errorCode: "stale_observation",
      failure: { schemaVersion: 1, code: "click_target_covered", phase: "element_hit_test", reason: "hit_outside_chosen_element" },
    })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });

  it("returns the persisted refusal as a typed command error without reporting successful execution", async () => {
    const toolInput = { snapshotRevision: "a".repeat(64), elementId: "e:tab:1", interactionPurpose: "navigation" };
    const failure = { schemaVersion: 1, code: "click_target_covered", phase: "element_hit_test", reason: "hit_outside_chosen_element" };
    const transactionSql = vi.fn()
      .mockResolvedValueOnce([{ id: "session-refusal", device_id: "device-refusal", run_id: "run-refusal" }])
      .mockResolvedValueOnce([{ id: "command-refusal", action: "click", input_sha256: canonicalJsonSha256(toolInput),
        session_id: "session-refusal", device_id: "device-refusal", expires_at: new Date(Date.now() + 30_000).toISOString() }]);
    const sql = Object.assign(vi.fn().mockResolvedValue([{ state: "failed", error_code: failure.code, result: { failure } }]), {
      transaction: vi.fn(async (operation: (client: typeof transactionSql) => unknown) => operation(transactionSql)),
    });
    mocks.getSql.mockReturnValue(sql);
    await expect(executeLocalComputerCommand({ action: "click", toolInput, executionId: "run-refusal:click", runId: "run-refusal", executionScope: boundExecutionScope("run-refusal") })).rejects.toMatchObject({
      name: "LocalComputerCommandError", code: "click_target_covered",
      failure: { phase: "element_hit_test", reason: "hit_outside_chosen_element", recovery: { nextAction: "observe_then_semantic_action", automaticReplayAllowed: false } },
    });
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
