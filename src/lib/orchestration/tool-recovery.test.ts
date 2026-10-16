import { describe, expect, it, vi } from "vitest";
import { createRunToolRecovery, readRunToolRecoverySnapshot } from "./tool-recovery";
import { localComputerFailureMetadata } from "@/lib/local-computer/command-failure";
import type { executeGovernedTool } from "@/lib/tools/executor";

const scope = { tenantId: "tenant-recovery", actorId: "owner-recovery", runId: "run-recovery" };
const context = { ...scope, role: "admin" as const, source: "session" as const };
const oldRevision = "a".repeat(64);
const newRevision = "b".repeat(64);
const click = { toolId: "local.macos.click", input: { snapshotRevision: oldRevision,
  bundleId: "com.apple.Safari", x: 14, y: 25, interactionPurpose: "media_control" } };
type Execution = Awaited<ReturnType<typeof executeGovernedTool>>;
function receipt(id: string, status: "failed" | "executed", toolId = click.toolId): Execution {
  return { record: { id, tenantId: scope.tenantId, actorId: scope.actorId,
    toolId, toolName: toolId, riskLevel: 1, dryRun: false, approvalRequired: false,
    status, input: click.input, createdAt: new Date().toISOString(),
    output: status === "failed" ? { localComputerFailure: localComputerFailureMetadata("click_target_covered", {
      schemaVersion: 1, code: "click_target_covered", phase: "element_hit_test", reason: "hit_outside_chosen_element",
    }) } : {},
  }, result: status === "executed" ? { summary: "Delivered the input." } : null };
}
function requested() { return { ...click, context, agentRunId: scope.runId, dryRun: false }; }

describe("run recovery continuity", () => {
  it("pins the original scope even if its caller later mutates the input object", async () => {
    const suppliedScope = { ...scope };
    const tracker = createRunToolRecovery(suppliedScope);
    suppliedScope.actorId = "other-owner";
    suppliedScope.runId = "other-run";
    expect(tracker.snapshot().scope).toEqual(scope);
    const executor = vi.fn<typeof executeGovernedTool>().mockResolvedValue(receipt("scoped-result", "executed"));
    await tracker.wrap(executor)(requested());
    expect(executor).toHaveBeenCalledOnce();
  });

  it("retains a refused target across approval persistence without retaining screen or typed content", async () => {
    const tracker = createRunToolRecovery(scope);
    tracker.observe(receipt("failed-click", "failed"));
    const snapshot = tracker.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("com.apple.Safari");
    expect(readRunToolRecoverySnapshot(snapshot)).toEqual(snapshot);
    const restored = createRunToolRecovery(scope, snapshot);
    const executor = vi.fn<typeof executeGovernedTool>().mockResolvedValue(receipt("denied-attempt", "failed"));
    await restored.wrap(executor)(requested());
    expect(executor.mock.calls[0][0].recoveryConstraint).toMatchObject({
      output: { executed: false, localComputerRecovery: { code: "fresh_observation_required" } },
    });
  });

  it("does not reset a later refusal when an earlier successful idempotent receipt is replayed", async () => {
    const tracker = createRunToolRecovery(scope);
    tracker.observe(receipt("earlier-success", "executed"));
    tracker.observe(receipt("later-failure", "failed"));
    const restored = createRunToolRecovery(scope, tracker.snapshot());
    restored.observe(receipt("earlier-success", "executed"));
    const executor = vi.fn<typeof executeGovernedTool>().mockResolvedValue(receipt("blocked", "failed"));
    await restored.wrap(executor)(requested());
    expect(executor.mock.calls[0][0].recoveryConstraint).toBeDefined();
    expect(restored.snapshot().mac.consecutiveRefusals).toBe(2);
  });

  it("counts a failed idempotent receipt once and never treats model input as a fresh observation", async () => {
    const tracker = createRunToolRecovery(scope);
    tracker.observe(receipt("one-failure", "failed"));
    tracker.observe(receipt("one-failure", "failed"));
    const restored = createRunToolRecovery(scope, tracker.snapshot());
    restored.observe(receipt("one-failure", "failed"));
    expect(restored.snapshot().mac.consecutiveRefusals).toBe(1);
    const executor = vi.fn<typeof executeGovernedTool>().mockResolvedValue(receipt("another-result", "failed"));
    await restored.wrap(executor)({ ...requested(), input: { ...click.input, snapshotRevision: newRevision } });
    expect(executor.mock.calls[0][0].recoveryConstraint?.output).toMatchObject({
      localComputerRecovery: { code: "fresh_observation_required" },
    });
  });

  it("refuses corrupt, oversized, or cross-run state and cross-actor dispatch", async () => {
    const snapshot = createRunToolRecovery(scope).snapshot();
    expect(() => createRunToolRecovery({ ...scope, runId: "other-run" }, snapshot)).toThrow(/match/);
    expect(readRunToolRecoverySnapshot({ ...snapshot, mac: {} })).toBeUndefined();
    expect(readRunToolRecoverySnapshot({ ...snapshot, web: undefined })).toBeUndefined();
    expect(readRunToolRecoverySnapshot({ ...snapshot, observedExecutionIds: Array(1_025).fill("x") })).toBeUndefined();
    const executor = vi.fn<typeof executeGovernedTool>();
    await expect(createRunToolRecovery(scope).wrap(executor)({ ...requested(),
      context: { ...context, actorId: "different-owner" },
    })).rejects.toThrow(/scope mismatch/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not confuse an approval queue receipt with its later completed delivery", () => {
    const tracker = createRunToolRecovery(scope);
    tracker.observe(receipt("refused", "failed"));
    const queued = receipt("approved-press", "executed", "local.macos.press");
    queued.record.status = "approval_required";
    tracker.observe(queued);
    tracker.observe(receipt("approved-press", "executed", "local.macos.press"));
    expect(tracker.snapshot().mac.consecutiveRefusals).toBe(0);
    expect(tracker.snapshot().mac.failedTargets).toEqual([]);
  });
});
