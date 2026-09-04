import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type { ToolExecutionRecord } from "@/lib/tools/types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-approval-"));
  delete process.env.DATABASE_URL;
});

describe("tool approval claims (file mode)", () => {
  it("allows only one concurrent approver to claim execution", async () => {
    const store = await import("@/lib/tools/audit-store");
    const record = await store.saveToolExecution(pendingRecord("claim-once", 2));
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.approveAndClaimToolExecution({
          id: record.id,
          tenantId: record.tenantId,
          approvedBy: `operator-${index}`,
          approvedRole: "operator",
          claimToken: `claim-${index}`,
        }),
      ),
    );

    const claimed = attempts.filter((attempt) => attempt.outcome === "claimed");
    expect(claimed).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.outcome === "conflict")).toHaveLength(19);

    const winner = claimed[0];
    const wrongCompletion = await store.completeClaimedToolExecution(
      { ...winner.record!, status: "executed", output: { ok: true } },
      "wrong-token",
    );
    expect(wrongCompletion).toBeUndefined();
    const token = String(
      ((winner.record!.output as Record<string, unknown>).__executionClaim as Record<string, unknown>).token,
    );
    expect(
      store.publicToolExecution(winner.record!).output,
    ).not.toHaveProperty("__executionClaim");
    await expect(store.completeClaimedToolExecution(
      { ...winner.record!, status: "executed", output: { ok: true }, completedAt: new Date().toISOString() },
      token,
    )).resolves.toMatchObject({ status: "executed", output: { ok: true } });
  });

  it("atomically preserves risk-3 quorum approvals", async () => {
    const store = await import("@/lib/tools/audit-store");
    const record = await store.saveToolExecution(pendingRecord("risk-three", 3));
    const outcomes = await Promise.all([
      store.approveAndClaimToolExecution({
        id: record.id,
        tenantId: record.tenantId,
        approvedBy: "admin-a",
        approvedRole: "admin",
        claimToken: "risk-claim-a",
      }),
      store.approveAndClaimToolExecution({
        id: record.id,
        tenantId: record.tenantId,
        approvedBy: "admin-b",
        approvedRole: "admin",
        claimToken: "risk-claim-b",
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["claimed", "pending"]);
    const claimed = outcomes.find((outcome) => outcome.outcome === "claimed");
    expect(new Set(claimed?.record?.approvals?.map((approval) => approval.by))).toEqual(
      new Set(["admin-a", "admin-b"]),
    );
  });

  it("recovers stale terminal claims without replaying side effects", async () => {
    const store = await import("@/lib/tools/audit-store");
    const record = pendingRecord("stale-claim", 2);
    await store.saveToolExecution({
      ...record,
      status: "executing",
      output: {
        __executionClaim: {
          token: "stale-token",
          claimedAt: new Date(Date.now() - 120_000).toISOString(),
        },
      },
    });

    const recovered = await store.recoverStaleToolExecutionClaim(record.id, {
      tenantId: record.tenantId,
      staleAfterMs: 60_000,
    });
    expect(recovered).toMatchObject({
      status: "failed",
      reason: "Stale execution claim recovered without replaying the side effect.",
    });
  });

  it("sweeps abandoned approval claims without requiring a replay", async () => {
    const store = await import("@/lib/tools/audit-store");
    const record = pendingRecord("abandoned-approval", 2);
    await store.saveToolExecution({
      ...record,
      status: "executing",
      output: {
        __executionClaim: {
          token: "abandoned-token",
          claimedAt: new Date(Date.now() - 120_000).toISOString(),
        },
      },
    });

    const recovered = await store.recoverStaleToolExecutionClaims({
      tenantId: record.tenantId,
      staleAfterMs: 60_000,
      limit: 10,
    });
    expect(recovered).toEqual([
      expect.objectContaining({
        id: record.id,
        status: "failed",
      }),
    ]);
    await expect(
      store.getToolExecution(record.id, { tenantId: record.tenantId }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "Stale execution claim recovered without replaying the side effect.",
    });
  });

  it("claims an idempotent side effect only once", async () => {
    const store = await import("@/lib/tools/audit-store");
    const claimToken = "idempotent-side-effect-owner";
    const intent: ToolExecutionRecord = {
      ...pendingRecord("idem_workflow_tool", 2),
      status: "executing",
      approvalRequired: false,
      output: {
        __executionClaim: {
          token: claimToken,
          claimedAt: new Date().toISOString(),
        },
      },
    };

    await expect(
      store.claimIdempotentToolExecution(intent),
    ).resolves.toMatchObject({ outcome: "claimed", record: { id: intent.id } });
    await expect(
      store.claimIdempotentToolExecution(intent),
    ).resolves.toMatchObject({
      outcome: "existing",
      record: { id: intent.id, status: "executing" },
    });
    await expect(
      store.completeClaimedToolExecution(
        {
          ...intent,
          status: "executed",
          output: { ok: true },
          completedAt: new Date().toISOString(),
        },
        claimToken,
      ),
    ).resolves.toMatchObject({ status: "executed" });
    await expect(
      store.claimIdempotentToolExecution(intent),
    ).resolves.toMatchObject({
      outcome: "existing",
      record: { id: intent.id, status: "executed", output: { ok: true } },
    });
  });

  it("preserves and narrowly reclaims stale governed memory effects", async () => {
    const store = await import("@/lib/tools/audit-store");
    const effectBinding = {
      __effectIdempotencyKeySha256: "1".repeat(64),
      __effectInputSha256: "2".repeat(64),
      __effectPlanSha256: "3".repeat(64),
      __effectTargetId: `memory_effect_${"4".repeat(56)}`,
      __effectToolContractSha256: "5".repeat(64),
    };
    const intent: ToolExecutionRecord = {
      ...pendingRecord("idem_stale_memory_effect", 1),
      toolId: "memory.write",
      toolName: "Write memory",
      status: "executing",
      dryRun: false,
      approvalRequired: false,
      input: { title: "Stable", content: "Deterministic" },
      output: {
        ...effectBinding,
        __executionClaim: {
          token: "stale-effect-token",
          claimedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        },
      },
    };
    await expect(store.claimIdempotentToolExecution(intent)).resolves.toMatchObject({
      outcome: "claimed",
    });
    await expect(store.recoverStaleToolExecutionClaim(intent.id, {
      tenantId: intent.tenantId,
      staleAfterMs: 60_000,
    })).resolves.toBeUndefined();

    const reclaimed = await store.claimIdempotentToolExecution({
      ...intent,
      output: {
        ...effectBinding,
        __executionClaim: {
          token: "replacement-effect-token",
          claimedAt: new Date().toISOString(),
        },
      },
    });
    expect(reclaimed).toMatchObject({
      outcome: "claimed",
      record: { status: "executing" },
    });
    expect(reclaimed.record.output).toMatchObject({
      __executionClaim: { token: "replacement-effect-token" },
      ...effectBinding,
    });
  });

  it("does not honor an approval record without a durable claim", async () => {
    const store = await import("@/lib/tools/audit-store");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const record = await store.saveToolExecution(pendingRecord("unclaimed-approval", 2));
    const result = await executeGovernedTool({
      toolId: "http.request",
      input: record.input,
      dryRun: false,
      approved: true,
      existingRecord: record,
      context: {
        tenantId: record.tenantId || "tenant-a",
        actorId: "operator-a",
        role: "admin",
        source: "default",
      },
    });
    expect(result.record.status).toBe("approval_required");
  });

  it("closes a durable claim when approved input no longer validates", async () => {
    const store = await import("@/lib/tools/audit-store");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const pending = await store.saveToolExecution({
      ...pendingRecord("invalid-after-claim", 2),
      input: {
        url: "https://8.8.8.8/example",
        method: "POST",
        headers: { authorization: "Bearer must-not-run" },
      },
    });
    const claimToken = "validation-failure-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.id,
      tenantId: pending.tenantId,
      approvedBy: "admin-a",
      approvedRole: "admin",
      claimToken,
    });
    expect(claim.outcome).toBe("claimed");

    const result = await executeGovernedTool({
      toolId: pending.toolId,
      input: pending.input,
      dryRun: false,
      approved: true,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      context: {
        tenantId: "tenant-a",
        actorId: "admin-a",
        role: "admin",
        source: "default",
      },
    });
    expect(result.record).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/could not be validated/i),
    });
    await expect(
      store.getToolExecution(pending.id, { tenantId: "tenant-a" }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("fails closed when the tool contract changes after approval", async () => {
    const store = await import("@/lib/tools/audit-store");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const input = {
      url: "https://8.8.8.8/example",
      method: "POST",
    };
    const pendingWithoutPayload = pendingRecord("changed-contract", 2);
    const pending = await store.saveToolExecution({
      ...pendingWithoutPayload,
      output: store.sealToolExecutionInput(
        input,
        pendingWithoutPayload,
        "stale-contract-fingerprint",
      ),
    });
    const claimToken = "changed-contract-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.id,
      tenantId: pending.tenantId,
      approvedBy: "admin-a",
      approvedRole: "admin",
      claimToken,
    });
    expect(claim.outcome).toBe("claimed");

    const result = await executeGovernedTool({
      toolId: pending.toolId,
      input,
      dryRun: false,
      approved: true,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      context: {
        tenantId: "tenant-a",
        actorId: "admin-a",
        role: "admin",
        source: "default",
      },
    });

    expect(result.record).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/contract changed after approval/i),
    });
  });

  it("rejects secret-bearing HTTP headers before creating an approval", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    await expect(
      executeGovernedTool({
        toolId: "http.request",
        input: {
          url: "https://example.test",
          method: "POST",
          headers: { "x-api-key": "sk-live-secret-that-must-not-persist" },
        },
        dryRun: false,
        context: {
          tenantId: "tenant-a",
          actorId: "operator-a",
          role: "admin",
          source: "default",
        },
      }),
    ).rejects.toThrow(/header is not allowed/i);
  });

  it("accepts a deployer-bound API-key reference without persisting its value", async () => {
    const secretName = "OMNIAGENT_CONNECTOR_HTTP_TEST_SECRET";
    const secretValue = "test-secret-value-that-must-not-persist";
    process.env[secretName] = secretValue;
    process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS = JSON.stringify({
      [secretName]: {
        tenants: ["tenant-a"],
        origins: ["https://8.8.8.8"],
      },
    });
    try {
      const { executeGovernedTool } = await import("@/lib/tools/executor");
      const result = await executeGovernedTool({
        toolId: "http.request",
        input: {
          url: "https://8.8.8.8/example",
          method: "POST",
          authEnv: secretName,
          authHeader: "x-api-key",
          authMode: "raw",
        },
        dryRun: false,
        context: {
          tenantId: "tenant-a",
          actorId: "operator-a",
          role: "admin",
          source: "default",
        },
      });
      expect(result.record).toMatchObject({
        status: "approval_required",
        input: {
          authEnv: secretName,
          authHeader: "x-api-key",
          authMode: "raw",
        },
      });
      expect(JSON.stringify(result.record)).not.toContain(secretValue);
    } finally {
      delete process.env[secretName];
      delete process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS;
    }
  });

  it("seals approval inputs and hides the internal payload from public records", async () => {
    const store = await import("@/lib/tools/audit-store");
    const rawInput = {
      url: "https://8.8.8.8/example",
      method: "POST",
      body: { password: "exact-value-needed-after-approval" },
    };
    const recordWithoutPayload: ToolExecutionRecord = {
      ...pendingRecord("sealed-input", 2),
      input: {
        url: rawInput.url,
        method: rawInput.method,
        body: { password: "[redacted]" },
      },
    };
    const record: ToolExecutionRecord = {
      ...recordWithoutPayload,
      output: store.sealToolExecutionInput(
        rawInput,
        recordWithoutPayload,
        "reviewed-contract-fingerprint",
      ),
    };

    expect(store.openToolExecutionInput(record)).toEqual(rawInput);
    expect(JSON.stringify(store.publicToolExecution(record))).not.toContain(
      "exact-value-needed-after-approval",
    );
    expect(store.publicToolExecution(record).output).toEqual({});

    expect(() =>
      store.openToolExecutionInput({
        ...record,
        id: "different-approval",
      }),
    ).toThrow(/could not be authenticated/i);
  });

  it("does not evict pending claims when trimming the local audit ledger", async () => {
    const store = await import("@/lib/tools/audit-store");
    const pending = pendingRecord("durable-pending", 2);
    const terminal = Array.from({ length: 250 }, (_, index): ToolExecutionRecord => ({
      ...pendingRecord(`terminal-${index}`, 2),
      status: "executed",
      completedAt: new Date().toISOString(),
    }));
    await writeJsonFile(getDataPath("tools.json"), { records: [pending, ...terminal] });

    await store.saveToolExecution({
      ...pendingRecord("new-terminal", 2),
      status: "executed",
      completedAt: new Date().toISOString(),
    });

    await expect(
      store.getToolExecution(pending.id, { tenantId: pending.tenantId }),
    ).resolves.toMatchObject({ id: pending.id, status: "approval_required" });
  });
});

function pendingRecord(id: string, riskLevel: 2 | 3): ToolExecutionRecord {
  return {
    id,
    tenantId: "tenant-a",
    actorId: "requester",
    toolId: "http.request",
    toolName: "HTTP request",
    riskLevel,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: "https://8.8.8.8/example", method: "POST" },
    createdAt: new Date().toISOString(),
  };
}
