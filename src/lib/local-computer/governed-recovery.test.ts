import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";
import { localComputerFailureMetadata } from "@/lib/local-computer/command-failure";

const mocks = vi.hoisted(() => ({ executeLocalComputerCommand: vi.fn() }));
vi.mock("@/lib/local-computer/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-computer/store")>()),
  executeLocalComputerCommand: mocks.executeLocalComputerCommand,
}));

const first = "a".repeat(64);
const fresh = "b".repeat(64);
const after = "c".repeat(64);
const scope = { tenantId: "tenant-recovery", actorId: "owner-recovery", runId: "run-mac-recovery" };
const context = {
  tenantId: scope.tenantId, actorId: scope.actorId, role: "admin" as const, source: "mobile" as const,
  auth: { userId: "user-recovery", email: "owner@example.test", sessionId: "native-session", tenantName: "Recovery" },
  native: { deviceId: "selected-mac", platform: "macos" as const, clientContractVersion: 60 },
};
const executionScope = createExecutionScope({
  tenantId: scope.tenantId, initiatingActorId: scope.actorId,
  executingPrincipalType: "agent", executingPrincipalId: "agent:atlas",
  correlationId: scope.runId, purpose: "agent.run",
});
const base = {
  dryRun: false, context, executionScope, agentRunId: scope.runId,
  localComputerTaskAuthority: { objective: "Select the existing Chrome tab." },
};
const elementId = (revision: string, slot: number) => `e:${revision.slice(0, 12)}:${slot}`;
const clickInput = { snapshotRevision: first, elementId: elementId(first, 1), interactionPurpose: "navigation" };

function observed(snapshotRevision: string, inputDelivered = false) {
  return {
    publicResult: { summary: inputDelivered ? "Pressed the accessibility element." : "Observed the current screen." },
    observation: { snapshotRevision,
      frontmostApplication: { name: "Chrome", bundleId: "com.google.Chrome", pid: 123 },
      accessibilitySnapshot: `id=${elementId(snapshotRevision, 2)} role=AXButton actions=AXPress`,
    },
  };
}

describe("governed Mac recovery with native transport mocked", () => {
  const originalDataDir = process.env.OMNIAGENT_DATA_DIR;
  const originalDatabase = process.env.DATABASE_URL;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "asael-governed-recovery-"));
    process.env.OMNIAGENT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.OMNIAGENT_DATA_DIR;
    else process.env.OMNIAGENT_DATA_DIR = originalDataDir;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists an AX refusal, blocks unchanged replay, then observes and executes a governed semantic Press", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { LocalComputerCommandError } = await import("@/lib/local-computer/store");
    const { createRunToolRecovery } = await import("@/lib/orchestration/tool-recovery");
    const { getToolExecution } = await import("@/lib/tools/audit-store");
    const recovery = createRunToolRecovery(scope);
    const execute = recovery.wrap(executeGovernedTool);
    const failure = localComputerFailureMetadata("click_target_covered", {
      schemaVersion: 1, code: "click_target_covered", phase: "element_hit_test", reason: "hit_outside_chosen_element",
    });
    mocks.executeLocalComputerCommand.mockRejectedValueOnce(new LocalComputerCommandError("click_target_covered", "The selected element did not receive the click.", failure));
    const firstAttempt = { ...base, toolId: "local.macos.click", input: clickInput, idempotencyKey: "ax-first" };
    const refused = await execute(firstAttempt);
    expect(refused.record.status).toBe("failed");
    expect(refused.record.output).toMatchObject({ localComputerFailure: { phase: "element_hit_test", reason: "hit_outside_chosen_element" } });
    expect(await getToolExecution(refused.record.id, { tenantId: scope.tenantId })).toMatchObject({ status: "failed" });

    const replay = await execute(firstAttempt);
    expect(replay.record.id).toBe(refused.record.id);
    expect(recovery.snapshot().mac.consecutiveRefusals).toBe(1);
    const blocked = await execute({ ...firstAttempt, idempotencyKey: "ax-unchanged" });
    expect(blocked.record).toMatchObject({ status: "blocked", output: { executed: false, localComputerRecovery: { code: "fresh_observation_required" } } });
    expect(await getToolExecution(blocked.record.id, { tenantId: scope.tenantId })).toMatchObject({ status: "blocked" });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(1);

    // The continuation keeps the same refusal fence; it cannot regain retry authority.
    const resumed = createRunToolRecovery(scope, recovery.snapshot());
    const resumedExecute = resumed.wrap(executeGovernedTool);
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(fresh));
    const observation = await resumedExecute({ ...base, toolId: "local.macos.observe", input: { includeScreenshot: false }, idempotencyKey: "ax-observe" });
    expect(observation.computerObservation?.snapshotRevision).toBe(fresh);
    const unchanged = await resumedExecute({ ...firstAttempt, input: { ...clickInput, snapshotRevision: fresh,
      elementId: elementId(fresh, 1) }, idempotencyKey: "ax-unchanged-fresh" });
    expect(unchanged.record).toMatchObject({ status: "blocked", output: { localComputerRecovery: { code: "unchanged_target_refused" } } });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(2);

    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(after, true));
    const pressed = await resumedExecute({ ...base, toolId: "local.macos.press",
      input: { snapshotRevision: fresh, elementId: elementId(fresh, 2), interactionPurpose: "navigation" }, idempotencyKey: "ax-semantic-press" });
    expect(pressed.record.status).toBe("executed");
    expect(pressed.result).toEqual({ summary: "Pressed the accessibility element." });
    expect(pressed.computerObservation?.snapshotRevision).toBe(after);
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(3);
    expect(mocks.executeLocalComputerCommand.mock.calls[2]?.[0]).toMatchObject({ action: "press", toolInput: { snapshotRevision: fresh, elementId: elementId(fresh, 2) } });
    expect(resumed.snapshot().mac.consecutiveRefusals).toBe(0);
  });

  it("requires a genuinely new observation after stale state before one fresh target attempt", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { LocalComputerCommandError } = await import("@/lib/local-computer/store");
    const { createRunToolRecovery } = await import("@/lib/orchestration/tool-recovery");
    const execute = createRunToolRecovery(scope).wrap(executeGovernedTool);
    mocks.executeLocalComputerCommand.mockRejectedValueOnce(new LocalComputerCommandError("stale_observation", "The snapshot is stale.", localComputerFailureMetadata("stale_observation")));
    expect((await execute({ ...base, toolId: "local.macos.click", input: clickInput, idempotencyKey: "stale-first" })).record.status).toBe("failed");
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(first));
    await execute({ ...base, toolId: "local.macos.observe", input: { includeScreenshot: false }, idempotencyKey: "stale-old-observe" });
    expect((await execute({ ...base, toolId: "local.macos.click", input: clickInput, idempotencyKey: "stale-blocked" })).record.status).toBe("blocked");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(2);
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(fresh));
    await execute({ ...base, toolId: "local.macos.observe", input: { includeScreenshot: false }, idempotencyKey: "stale-fresh-observe" });
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(after, true));
    const retried = await execute({ ...base, toolId: "local.macos.click", input: { ...clickInput,
      snapshotRevision: fresh, elementId: elementId(fresh, 1) }, idempotencyKey: "stale-fresh-attempt" });
    expect(retried.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(4);
  });

  it("does not repeat partially delivered text whose audit representation was redacted", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { LocalComputerCommandError } = await import("@/lib/local-computer/store");
    const { createRunToolRecovery } = await import("@/lib/orchestration/tool-recovery");
    const execute = createRunToolRecovery(scope).wrap(executeGovernedTool);
    const input = { snapshotRevision: first, text: "Set password=synthetic-test-only-value" };
    mocks.executeLocalComputerCommand.mockRejectedValueOnce(new LocalComputerCommandError(
      "typing_interrupted", "Focus moved during input.", localComputerFailureMetadata("typing_interrupted"),
    ));
    const failure = await execute({ ...base, toolId: "local.macos.type", input,
      idempotencyKey: "typing-partial" });
    expect(failure.record.status).toBe("failed");
    expect(failure.record.input.text).not.toBe(input.text);
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(fresh));
    await execute({ ...base, toolId: "local.macos.observe", input: { includeScreenshot: false },
      idempotencyKey: "typing-fresh-observe" });
    const replay = await execute({ ...base, toolId: "local.macos.type",
      input: { ...input, snapshotRevision: fresh }, idempotencyKey: "typing-same-text" });
    expect(replay.record).toMatchObject({ status: "blocked", output: {
      executed: false, localComputerRecovery: { code: "unchanged_target_refused" },
    } });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(2);
  });

  it("keeps an authority refusal failed and requires the exact separate approval before dispatch", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { LocalComputerCommandError } = await import("@/lib/local-computer/store");
    const { createRunToolRecovery } = await import("@/lib/orchestration/tool-recovery");
    const store = await import("@/lib/tools/audit-store");
    const recovery = createRunToolRecovery(scope);
    const execute = recovery.wrap(executeGovernedTool);
    mocks.executeLocalComputerCommand.mockRejectedValueOnce(new LocalComputerCommandError("task_authority_refused", "Device requires review.", localComputerFailureMetadata("task_authority_refused")));
    const request = { ...base, toolId: "local.macos.click", input: clickInput, idempotencyKey: "authority-first" };
    const review = await execute(request);
    expect(review.record.status).toBe("approval_required");
    const originalId = mocks.executeLocalComputerCommand.mock.calls[0]?.[0].executionId as string;
    expect(review.record.id).not.toBe(originalId);
    expect(await store.getToolExecution(originalId, { tenantId: scope.tenantId })).toMatchObject({ status: "failed", output: { localComputerFailure: { code: "task_authority_refused" } } });
    expect(store.openToolExecutionInput(review.record)).toEqual(clickInput);
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(1);
    expect(recovery.snapshot().mac.consecutiveRefusals).toBe(1);
    expect(review.precedingRefusal?.id).toBe(originalId);
    const repeated = await execute({ ...request, idempotencyKey: "authority-unreviewed-repeat" });
    expect(repeated.record).toMatchObject({ status: "blocked", output: {
      executed: false, localComputerRecovery: { code: "approval_required" },
    } });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(1);
    const claimToken = "recovery-exact-review-claim";
    const claim = await store.approveAndClaimToolExecution({ id: review.record.id, tenantId: scope.tenantId,
      approvedBy: scope.actorId, approvedRole: "admin", claimToken });
    expect(claim.record).toBeDefined();
    mocks.executeLocalComputerCommand.mockResolvedValueOnce(observed(after, true));
    const approved = await execute({ ...base, toolId: review.record.toolId, input: store.openToolExecutionInput(claim.record!),
      approved: true, existingRecord: claim.record, executionClaimToken: claimToken });
    expect(approved.record.status).toBe("executed");
    expect(recovery.snapshot().mac.consecutiveRefusals).toBe(0);
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(2);
    expect(mocks.executeLocalComputerCommand.mock.calls[1]?.[0]).toMatchObject({ executionId: review.record.id, toolInput: clickInput });
    expect(store.isLocalComputerTaskAuthorityExecution(approved.record)).toBe(false);
  });
});
