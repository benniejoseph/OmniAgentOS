import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  executeLocalComputerCommand: vi.fn(),
}));

vi.mock("@/lib/local-computer/store", () => ({
  executeLocalComputerCommand: mocks.executeLocalComputerCommand,
}));

describe("governed local Mac tools", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-local-computer-tool-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    mocks.executeLocalComputerCommand.mockResolvedValue({
      publicResult: { summary: "Observed the active Mac workspace." },
      observation: {
        snapshotRevision: "a".repeat(64),
        frontmostApplication: {
          name: "Finder",
          bundleId: "com.apple.finder",
          pid: 123,
        },
        accessibilitySnapshot: "id=e1 role=AXWindow label=Finder",
        screenshot: {
          mimeType: "image/png",
          dataBase64: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]).toString("base64"),
        },
      },
    });
  });

  it("discloses an observation for one model turn but never persists it", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const execution = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe"),
      idempotencyKey: "local-mac-observe",
    });

    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "observe",
        toolInput: { includeScreenshot: true },
        executionScope: expect.objectContaining({
          tenantId: "tenant-local",
          initiatingActorId: "owner-local",
        }),
      }),
    );
    expect(execution.result).toEqual({
      summary: "Observed the active Mac workspace.",
    });
    expect(execution.record.output).toEqual(execution.result);
    expect(execution.record.output).not.toHaveProperty("observation");
    expect(execution.browserObservation).toMatchObject({
      source: "local_macos",
      snapshotRevision: "a".repeat(64),
      applicationState: {
        name: "Finder",
        bundleId: "com.apple.finder",
      },
      screenshot: { mimeType: "image/png" },
    });
  });

  it("fails closed when an idempotent observe call tries to replay consumed evidence", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const input = {
      toolId: "local.macos.observe",
      input: { includeScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe-replay"),
      idempotencyKey: "local-mac-observe-replay",
    } as const;

    const first = await executeGovernedTool(input);
    expect(first.browserObservation).toBeDefined();

    await expect(executeGovernedTool(input)).rejects.toMatchObject({
      name: "LocalComputerObservationExpiredError",
      code: "local_computer_observation_expired",
    });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();
  });

  it("rejects a successful observe command that has no fresh observation", async () => {
    mocks.executeLocalComputerCommand.mockResolvedValueOnce({
      publicResult: { summary: "Observation already consumed." },
    });
    const { executeGovernedTool } = await import("@/lib/tools/executor");

    const result = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe-empty"),
      idempotencyKey: "local-mac-observe-empty",
    });

    expect(result).toMatchObject({
      record: {
        status: "failed",
        reason: expect.stringContaining("fresh visual evidence"),
      },
      result: null,
    });
    expect(result).not.toHaveProperty("browserObservation");
  });

  it("does not enqueue a consequential local action before approval", async () => {
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = {
      snapshotRevision: "b".repeat(64),
      elementId: "e1-2",
    };
    const pending = await executor.executeGovernedTool({
      toolId: "local.macos.press",
      input,
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("press"),
      idempotencyKey: "local-mac-press",
    });

    expect(pending.record.status).toBe("approval_required");
    expect(mocks.executeLocalComputerCommand).not.toHaveBeenCalled();

    const claimToken = "local-mac-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: "tenant-local",
      approvedBy: "owner-local",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await executor.executeGovernedTool({
      toolId: pending.record.toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(executed.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(1);
  });
});

function securityContext() {
  return {
    tenantId: "tenant-local",
    actorId: "owner-local",
    role: "admin" as const,
    source: "mobile" as const,
    auth: {
      userId: "user-local",
      email: "owner@example.test",
      sessionId: "mobile-session-local",
      tenantName: "Local",
    },
    native: {
      deviceId: "device-local-macos",
      platform: "macos" as const,
      clientContractVersion: 11,
    },
  };
}

function executionScope(suffix: string) {
  return createExecutionScope({
    tenantId: "tenant-local",
    initiatingActorId: "owner-local",
    executingPrincipalType: "agent",
    executingPrincipalId: "agent:atlas",
    correlationId: `local-mac-${suffix}`,
    purpose: "agent.run",
  });
}
