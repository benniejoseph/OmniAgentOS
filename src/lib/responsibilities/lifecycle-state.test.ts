import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { PILOT_CHECK_RESERVATION } from "./cumulative-budget";
import { buildRuntimeReceipt, changeResponsibilityLifecycle, reserveResponsibilityWake, settleResponsibilityWake, verifyPilotConfiguration, verifyRuntimeReceipt, verifyWake } from "./lifecycle-state";
import { RESPONSIBILITY_PILOT } from "./runtime-contracts";
import { runtimeConfiguration, runtimeHead, runtimeId, runtimeNow, runtimeOwner } from "./runtime-test-fixtures";

const later = "2026-10-04T00:00:01.000Z";
function stop(current = runtimeHead, action: "pause" | "end" = "pause") {
  return changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current, now: later,
    request: { action, expectedRevision: current.revision, expectedGeneration: current.generation } });
}
describe("Responsibility generation and lifecycle", () => {
  it("retains the governed store's deterministic workflow identity without accepting arbitrary run keys", () => {
    const reserved = reserveResponsibilityWake(runtimeHead, runtimeNow, null);
    for (const workflowRunId of [`wf_${"a".repeat(40)}`, "11111111-1111-4111-8111-111111111111"]) {
      const wake = verifyWake({ ...reserved.wake, revision: 2, state: "enqueued", workflowRunId, operationJobId: "job-fixture" });
      expect(wake.workflowRunId).toBe(workflowRunId);
      const receipt = buildRuntimeReceipt({ current: { ...reserved.current, revision: reserved.current.revision + 1 }, wake,
        previousRevision: reserved.current.revision, key: `enqueue:${workflowRunId}`, request: { workflowRunId }, action: "enqueue" });
      expect(verifyRuntimeReceipt(receipt).wake?.workflowRunId).toBe(workflowRunId);
    }
    for (const workflowRunId of ["arbitrary-run", `wf_${"a".repeat(39)}`, `wf_${"A".repeat(40)}`, "11111111-1111-0111-0111-111111111111"]) {
      expect(() => verifyWake({ ...reserved.wake, workflowRunId })).toThrow();
    }
  });
  it("requires an explicit exact pilot acknowledgement and refuses hourly or broadened contracts", () => {
    expect(() => changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: null, configuration: runtimeConfiguration, now: runtimeNow, nextDueAt: runtimeNow,
      request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: "f".repeat(64), acknowledgePilot: RESPONSIBILITY_PILOT } })).toThrow(/changed/);
    expect(() => verifyPilotConfiguration({ ...runtimeConfiguration, cadence: { ...runtimeConfiguration.cadence, frequency: "hourly" } })).toThrow();
    const { configurationSha256: _hash, ...body } = runtimeConfiguration; void _hash;
    const broadened = { ...body, tool: { ...body.tool, input: { ...body.tool.input, meetingId: "meeting:foreign" } } };
    expect(() => verifyPilotConfiguration({ ...broadened, configurationSha256: canonicalJsonSha256(broadened) })).toThrow();
  });
  it("invalidates the generation immediately but waits for an exact started receipt before confirming pause/end", () => {
    for (const action of ["pause", "end"] as const) {
      const reserved = reserveResponsibilityWake(runtimeHead, runtimeNow, "2026-10-05T00:00:00.000Z");
      const started = { ...reserved.wake, state: "running" as const, startedAt: runtimeNow };
      const stopped = stop(reserved.current, action);
      expect(stopped).toMatchObject({ generation: 2, state: action === "pause" ? "pausing" : "ending", nextDueAt: null });
      const uncertain = settleResponsibilityWake({ current: stopped, wake: started, now: later, outcome: "uncertain" });
      expect(uncertain.current.budget).toEqual(stopped.budget); expect(uncertain.current.state).toBe(stopped.state);
      const terminal = settleResponsibilityWake({ current: uncertain.current, wake: uncertain.wake, now: later, outcome: "completed",
        observation: { id: `responsibility-observation:${"a".repeat(64)}`, receiptSha256: "b".repeat(64) } });
      expect(terminal.current).toMatchObject({ generation: 2, state: action === "pause" ? "paused" : "ended", budget: { used: PILOT_CHECK_RESERVATION, usedChecks: 1, reservedChecks: 0 } });
      expect(terminal.wake.observationId).toBe(`responsibility-observation:${"a".repeat(64)}`);
      expect(() => settleResponsibilityWake({ ...terminal, now: later, outcome: "failed" })).toThrow();
    }
  });
  it("resumes only fully paused work with unchanged pins, skips backlog and preserves cumulative usage", () => {
    const reserved = reserveResponsibilityWake(runtimeHead, runtimeNow, null);
    const terminal = settleResponsibilityWake({ ...reserved, wake: { ...reserved.wake, state: "running", startedAt: runtimeNow }, now: later, outcome: "failed" });
    const paused = stop(terminal.current);
    const resumed = changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: paused, configuration: runtimeConfiguration,
      now: later, nextDueAt: "2026-10-05T00:00:00.000Z", request: { action: "resume", expectedRevision: paused.revision, expectedGeneration: paused.generation,
        configurationSha256: runtimeConfiguration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT } });
    expect(resumed.budget).toEqual(terminal.current.budget); expect(resumed.generation).toBe(3); expect(resumed.nextDueAt! > later).toBe(true);
    expect(() => changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: paused, now: later,
      request: { action: "end", expectedRevision: 1, expectedGeneration: 1 } })).toThrow(/changed/);
  });
  it("identifies duplicate wakes deterministically and retains immutable exact receipts", () => {
    const a = reserveResponsibilityWake(runtimeHead, runtimeNow, null); const b = reserveResponsibilityWake(runtimeHead, runtimeNow, null);
    expect(a.wake.id).toBe(b.wake.id);
    expect(() => reserveResponsibilityWake(a.current, runtimeNow, null)).toThrow();
    const receipt = buildRuntimeReceipt({ key: "reserve-one", request: { wakeId: a.wake.id }, action: "reserve", previousRevision: runtimeHead.revision, ...a });
    expect(verifyRuntimeReceipt(receipt)).toEqual(receipt);
    expect(() => verifyRuntimeReceipt({ ...receipt, snapshot: stop(a.current) })).toThrow();
  });
});
