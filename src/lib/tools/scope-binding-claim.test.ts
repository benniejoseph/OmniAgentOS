import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { readJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  getToolExecutionScopeBinding,
  ToolExecutionScopeBindingError,
  toolInputSha256,
} from "@/lib/tools/execution-scope";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const audit = vi.hoisted(() => ({
  claimIdempotentToolExecution: vi.fn(),
  saveToolExecution: vi.fn(),
}));

// The executor's writes go through to the real store; the spies only record
// what the executor asked it to write.
vi.mock("@/lib/tools/audit-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/audit-store")>();
  audit.claimIdempotentToolExecution.mockImplementation(
    actual.claimIdempotentToolExecution,
  );
  audit.saveToolExecution.mockImplementation(actual.saveToolExecution);
  return {
    ...actual,
    claimIdempotentToolExecution: audit.claimIdempotentToolExecution,
    saveToolExecution: audit.saveToolExecution,
  };
});

const TENANT_ID = "tenant-scope-binding";
const OWNER_ID = "owner-scope-binding";
const TOOL_INPUT = { limit: 1 };

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-scope-binding-"),
  );
  delete process.env.DATABASE_URL;
  vi.clearAllMocks();
});

function scope(initiatingActorId = OWNER_ID) {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId,
    executingPrincipalType: "user",
    executingPrincipalId: initiatingActorId,
    correlationId: "scope-binding-request",
    purpose: "tool.execution.claim",
  });
}

function executing(id: string): ToolExecutionRecord {
  return {
    id,
    tenantId: TENANT_ID,
    actorId: OWNER_ID,
    toolId: "runs.list",
    toolName: "List runs",
    riskLevel: 0,
    status: "executing",
    dryRun: false,
    approvalRequired: false,
    input: TOOL_INPUT,
    output: {
      __executionClaim: {
        token: `${id}-token`,
        claimedAt: new Date().toISOString(),
      },
    },
    createdAt: new Date().toISOString(),
  };
}

async function storedIds() {
  const ledger = await readJsonFile<{ records: ToolExecutionRecord[] }>(
    getDataPath("tools.json"),
    { records: [] },
  );
  return ledger.records.map((record) => record.id);
}

describe("writing a new scoped tool execution with its binding (file mode)", () => {
  it("writes nothing when the scope cannot bind the record", async () => {
    const store = await import("@/lib/tools/audit-store");
    const foreign = {
      executionScope: scope("someone-else"),
      scopeBinding: { toolInput: TOOL_INPUT, requesterRole: "admin" as const },
    };

    await expect(store.claimIdempotentToolExecution(
      executing("foreign-claim"),
      { ...foreign, idempotencyKey: "foreign-claim:call-1" },
    )).rejects.toBeInstanceOf(ToolExecutionScopeBindingError);
    await expect(store.saveToolExecution(executing("foreign-save"), foreign))
      .rejects.toBeInstanceOf(ToolExecutionScopeBindingError);

    expect(await storedIds()).toEqual([]);
  });

  it("needs the execution scope it binds", async () => {
    const store = await import("@/lib/tools/audit-store");
    const unscoped = {
      scopeBinding: { toolInput: TOOL_INPUT, requesterRole: "admin" as const },
    };

    await expect(store.claimIdempotentToolExecution(
      executing("unscoped-claim"),
      { ...unscoped, idempotencyKey: "unscoped-claim:call-1" },
    )).rejects.toThrow("requires an execution scope");
    await expect(store.saveToolExecution(executing("unscoped-save"), unscoped))
      .rejects.toThrow("requires an execution scope");

    expect(await storedIds()).toEqual([]);
  });
});

describe("the executor's scoped writes (file mode)", () => {
  function run(options: { idempotencyKey?: string; scoped?: boolean }) {
    return import("@/lib/tools/executor").then((executor) =>
      executor.executeGovernedTool({
        toolId: "runs.list",
        input: TOOL_INPUT,
        dryRun: false,
        context: {
          tenantId: TENANT_ID,
          actorId: OWNER_ID,
          role: "admin",
          source: "default",
        },
        ...(options.scoped === false ? {} : { executionScope: scope() }),
        ...(options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      })
    );
  }

  async function expectBoundWrite(
    write: typeof audit.claimIdempotentToolExecution,
    record: ToolExecutionRecord,
  ) {
    expect(write).toHaveBeenCalledTimes(1);
    const [written, options] = write.mock.calls[0];
    expect(written).toMatchObject({ id: record.id });
    expect(options).toMatchObject({
      executionScope: scope(),
      scopeBinding: {
        toolInput: expect.objectContaining(TOOL_INPUT),
        requesterRole: "admin",
      },
    });
    const toolInput = options.scopeBinding.toolInput;
    await expect(getToolExecutionScopeBinding(record.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({
        requesterRole: "admin",
        toolId: "runs.list",
        inputSha256: toolInputSha256(toolInput),
      });
  }

  it("asks the claim of a keyed scoped call to bind it", async () => {
    const result = await run({ idempotencyKey: "scope-binding:call-1" });

    expect(result.record.status).toBe("executed");
    await expectBoundWrite(audit.claimIdempotentToolExecution, result.record);
  });

  it("asks the save of an unkeyed scoped call to bind it", async () => {
    const result = await run({});

    expect(result.record.status).toBe("executed");
    await expectBoundWrite(audit.saveToolExecution, result.record);
  });

  it("asks no binding for a call without a scope", async () => {
    const result = await run({
      idempotencyKey: "scope-binding:unscoped",
      scoped: false,
    });

    expect(result.record.status).toBe("executed");
    expect(audit.claimIdempotentToolExecution).toHaveBeenCalledTimes(1);
    expect(audit.claimIdempotentToolExecution.mock.calls[0][1])
      .not.toHaveProperty("scopeBinding");
  });
});
