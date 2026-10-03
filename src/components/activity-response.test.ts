import { describe, expect, it } from "vitest";
import { validActivityResponse } from "@/components/activity-response";
import type { ActivityItem, ActivityResponse } from "@/lib/activity/contracts";
import { canonicalStatusForAgentRun, canonicalStatusForTerminalReceipt } from "@/lib/status/canonical";

const at = "2026-10-03T12:00:00.000Z";
function item(): ActivityItem {
  return {
    id: "run:run-a", group: "history", workKey: "run:run-a", source: "runs",
    sourceRef: { kind: "run", id: "run-a" }, references: [{ kind: "run", id: "run-a" }],
    title: "Agent run", summary: "The run completed; its outcome has not been verified.", status: "completed",
    canonicalStatus: canonicalStatusForAgentRun("completed"), timestamp: { at, basis: "completed" }, href: "/app/command?run=run-a",
  };
}
function response(): ActivityResponse {
  return {
    schemaVersion: 1, contract: "asael-activity:1", generatedAt: at, state: "ready", group: "all", items: [item()],
    counts: { working: 0, needs_you: 0, updates: 0, history: 1 },
    coverage: {
      runs: { state: "ready", limit: 100, visibleCount: 1 },
      approvals: { state: "ready", limit: 100, visibleCount: 0 },
      notifications: { state: "ready", limit: 100, visibleCount: 0 },
    },
    window: { bounded: true, limitPerSource: 100 }, page: { limit: 25, nextCursor: null, hasMore: false },
  };
}
const withItem = (changed: unknown) => ({ ...response(), items: [changed] });

describe("Activity response validation", () => {
  it("binds a Responsibility notification destination to its exact source identity", () => {
    const id = `responsibility:${"a".repeat(64)}`;
    const notification = { ...item(), source: "notifications", workKey: id, canonicalStatus: undefined, status: "read",
      sourceRef: { kind: "notification", id: "notification-a" }, references: [{ kind: "notification", id: "notification-a" }],
      href: `/app/responsibilities/${encodeURIComponent(id)}` };
    expect(validActivityResponse(withItem(notification), "all")).toBe(true);
    for (const patch of [{ href: "/app" }, { href: `${notification.href}?different=1` }, { workKey: `responsibility:${"b".repeat(64)}` }, { status: "acted" }]) {
      expect(validActivityResponse(withItem({ ...notification, ...patch }), "all")).toBe(false);
    }
  });
  it("accepts bounded legacy completion as unverified and a complete verified terminal projection", () => {
    expect(validActivityResponse(response(), "all")).toBe(true);
    const terminal = canonicalStatusForTerminalReceipt({
      disposition: "succeeded", executionMode: "live", source: "outcome_evaluator", verificationState: "verified",
    }, "agent_run");
    expect(validActivityResponse(withItem({ ...item(), canonicalStatus: terminal }), "all")).toBe(true);
  });

  it("rejects a succeeded claim with missing or contradictory canonical evidence", () => {
    const verified = canonicalStatusForTerminalReceipt({
      disposition: "succeeded", executionMode: "live", source: "outcome_evaluator", verificationState: "verified",
    }, "agent_run");
    for (const canonicalStatus of [
      { schemaVersion: 1, status: "succeeded" },
      { ...verified, basis: "legacy_status" },
      { ...verified, source: "legacy_adapter" },
      { ...verified, verificationState: "unassessed" },
      { ...verified, verificationState: "partially_verified" },
      { ...verified, domain: "approval" },
      { ...verified, sourceStatus: "completed" },
      { ...canonicalStatusForAgentRun("completed"), status: "succeeded" },
    ]) expect(validActivityResponse(withItem({ ...item(), canonicalStatus }), "all")).toBe(false);
  });

  it("rejects coercible reference enums before rendering can call string methods", () => {
    for (const kind of [["run"], { toString: () => "run" }, null, 1]) {
      expect(validActivityResponse(withItem({ ...item(), sourceRef: { kind, id: "run-a" } }), "all")).toBe(false);
      expect(validActivityResponse(withItem({ ...item(), references: [{ kind, id: "run-a" }] }), "all")).toBe(false);
    }
    expect(validActivityResponse(withItem({ ...item(), sourceRef: { kind: "approval", id: "approval-a", approvalKind: ["tool"] } }), "all")).toBe(false);
  });

  it("requires primitive states and timestamp basis throughout the read envelope", () => {
    expect(validActivityResponse({ ...response(), state: ["ready"] }, "all")).toBe(false);
    const coverage = response().coverage;
    expect(validActivityResponse({ ...response(), coverage: { ...coverage, runs: { ...coverage.runs, state: ["ready"] } } }, "all")).toBe(false);
    expect(validActivityResponse(withItem({ ...item(), timestamp: { at, basis: ["completed"] } }), "all")).toBe(false);
    expect(validActivityResponse(withItem({ ...item(), canonicalStatus: { ...item().canonicalStatus, status: ["unverified"] } }), "all")).toBe(false);
    expect(validActivityResponse(withItem({ ...item(), canonicalStatus: { ...item().canonicalStatus, verificationState: ["unassessed"] } }), "all")).toBe(false);
  });

  it("preserves explicit unavailable and restricted coverage without replacing missing data with zero", () => {
    const empty: ActivityResponse = {
      ...response(), state: "unavailable", items: [], counts: { working: 0, needs_you: 0, updates: 0, history: 0 },
      coverage: {
        runs: { state: "unavailable", limit: 100, visibleCount: null, reason: "read_failed" },
        approvals: { state: "restricted", limit: 100, visibleCount: null, reason: "permission_required" },
        notifications: { state: "unavailable", limit: 100, visibleCount: null, reason: "read_failed" },
      },
    };
    expect(validActivityResponse(empty, "all")).toBe(true);
    expect(validActivityResponse({}, "all")).toBe(false);
    expect(validActivityResponse({ ...empty, counts: undefined }, "all")).toBe(false);
  });

  it("rejects duplicate identities, impossible counts, wrong filters and oversized pages", () => {
    expect(validActivityResponse({ ...response(), items: [item(), item()] }, "all")).toBe(false);
    expect(validActivityResponse({ ...response(), counts: { ...response().counts, history: 301 } }, "all")).toBe(false);
    expect(validActivityResponse({ ...response(), counts: { ...response().counts, history: 0 } }, "all")).toBe(false);
    expect(validActivityResponse(response(), "working")).toBe(false);
    expect(validActivityResponse({ ...response(), group: "working" }, "working")).toBe(false);
    expect(validActivityResponse({ ...response(), items: Array.from({ length: 26 }, (_, index) => ({ ...item(), id: `run:${index}` })) }, "all")).toBe(false);
  });

  it("rejects external or ambiguous destinations and oversized continuation values", () => {
    for (const href of ["https://example.test/private", "//example.test", "/\\example.test", "/app/command\n"]) {
      expect(validActivityResponse(withItem({ ...item(), href }), "all")).toBe(false);
      expect(validActivityResponse(withItem({ ...item(), origin: { runId: "run-a", href } }), "all")).toBe(false);
    }
    expect(validActivityResponse({ ...response(), page: { limit: 25, hasMore: true, nextCursor: "a".repeat(2001) } }, "all")).toBe(false);
    expect(validActivityResponse({ ...response(), page: { limit: 25, hasMore: true, nextCursor: null } }, "all")).toBe(false);
  });
});
