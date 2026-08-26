import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rateLimit = vi.hoisted(() => ({ check: vi.fn() }));
const trust = vi.hoisted(() => ({
  resolve: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: rateLimit.check,
}));

vi.mock("@/lib/trust/ledger", () => ({
  actionClassFor: (toolId: string) => toolId,
  recordActionOutcome: trust.record,
  resolveAutonomy: trust.resolve,
}));

describe("governed tool idempotency", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-tool-idempotency-"),
    );
    process.env.OMNIAGENT_GRADUATED_AUTONOMY = "true";
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    rateLimit.check.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    trust.resolve.mockResolvedValue({
      mode: "auto_with_alert",
      stage: "autonomous",
      reason: "earned",
      cleanStreak: 100,
      threshold: 25,
      progress: 1,
      eligible: true,
      score: 1,
      confidence: 1,
      effectiveSampleSize: 100,
      freshness: 1,
      budget: { maxActions: 8, windowSeconds: 3_600 },
    });
  });

  it("returns an existing receipt before consuming autonomy budget", async () => {
    const tenantId = "tenant-idempotent-autonomy";
    const idempotencyKey = "run-1:call-1";
    const input = {
      title: "Existing memory",
      content: "This side effect has already completed.",
    };
    const id = `idem_${createHash("sha256")
      .update(`${tenantId}\u0000${idempotencyKey}`)
      .digest("hex")}`;
    const store = await import("@/lib/tools/audit-store");
    await store.saveToolExecution({
      id,
      tenantId,
      actorId: "owner",
      toolId: "memory.write",
      toolName: "Write Memory",
      riskLevel: 1,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input,
      output: { memoryId: "memory-existing" },
      reason: "Previously executed.",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "memory.write",
      input,
      dryRun: false,
      idempotencyKey,
      context: {
        tenantId,
        actorId: "owner",
        role: "admin",
        source: "default",
      },
    });

    expect(result).toMatchObject({
      record: { id, status: "executed" },
      result: { memoryId: "memory-existing" },
    });
    expect(trust.resolve).not.toHaveBeenCalled();
    expect(rateLimit.check).not.toHaveBeenCalled();
  });
});
