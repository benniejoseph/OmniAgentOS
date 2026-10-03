import { describe, expect, it } from "vitest";
import { projectActivityApproval, projectActivityNotification, projectActivityRun } from "@/lib/activity/projection";
import type { ApprovalQueueItem } from "@/lib/operations/queue";
import { buildTerminalReceiptV1, type BuildTerminalReceiptV1Input } from "@/lib/runs/contracts";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { PersonalNotification } from "@/lib/today/types";

const at = "2026-10-03T10:00:00.000Z";

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-a", tenantId: "tenant-a", ownerActorId: "owner-a", mode: "execute",
    status: "running", prompt: "PRIVATE_PROMPT", messages: [], memoryContextCount: 0,
    response: "PRIVATE_OUTPUT", error: "PRIVATE_ERROR", startedAt: at, ...overrides,
  };
}

function receipt(overrides: Partial<BuildTerminalReceiptV1Input> = {}) {
  return buildTerminalReceiptV1({
    terminalReceiptId: "receipt-a", runId: "run-a", outcomeContractId: "contract-a",
    source: "outcome_evaluator", legacyStatus: null, disposition: "succeeded",
    executionMode: "live", verificationState: "verified", reasonCode: "all_requirements_verified",
    requirementResults: [{
      requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required",
      state: "verified", verificationMethod: "deterministic", verifierId: "verifier-a",
      verificationReceiptId: "verification-a",
    }],
    usefulWorkUnitCount: 1, artifactReceiptIds: [], effectReceiptIds: [],
    verifierReceiptIds: ["verification-a"], pendingApprovalIds: [], blockingDependencyIds: [],
    outputSha256: null, ...overrides,
  });
}

function notification(overrides: Partial<Extract<PersonalNotification, { kind: "reminder" }>> = {}): PersonalNotification {
  return {
    id: "notification-a", tenantId: "tenant-a", actorId: "owner-a", title: "PRIVATE_TITLE",
    kind: "reminder", sourceType: "today_item", sourceId: "today-a", occurrenceKey: "PRIVATE_OCCURRENCE",
    urgency: "overdue", status: "unread", dueAt: at, createdAt: at, updatedAt: at, ...overrides,
  };
}

describe("Activity metadata projection", () => {
  it("links a Responsibility update to its exact source without Today action or private prose", () => {
    const sourceId = `responsibility:${"a".repeat(64)}`;
    const item: PersonalNotification = { ...notification(), kind: "responsibility_change", sourceType: "responsibility_change", urgency: "update", sourceId };
    const projected = projectActivityNotification(item);
    expect(projected).toMatchObject({ group: "updates", workKey: sourceId, href: `/app/responsibilities/${encodeURIComponent(sourceId)}`,
      sourceRef: { kind: "notification", id: item.id }, references: [{ kind: "notification", id: item.id }] });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    expect(projectActivityNotification({ ...item, sourceId: "unbound" })).toBeUndefined();
    expect(projectActivityNotification({ ...item, status: "acted" })).toBeUndefined();
  });
  it("retains exact source identities and encoded links without projecting private run content", () => {
    const value = projectActivityRun(run({ id: "run:a/+", threadId: "thread:a/+" }));
    expect(value).toMatchObject({
      id: "run:run:a/+", group: "working", sourceRef: { kind: "run", id: "run:a/+" },
      timestamp: { at, basis: "started" }, canonicalStatus: { status: "running" },
    });
    const link = new URL(value!.href, "https://example.test");
    expect(link.pathname).toBe("/app/command");
    expect(link.searchParams.get("run")).toBe("run:a/+");
    expect(link.searchParams.get("thread")).toBe("thread:a/+");
    expect(JSON.stringify(value)).not.toContain("PRIVATE_");
    expect(value).not.toHaveProperty("ownerActorId");
    expect(value).not.toHaveProperty("tenantId");
  });

  it("preserves legacy completion as unverified and requires a complete receipt bound to this run", () => {
    const complete = run({ status: "completed", completedAt: "2026-10-03T11:00:00.000Z" });
    expect(projectActivityRun(complete)).toMatchObject({
      group: "history", canonicalStatus: { status: "unverified", basis: "legacy_status" },
      timestamp: { basis: "completed" },
    });
    expect(projectActivityRun({ ...complete, terminalReceipt: receipt() })).toMatchObject({
      canonicalStatus: { status: "succeeded", basis: "terminal_receipt", verificationState: "verified" },
      summary: "The run completed with a verified outcome.",
    });
    const mismatched = projectActivityRun({ ...complete, terminalReceipt: receipt({ runId: "another-run" }) });
    expect(mismatched?.canonicalStatus?.status).toBe("unverified");
    const malformed = projectActivityRun({
      ...complete,
      terminalReceipt: { ...receipt(), requiredRequirementCount: 0 },
    });
    expect(malformed?.canonicalStatus?.status).toBe("unverified");
    expect(projectActivityRun(run({ terminalReceipt: receipt() }))?.canonicalStatus?.status).toBe("running");
  });

  it("describes partial and blocked terminal receipts without promoting them to verified completion", () => {
    const partial = receipt({
      disposition: "partial", verificationState: "partially_verified", reasonCode: "requirements_unmet",
      requirementResults: [{
        requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required",
        state: "unverified", verificationMethod: "deterministic", verifierId: null, verificationReceiptId: null,
      }], verifierReceiptIds: [],
    });
    const partialItem = projectActivityRun(run({ status: "completed", terminalReceipt: partial }));
    expect(partialItem?.canonicalStatus?.status).toBe("partial");
    expect(partialItem?.summary).toContain("partial outcome");
    const blocked = receipt({
      disposition: "blocked", verificationState: "unverified", reasonCode: "external_dependency",
      blockingDependencyIds: ["dependency-a"],
    });
    const blockedItem = projectActivityRun(run({ status: "completed", terminalReceipt: blocked }));
    expect(blockedItem?.canonicalStatus?.status).toBe("blocked");
    expect(blockedItem?.summary).toContain("blocked outcome");
  });

  it("omits unsupported states, invalid dates, and unsafe or truncated source identities", () => {
    for (const overrides of [
      { id: "unsafe\nidentity" }, { id: "x".repeat(201) }, { threadId: "" },
      { startedAt: "not-a-date" }, { status: "invented" as AgentRunRecord["status"] },
    ]) expect(projectActivityRun(run(overrides))).toBeUndefined();
    const longId = "run-" + "a".repeat(196);
    expect(projectActivityRun(run({ id: longId }))?.sourceRef.id).toBe(longId);
  });

  it("projects approval metadata and ignores an untrusted claimed origin", () => {
    const approval = {
      kind: "tool", id: "approval-a", status: "reconciliation_required", title: "PRIVATE_TITLE",
      reason: "PRIVATE_REASON", input: { private: "PRIVATE_INPUT" }, createdAt: at,
      record: { tenantId: "tenant-a", actorId: "other-owner" },
      origin: { runId: "other-owner-run", threadId: "other-owner-thread" },
    } as unknown as ApprovalQueueItem;
    const value = projectActivityApproval(approval);
    expect(value).toMatchObject({
      group: "needs_you", status: "reconciliation_required",
      sourceRef: { kind: "approval", approvalKind: "tool", id: "approval-a" },
    });
    expect(value?.summary).toContain("reconciliation");
    expect(value).not.toHaveProperty("origin");
    const link = new URL(value!.href, "https://example.test");
    expect(link.pathname).toBe("/app/approvals");
    expect(Object.fromEntries(link.searchParams)).toEqual({ id: "approval-a", kind: "tool", returnTo: "/app/activity" });
    expect(JSON.stringify(value)).not.toContain("PRIVATE_");
    expect(JSON.stringify(value)).not.toContain("other-owner");
  });

  it("keeps distinct reminder occurrences grouped by the same work and links to the real Today route", () => {
    const first = projectActivityNotification(notification());
    const second = projectActivityNotification(notification({ id: "notification-b", occurrenceKey: "occurrence-b" }));
    expect(first?.id).not.toBe(second?.id);
    expect(first?.workKey).toBe(second?.workKey);
    expect(first).toMatchObject({
      group: "updates", href: "/app", references: [
        { kind: "notification", id: "notification-a" }, { kind: "today_item", id: "today-a" },
      ],
    });
    expect(projectActivityNotification(notification({ status: "snoozed" }))?.group).toBe("updates");
    for (const status of ["read", "dismissed", "acted"] as const) {
      expect(projectActivityNotification(notification({ status }))?.group).toBe("history");
    }
    expect(JSON.stringify(first)).not.toContain("PRIVATE_");
  });
});
