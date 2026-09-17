import { describe, expect, it } from "vitest";

import {
  localComputerClaimRequestSchema,
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
});
