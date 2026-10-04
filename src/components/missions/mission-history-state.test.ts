import { describe, expect, it } from "vitest";
import { canonicalStatusForMission, canonicalStatusForMissionAttempt, canonicalStatusForMissionTask } from "@/lib/status/canonical";
import { HistoryReadGate, historyEvidenceHref, historyHref, historyId, historyLiteral, historyReturnTo, parseHistoryDetail, parseHistoryEvents, parseHistoryList, parseHistorySummary } from "./mission-history-state";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";
const AT = "44444444-4444-4444-8444-444444444444";
const STAMP = "2026-10-03T12:00:00.000Z";
function work(taskId?: string) {
  return { version: "p11.4-work-item-surface:1", projection: { authority: "canonical_work_item_v1", sha256: null, sourceRevisionSha256: null },
    status: { schemaVersion: 1, authority: "canonical_work_item_v1", persistence: "postgres", workspaceId: null,
      projectId: `mission_project:${A}`, workItemId: taskId || `mission_root:${A}`, kind: taskId ? "task" : "milestone",
      sourceAuthority: taskId ? "legacy_mission_task" : "legacy_mission", sourceId: taskId || A,
      status: "unverified", sourceStatus: "succeeded", statusRevision: 1, updatedAt: STAMP },
    assignment: { authority: "canonical_work_item_v1", agents: [] }, artifacts: { authority: "canonical_work_item_v1", count: 0, items: [] },
    execution: { authority: "governed_workflow_v1", availability: "unavailable", workflowRunId: null, sourceStatus: null, currentStep: null, completedSteps: 0, totalSteps: 0, progressPercent: null, updatedAt: null },
    cost: { authority: "ai_usage_ledger_v1", state: "unknown", usageReceiptCount: 1, unknownCostReceiptCount: 1, totalTokens: 0, knownEstimatedCostMicrousd: 0 } };
}
function mission() {
  const workItem = work();
  return { id: A, title: "Literal <script>evidence</script>", objective: "Historical objective", status: "succeeded", canonicalStatus: canonicalStatusForMission("succeeded"),
    priority: "normal", source: "test", createdAt: STAMP, updatedAt: STAMP, terminalAt: STAMP,
    detailAvailable: true, manageable: true, runnable: false, workItemStatus: workItem.status, workItem };
}
function list() { return { missions: [mission()], requestReadContracts: { missions: "readable_v1" } }; }
function detail() {
  const workItem = work(T);
  return { mission: mission(), tasks: [{ id: T, missionId: A, title: "Historical task", instructions: "Read only", definitionOfDone: "Recorded evidence", status: "succeeded", canonicalStatus: canonicalStatusForMissionTask("succeeded"), priority: "normal", position: 0, dependencyIds: [B], metadata: { reviewSummary: "Literal decision" }, createdAt: STAMP, updatedAt: STAMP, workItemStatus: workItem.status, workItem }],
    attempts: [{ id: AT, missionId: A, taskId: T, executorType: "agent_run", status: "succeeded", canonicalStatus: canonicalStatusForMissionAttempt("succeeded"), agentRunId: "run-exact", createdAt: STAMP, updatedAt: STAMP }],
    artifacts: [{ id: B, missionId: A, taskId: T, kind: "handoff", title: "Evidence", uri: "javascript:alert(1)", data: { summary: "<img src=x onerror=alert(1)>" }, createdAt: STAMP, updatedAt: STAMP }] };
}

describe("read-only mission history contracts", () => {
  it("requires the readable list contract and preserves unverified completion and unknown cost", () => {
    const value = parseHistoryList(list())[0];
    expect(value.workItem.status.status).toBe("unverified");
    expect(value.workItem.cost.state).toBe("unknown");
    expect(value.title).toBe("Literal <script>evidence</script>");
    expect(() => parseHistoryList({ missions: [] })).toThrow();
  });
  it("rejects duplicate identities, over-limit windows and changed canonical source binding", () => {
    expect(() => parseHistoryList({ ...list(), missions: [mission(), mission()] })).toThrow();
    expect(() => parseHistoryList({ ...list(), missions: Array.from({ length: 51 }, mission) })).toThrow();
    const value = list(); value.missions[0].workItem.status.sourceId = B;
    expect(() => parseHistoryList(value)).toThrow();
  });
  it("reproves exact bookmarks without treating list absence as missing", () => {
    const response = { mission: mission(), requestReadContracts: { missionSummary: "readable_v1" } };
    expect(parseHistoryList({ ...list(), missions: [] })).toEqual([]);
    expect(parseHistorySummary(response, A).id).toBe(A);
    expect(() => parseHistorySummary(response, B)).toThrow();
  });
  it("rejects a summary-only record carrying mutation or detail authority", () => {
    const value = list(); value.missions[0].detailAvailable = false;
    expect(() => parseHistoryList(value)).toThrow();
    value.missions[0].manageable = false;
    expect(parseHistoryList(value)[0].detailAvailable).toBe(false);
  });
  it("accepts literal task/attempt/artifact evidence without requiring every linked row in the bounded window", () => {
    const value = parseHistoryDetail(detail(), A);
    expect(value.tasks[0].dependencyIds).toEqual([B]);
    expect(value.attempts[0].canonicalStatus.status).toBe("unverified");
    expect(historyLiteral(value.artifacts[0].data)).toContain("<img");
    expect(historyEvidenceHref(value.artifacts[0].uri)).toBeUndefined();
  });
  it("rejects foreign detail evidence, malformed render fields and excessive actual API windows", () => {
    const foreign = detail(); foreign.artifacts[0].missionId = B;
    expect(() => parseHistoryDetail(foreign, A)).toThrow();
    const invalid = detail(); Object.assign(invalid.tasks[0], { title: { raw: "invalid" } });
    expect(() => parseHistoryDetail(invalid, A)).toThrow();
    const large = detail(); large.tasks = Array.from({ length: 31 }, () => large.tasks[0]);
    expect(() => parseHistoryDetail(large, A)).toThrow();
  });
  it("rejects a legacy status upgraded to verified success without canonical evidence", () => {
    const invalid = detail(); invalid.tasks[0].canonicalStatus = { ...canonicalStatusForMissionTask("succeeded"), status: "succeeded" };
    expect(() => parseHistoryDetail(invalid, A)).toThrow();
  });
  it("honors the server event cursor while allowing an unsettled overlapping page", () => {
    const result = { cursor: 10, changed: true, mission: { status: "succeeded", updatedAt: STAMP }, events: [{ seq: 11, type: "mission.updated", at: STAMP }] };
    expect(parseHistoryEvents(result, 10).cursor).toBe(10);
    expect(() => parseHistoryEvents({ ...result, cursor: 12 }, 10)).toThrow();
    expect(() => parseHistoryEvents({ ...result, changed: false }, 10)).toThrow();
    expect(() => parseHistoryEvents({ ...result, events: [...result.events, ...result.events] }, 10)).toThrow();
    expect(() => parseHistoryEvents({ ...result, cursor: 12, events: [...result.events, { seq: 14, type: "mission.updated", at: STAMP }] }, 10)).toThrow();
  });
  it("keeps historical selection, filters and unrelated query values in links", () => {
    const href = historyHref(A, "q=exact&status=unverified&keep=yes");
    expect(href).toContain(`/app/missions/${A}?`);
    expect(href).toContain("legacy=1"); expect(href).toContain("keep=yes");
    expect(historyHref(undefined, "keep=yes")).toBe("/app/missions?keep=yes&legacy=1");
  });
  it("only returns to known Work, Results or Activity entry paths and retains safe evidence links", () => {
    expect(historyReturnTo("/app/results?run=exact")).toBe("/app/results?run=exact");
    for (const value of ["//foreign.test", "/app/projects/unknown", "/app/projects\\foreign", "https://foreign.test"]) expect(historyReturnTo(value)).toBe("/app/projects?view=execution");
    expect(historyEvidenceHref("https://example.test/evidence?id=exact")).toBe("https://example.test/evidence?id=exact");
    expect(historyEvidenceHref("/api/capture/assets/exact?content=1")).toBe("/api/capture/assets/exact?content=1");
    expect(historyEvidenceHref("https://secret@example.test")).toBeUndefined();
    expect(historyId("../bad")).toBeUndefined();
  });
});

describe("mission history mounted request lifecycle", () => {
  it("last read wins even when an aborted request resolves", () => {
    const gate = new HistoryReadGate(); gate.activate();
    const first = gate.begin()!, second = gate.begin()!;
    expect(first.signal.aborted).toBe(true); expect(first.current()).toBe(false); expect(second.current()).toBe(true);
  });
  it("visibility cancellation prevents late commits and a visible retry has a new identity", () => {
    const gate = new HistoryReadGate(); gate.activate(); const hidden = gate.begin()!;
    gate.cancel(); const visible = gate.begin()!;
    expect(hidden.current()).toBe(false); expect(visible.current()).toBe(true);
  });
  it("A to B to A and owner remounts never revive disposed reads", () => {
    const original = new HistoryReadGate(); original.activate(); const firstA = original.begin()!; original.dispose();
    const returned = new HistoryReadGate(); returned.activate(); const nextA = returned.begin()!;
    expect(firstA.current()).toBe(false); expect(original.begin()).toBeUndefined(); expect(nextA.current()).toBe(true);
    returned.dispose(); expect(nextA.current()).toBe(false);
  });
});
