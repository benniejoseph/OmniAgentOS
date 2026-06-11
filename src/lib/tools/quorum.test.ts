import { describe, expect, it } from "vitest";
import { hasRisk3Quorum } from "@/lib/tools/executor";
import type { ToolExecutionRecord } from "@/lib/tools/types";

function record(overrides: Partial<ToolExecutionRecord>): ToolExecutionRecord {
  return {
    id: "rec-1",
    toolId: "danger.tool",
    toolName: "Danger Tool",
    riskLevel: 3,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: {},
    actorId: "requester",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("hasRisk3Quorum", () => {
  it("rejects records with no approvals", () => {
    expect(hasRisk3Quorum(record({}))).toBe(false);
    expect(hasRisk3Quorum(undefined)).toBe(false);
  });

  it("rejects a single admin approval", () => {
    expect(
      hasRisk3Quorum(record({ approvals: [{ by: "admin-1", role: "admin", at: new Date().toISOString() }] })),
    ).toBe(false);
  });

  it("accepts two distinct admin approvals", () => {
    expect(
      hasRisk3Quorum(
        record({
          approvals: [
            { by: "admin-1", role: "admin", at: new Date().toISOString() },
            { by: "admin-2", role: "admin", at: new Date().toISOString() },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("ignores duplicate approvers", () => {
    expect(
      hasRisk3Quorum(
        record({
          approvals: [
            { by: "admin-1", role: "admin", at: new Date().toISOString() },
            { by: "admin-1", role: "admin", at: new Date().toISOString() },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("excludes the requester from the quorum", () => {
    expect(
      hasRisk3Quorum(
        record({
          actorId: "admin-1",
          approvals: [
            { by: "admin-1", role: "admin", at: new Date().toISOString() },
            { by: "admin-2", role: "admin", at: new Date().toISOString() },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("ignores non-admin approvals", () => {
    expect(
      hasRisk3Quorum(
        record({
          approvals: [
            { by: "op-1", role: "operator", at: new Date().toISOString() },
            { by: "op-2", role: "operator", at: new Date().toISOString() },
          ],
        }),
      ),
    ).toBe(false);
  });
});
