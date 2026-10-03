import { describe, expect, it } from "vitest";
import {
  assertMeetingResolutionPhaseOrder, meetingResolutionIntentBody, meetingResolutionIntentSchema,
  meetingResolutionPhaseSchema, meetingResolutionReconciliation, meetingResolutionReconciliationSchema,
  type MeetingResolutionPhase,
} from "./commitment-resolution-intent";

const at = "2026-10-04T12:00:00.000Z", sha = "a".repeat(64);
const request = {
  decision: "confirmed" as const, ownerParticipantId: "participant:owner", dueAt: null,
  communication: { connectionId: null, policyId: "contact_policy:11111111-1111-4111-8111-111111111111",
    recipientParticipantId: "participant:recipient", subject: "Exact subject", body: "Exact private message" },
};
function body(overrides: Record<string, unknown> = {}) {
  return { tenantId: "tenant", workspaceId: "workspace:tenant", meetingId: "meeting:11111111-1111-4111-8111-111111111111",
    proposalId: `meeting-commitment-proposal:${sha}`, proposalSha256: sha, ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
    request, ...overrides };
}
const intent = meetingResolutionIntentSchema.parse({ ...meetingResolutionIntentBody(body()), createdAt: at });
function phase(name: MeetingResolutionPhase["phase"]): MeetingResolutionPhase {
  return { phase: name, at, resourceId: name.endsWith("_completed") ? `${name}:exact` : null, evidenceSha256: name.endsWith("_completed") ? sha : null };
}

describe("immutable Meeting resolution decision and phase evidence", () => {
  it("binds exact recipient identity even if contact addresses could match", () => {
    const other = meetingResolutionIntentBody(body({ request: { ...request,
      communication: { ...request.communication, recipientParticipantId: "participant:another" } } }));
    expect(other.requestSha256).not.toBe(intent.requestSha256);
  });
  it.each(["tenantId", "workspaceId", "meetingId", "ownerActorId"])("fingerprints exact %s scope", (key) => {
    expect(meetingResolutionIntentBody(body({ [key]: "different" })).requestSha256).not.toBe(intent.requestSha256);
  });
  it("includes normalized full communication and owner/due decisions, not submission time", () => {
    for (const change of [{ subject: "Other subject" }, { body: "Other body" }, { connectionId: "22222222-2222-4222-8222-222222222222" }]) {
      expect(meetingResolutionIntentBody(body({ request: { ...request, communication: { ...request.communication, ...change } } })).requestSha256).not.toBe(intent.requestSha256);
    }
    expect(meetingResolutionIntentSchema.parse({ ...intent, createdAt: "2026-10-05T12:00:00.000Z" }).requestSha256).toBe(intent.requestSha256);
    expect(meetingResolutionIntentSchema.safeParse({ ...intent, request: { ...request, ownerParticipantId: "participant:other" } }).success).toBe(false);
  });
  it("rejects extra caller authority and a fake lease/takeover", () => {
    expect(meetingResolutionIntentSchema.safeParse({ ...intent, leaseExpiresAt: at }).success).toBe(false);
    expect(() => meetingResolutionIntentBody(body({ request: { decision: "dismissed", communication: request.communication } }))).toThrow();
  });
  it("distinguishes pending, acknowledged partial, uncertain and terminal evidence", () => {
    expect(meetingResolutionReconciliation(intent, [], false).state).toBe("pending");
    expect(meetingResolutionReconciliation(intent, [phase("work_started")], false).state).toBe("uncertain");
    expect(meetingResolutionReconciliation(intent, [phase("work_started"), phase("work_completed")], false).state).toBe("partial");
    const all: MeetingResolutionPhase["phase"][] = ["work_started", "work_completed", "draft_started", "draft_completed", "meeting_started", "meeting_completed", "resolution_started"];
    expect(meetingResolutionReconciliation(intent, all.map(phase), true).state).toBe("resolved");
    expect(meetingResolutionReconciliation(intent, all.map(phase), false).state).toBe("uncertain");
  });
  it("does not manufacture completion evidence after a missing response", () => {
    expect(meetingResolutionPhaseSchema.safeParse({ ...phase("work_started"), resourceId: "guessed" }).success).toBe(false);
    expect(meetingResolutionPhaseSchema.safeParse({ ...phase("work_completed"), evidenceSha256: null }).success).toBe(false);
    expect(meetingResolutionReconciliationSchema.safeParse({ ...meetingResolutionReconciliation(intent, [], false), state: "resolved" }).success).toBe(false);
  });
  it("allows each next phase once and refuses automatic continuation after interruption", () => {
    expect(() => assertMeetingResolutionPhaseOrder(intent, [], "work_started")).not.toThrow();
    expect(() => assertMeetingResolutionPhaseOrder(intent, [], "work_completed")).toThrow();
    expect(() => assertMeetingResolutionPhaseOrder(intent, [phase("work_started"), phase("work_completed"), phase("interrupted")], "draft_started")).toThrow(/cannot resume/);
    const receipt = meetingResolutionReconciliation(intent, [phase("work_started"), phase("work_completed"), phase("interrupted")], false);
    expect(receipt).toMatchObject({ state: "uncertain", automaticRetryAllowed: false });
    expect(receipt.phases[1].resourceId).toBe("work_completed:exact");
    expect(JSON.stringify(receipt)).not.toContain(request.communication.body);
  });
});
