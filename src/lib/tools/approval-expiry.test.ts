import { afterEach, describe, expect, it } from "vitest";
import {
  pendingToolApprovalDays,
  toolApprovalExpired,
} from "@/lib/tools/approval-expiry";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function pendingSince(msAgo: number) {
  return {
    status: "approval_required" as const,
    createdAt: new Date(NOW - msAgo).toISOString(),
  };
}

afterEach(() => {
  delete process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS;
});

describe("tool approval expiry", () => {
  it("keeps an approval pending for seven days by default", () => {
    expect(pendingToolApprovalDays()).toBe(7);
    expect(toolApprovalExpired(pendingSince(7 * DAY_MS), NOW)).toBe(false);
    expect(toolApprovalExpired(pendingSince(7 * DAY_MS + 1), NOW)).toBe(true);
  });

  it("follows the retention window for pending approvals", () => {
    process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = "2";

    expect(pendingToolApprovalDays()).toBe(2);
    expect(toolApprovalExpired(pendingSince(2 * DAY_MS), NOW)).toBe(false);
    expect(toolApprovalExpired(pendingSince(2 * DAY_MS + 1), NOW)).toBe(true);
  });

  it.each(["0", "3651", "1.5", "seven", ""])(
    "ignores a window of %j",
    (value) => {
      process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = value;

      expect(pendingToolApprovalDays()).toBe(7);
    },
  );

  it("accepts the bounds of the window", () => {
    process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = "1";
    expect(pendingToolApprovalDays()).toBe(1);
    process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = "3650";
    expect(pendingToolApprovalDays()).toBe(3_650);
  });

  it("is the window retention sweeps pending approvals with", async () => {
    process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = "3";
    const { getRetentionPolicy } = await import("@/lib/security/retention");

    expect(getRetentionPolicy().pendingApprovalDays).toBe(3);
  });

  it("treats an approval with an unreadable creation time as expired", () => {
    expect(toolApprovalExpired(
      { status: "approval_required", createdAt: "not a time" },
      NOW,
    )).toBe(true);
  });

  it("never expires a record that is not waiting for approval", () => {
    const old = new Date(NOW - 30 * DAY_MS).toISOString();

    for (const status of ["executing", "executed", "rejected"] as const) {
      expect(toolApprovalExpired({ status, createdAt: old }, NOW)).toBe(false);
    }
  });
});
