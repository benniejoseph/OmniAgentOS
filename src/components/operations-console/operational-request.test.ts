import { describe, expect, it, vi } from "vitest";
import { makeSubmission } from "./operational-contracts";
import { createOperationalGate, requestOperationalAction } from "./operational-request";
const request = () => makeSubmission("run", { suite: "frozen-suite", maxSafetyMode: "synthetic" }, { tenantId: "tenant-a", actorId: "actor-a" }, "frozen-key");
const stamp = "2026-10-04T12:00:00.000Z";

describe("operational request lifecycle", () => {
  it("admits one synchronous write and does not let obsolete finalizers release a new slot", () => {
    const gate = createOperationalGate(); const first = gate.beginWrite()!;
    expect(gate.beginWrite()).toBeUndefined(); expect(gate.finishWrite(first)).toBe(true);
    const second = gate.beginWrite()!; expect(gate.finishWrite(first)).toBe(false); expect(gate.currentWrite(second)).toBe(true);
  });
  it("fences older source reads independently from an accepted mutation", () => {
    const gate = createOperationalGate(); const write = gate.beginWrite()!;
    const first = gate.beginRead(); const second = gate.beginRead();
    expect(gate.currentRead(first)).toBe(false); expect(gate.currentRead(second)).toBe(true); expect(gate.currentWrite(write)).toBe(true);
    expect(gate.finishWrite(write)).toBe(true); expect(gate.beginWrite()).toBeDefined();
  });
  it("prevents disposed or remounted scope responses from reviving local state", () => {
    const gate = createOperationalGate(); const read = gate.beginRead(); const write = gate.beginWrite()!;
    gate.dispose(); expect(gate.currentRead(read)).toBe(false); expect(gate.currentWrite(write)).toBe(false); expect(gate.beginWrite()).toBeUndefined();
    gate.activate(); expect(gate.currentRead(read)).toBe(false); expect(gate.finishWrite(write)).toBe(false); expect(gate.beginWrite()).toBeDefined();
  });
  it("uses the same frozen body and request key on explicit retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce(Response.json({ job: { id: "job-1", type: "evaluation.run", status: "queued", createdAt: stamp, updatedAt: stamp } }, { status: 202 }));
    const submitted = request(); expect((await requestOperationalAction(submitted, fetcher)).state).toBe("uncertain");
    expect((await requestOperationalAction(submitted, fetcher)).state).toBe("confirmed");
    expect(fetcher.mock.calls.map((call) => [call[0], call[1]?.body, call[1]?.headers])).toEqual(Array(2).fill(["/api/evaluations", JSON.stringify(submitted.body), { "content-type": "application/json", accept: "application/json", "idempotency-key": "frozen-key" }]));
  });
  it("does not turn a malformed HTTP success or 5xx into a confirmed effect or safe failure", async () => {
    for (const response of [Response.json({}), Response.json({ error: "After-side-effect failure" }, { status: 503 })]) {
      const outcome = await requestOperationalAction(request(), vi.fn<typeof fetch>().mockResolvedValue(response)); expect(outcome.state).toBe("uncertain");
    }
  });
  it("keeps server permission, stale-case and validation rejections explicit", async () => {
    for (const status of [400, 403, 409]) {
      const outcome = await requestOperationalAction(request(), vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Exact rejection detail" }, { status })));
      expect(outcome).toEqual({ state: "rejected", message: "Exact rejection detail" });
    }
  });
});
