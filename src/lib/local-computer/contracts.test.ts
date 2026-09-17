import { describe, expect, it } from "vitest";

import {
  LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES,
  localComputerClaimRequestSchema,
  localComputerCommandSchema,
  localComputerCompletionRequestSchema,
  localComputerDeviceUpdateSchema,
} from "@/lib/local-computer/contracts";

describe("local computer protocol", () => {
  it("requires both explicit enablement and bounded permission state", () => {
    expect(localComputerDeviceUpdateSchema.parse({
      schemaVersion: 1,
      enabled: true,
      helperVersion: "1.0.0",
      permissions: {
        accessibility: "granted",
        screenRecording: "granted",
      },
      activityState: "idle",
    }).enabled).toBe(true);
  });

  it("does not accept a successful action without an exact result", () => {
    expect(localComputerCompletionRequestSchema.safeParse({
      schemaVersion: 1,
      claimToken: "a".repeat(32),
      outcome: "succeeded",
    }).success).toBe(false);
  });

  it("bounds an idle long-poll so one authorization cannot stay open", () => {
    expect(localComputerClaimRequestSchema.safeParse({
      schemaVersion: 1,
      waitSeconds: 15,
    }).success).toBe(true);
    expect(localComputerClaimRequestSchema.safeParse({
      schemaVersion: 1,
      waitSeconds: 21,
    }).success).toBe(false);
  });

  it("binds every claimed command to one run, execution, and preview intent", () => {
    const command = {
      schemaVersion: 1,
      id: `local_computer_command_${"b".repeat(48)}`,
      runId: "run-local-preview",
      executionId: "run-local-preview:execution-local-preview",
      action: "observe",
      input: { includeScreenshot: true },
      presentScreenshot: true,
      claimToken: "claim-token-that-is-long-enough-123456",
      claimGeneration: 1,
      expiresAt: "2026-09-17T08:00:30.000Z",
    } as const;

    expect(localComputerCommandSchema.parse(command)).toMatchObject({
      runId: "run-local-preview",
      executionId: "run-local-preview:execution-local-preview",
      input: { includeScreenshot: true },
      presentScreenshot: true,
    });

    for (const field of ["runId", "executionId", "presentScreenshot"] as const) {
      const incomplete = { ...command } as Record<string, unknown>;
      delete incomplete[field];
      expect(
        localComputerCommandSchema.safeParse(incomplete).success,
        `${field} must be required`,
      ).toBe(false);
    }
  });

  it("rejects unsafe run and execution bindings in a claimed command", () => {
    const command = {
      schemaVersion: 1,
      id: `local_computer_command_${"b".repeat(48)}`,
      runId: "run-local-preview",
      executionId: "execution-local-preview",
      action: "observe",
      input: { includeScreenshot: true },
      presentScreenshot: false,
      claimToken: "claim-token-that-is-long-enough-123456",
      claimGeneration: 1,
      expiresAt: "2026-09-17T08:00:30.000Z",
    } as const;

    expect(localComputerCommandSchema.safeParse({
      ...command,
      runId: "run other-tenant",
    }).success).toBe(false);
    expect(localComputerCommandSchema.safeParse({
      ...command,
      executionId: "execution other",
    }).success).toBe(false);
  });

  it("rejects malformed screenshot bytes before they reach a model", () => {
    const parsed = localComputerCompletionRequestSchema.safeParse({
      schemaVersion: 1,
      claimToken: "a".repeat(32),
      outcome: "succeeded",
      result: {
        summary: "Observed the frontmost window.",
        observation: {
          snapshotRevision: "f".repeat(64),
          screenshot: {
            mimeType: "image/png",
            dataBase64: Buffer.from("not an image").toString("base64"),
          },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps the combined native result below the database envelope", () => {
    const screenshot = Buffer.alloc(LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES);
    screenshot[0] = 0xff;
    screenshot[1] = 0xd8;
    const parsed = localComputerCompletionRequestSchema.safeParse({
      schemaVersion: 1,
      claimToken: "a".repeat(32),
      outcome: "succeeded",
      result: {
        summary: "Observed the active workspace.",
        observation: {
          snapshotRevision: "f".repeat(64),
          accessibilitySnapshot: "a".repeat(96 * 1_024),
          screenshot: {
            mimeType: "image/jpeg",
            dataBase64: screenshot.toString("base64"),
          },
        },
      },
    });

    expect(parsed.success).toBe(true);

    const oversized = Buffer.alloc(LOCAL_COMPUTER_MAX_SCREENSHOT_BYTES + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    expect(localComputerCompletionRequestSchema.safeParse({
      schemaVersion: 1,
      claimToken: "a".repeat(32),
      outcome: "succeeded",
      result: {
        summary: "Observed the active workspace.",
        observation: {
          snapshotRevision: "f".repeat(64),
          screenshot: {
            mimeType: "image/jpeg",
            dataBase64: oversized.toString("base64"),
          },
        },
      },
    }).success).toBe(false);
  });
});
