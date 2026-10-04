import { describe, expect, it } from "vitest";
import { MeetingCommitmentReconciliationRequiredError } from "@/lib/app-services/meetings";
import type { MeetingResolutionReconciliation } from "@/lib/meetings/commitment-resolution-intent";
import { meetingFailureResponse } from "@/lib/meetings/http";
import { MeetingConflictError } from "@/lib/meetings/store";

const reconciliation: MeetingResolutionReconciliation = {
  schemaVersion: 1,
  requestSha256: "a".repeat(64),
  decision: "confirmed",
  state: "uncertain",
  automaticRetryAllowed: false,
  createdAt: "2026-10-04T00:00:00.000Z",
  phases: [{
    phase: "work_started",
    at: "2026-10-04T00:00:01.000Z",
    resourceId: null,
    evidenceSha256: null,
  }],
};

describe("Meeting failure projection", () => {
  it("preserves bounded phase evidence and denies automatic retry on a private conflict", async () => {
    const error = new MeetingCommitmentReconciliationRequiredError(reconciliation);
    const response = meetingFailureResponse(error, "resolve");
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: error.message,
      code: "meeting_commitment_reconciliation_required",
      reconciliation,
    });
  });

  it("does not invent phase evidence for an ambiguous legacy resolution", async () => {
    const error = new MeetingCommitmentReconciliationRequiredError(undefined, true);
    const response = meetingFailureResponse(error, "resolve");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: error.message,
      code: "meeting_commitment_reconciliation_required",
    });
  });

  it("withholds malformed or content-bearing reconciliation payloads", async () => {
    const error = new MeetingCommitmentReconciliationRequiredError(reconciliation);
    Object.assign(error, { reconciliation: { ...reconciliation, body: "Private communication body" } });
    const response = meetingFailureResponse(error, "resolve");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Meeting resolution evidence is temporarily unavailable." });
  });

  it("retains the ordinary Meeting revision conflict response", async () => {
    const response = meetingFailureResponse(new MeetingConflictError("Revision changed."), "update");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Revision changed." });
  });
});
