import { describe, expect, it, vi } from "vitest";
import { assertMeetingCommitmentRead, createMeetingRequestGate, freezeMeetingSubmission, meetingCalendarReceipt, parseMeetingCommitments, parseMeetingDetail, parseMeetingList, parseMeetingMediaReceipt, parseMeetingMutation, parseMeetingOptions, parseMeetingProposalReceipt, parseMeetingResolutionReceipt, startMeetingMediaReads } from "./meetings-workspace-state";
import type { Meeting, MeetingCommitmentView, MeetingDraft } from "./meetings-workspace";
import type { VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";

const stamp = "2026-10-03T12:00:00.000Z";
const sha = "a".repeat(64);
const context = { workspaceId: "workspace:test", accessLevel: "contributor", canWrite: true };
function meeting(revision = 1): Meeting {
  return { schemaVersion: 1, tenantId: "tenant:test", workspaceId: context.workspaceId, meetingId: "meeting:test", meetingRevisionId: `meeting:test:v${revision}`, meetingSha256: sha, revision, ownerActorId: "actor:owner", title: "Customer review", summary: "A bounded meeting.", status: "scheduled", scheduledStartAt: stamp, scheduledEndAt: "2026-10-03T13:00:00.000Z", actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "", projectId: "project:test", declaredAccessClass: "owner_private", effectiveAccessClass: "owner_private", revisedAt: stamp, participants: [{ participantId: "participant:one", displayName: "Owner", email: "owner@example.test", entityId: null, role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "granted", consentCapturedAt: stamp, source: "manual" }], sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [] };
}
function detail(record = meeting()) { return { context, meeting: record, linkedSources: [] }; }
function draft(): MeetingDraft {
  const value = meeting();
  return { title: value.title, summary: value.summary, status: value.status, scheduledStartAt: value.scheduledStartAt, scheduledEndAt: value.scheduledEndAt, actualStartAt: null, actualEndAt: null, timezone: value.timezone, location: value.location, projectId: value.projectId, declaredAccessClass: value.declaredAccessClass, participants: value.participants, sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [] };
}
function proposal(): MeetingCommitmentView["proposal"] {
  return { proposalId: "proposal:test", proposalSha256: sha, meetingId: "meeting:test", meetingRevisionId: "meeting:test:v1", projectId: "project:test", mediaRevisionId: "recording:one:media:v1", actionItemId: "action:test", title: "Send the plan", citations: [{ turnId: "turn:one", segmentIndex: 0, startMilliseconds: 0, endMilliseconds: 1000, speakerLabel: "A", speakerParticipantId: "participant:one" }], ownership: { participantId: "participant:one", displayName: "Owner", authority: "explicit_transcript" }, dueDate: { dueAt: null, authority: "confirmation_required" } };
}
function confirmed(withDraft = false) {
  return { proposal: proposal(), resolution: { proposalId: "proposal:test", proposalSha256: sha, resolutionSha256: "b".repeat(64), decision: "confirmed" as const, ownerParticipantId: "participant:one", ownerDisplayName: "Owner", ownershipAuthority: "explicit_transcript" as const, dueAt: null, dueDateAuthority: null, workItemId: "work:test", draftId: withDraft ? "draft:test" : null, communicationPolicyId: withDraft ? "policy:test" : null, meetingRevisionId: "meeting:test:v2" } };
}
const submitted = { decision: "confirmed" as const, ownerParticipantId: "participant:one", dueAt: null, communication: null };
const communication = { policyId: "policy:test", recipientParticipantId: "participant:one", subject: " Review ", body: " Exact body " };
function review(views: MeetingCommitmentView[]) { return { context, meeting: meeting(), commitments: views, eligiblePolicies: [] }; }

describe("Meeting read contracts", () => {
  it("distinguishes a valid empty list from missing, malformed and excessive records", () => {
    expect(parseMeetingList({ context, meetings: [] }).meetings).toEqual([]);
    expect(() => parseMeetingList({ context })).toThrow("incomplete");
    expect(() => parseMeetingList({ context, meetings: Array.from({ length: 201 }, () => meeting()) })).toThrow();
    expect(() => parseMeetingList({ context, meetings: [meeting(), meeting()] })).toThrow("conflicting");
  });
  it("requires exact tenant, workspace and requested detail identity", () => {
    expect(parseMeetingDetail(detail(), "meeting:test", "tenant:test").meeting.meetingRevisionId).toBe("meeting:test:v1");
    expect(() => parseMeetingDetail(detail(), "another", "tenant:test")).toThrow("identity");
    expect(() => parseMeetingList({ context, meetings: [meeting()] }, "other-tenant")).toThrow("scope");
    expect(() => parseMeetingList({ context: { ...context, workspaceId: "other" }, meetings: [meeting()] })).toThrow("scope");
  });
  it("rejects malformed revision, canonical time and nested participant shapes", () => {
    expect(() => parseMeetingDetail(detail({ ...meeting(), meetingRevisionId: "meeting:test:v9" }), "meeting:test")).toThrow();
    expect(() => parseMeetingDetail(detail({ ...meeting(), revisedAt: "2026-10-03T12:00:00+00:00" }), "meeting:test")).toThrow();
    const invalid = detail();
    invalid.meeting.participants[0].recordingConsent = ["granted"] as never;
    expect(() => parseMeetingDetail(invalid, "meeting:test")).toThrow();
  });
  it("retains numeric, string and collection bounds in the browser validator", () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(() => parseMeetingDetail(detail(meeting(revision)), "meeting:test")).toThrow();
    }
    expect(parseMeetingDetail(detail(meeting(Number.MAX_SAFE_INTEGER)), "meeting:test").meeting.revision).toBe(Number.MAX_SAFE_INTEGER);
    for (const title of ["", "x".repeat(241)]) {
      expect(() => parseMeetingDetail(detail({ ...meeting(), title }), "meeting:test")).toThrow();
    }
    expect(() => parseMeetingDetail(detail({ ...meeting(), meetingSha256: "A".repeat(64) }), "meeting:test")).toThrow();
    expect(() => parseMeetingDetail(detail({ ...meeting(), participants: Array.from({ length: 251 }, () => meeting().participants[0]) }), "meeting:test")).toThrow();
    expect(() => parseMeetingProposalReceipt({ commitment: { proposal: { ...proposal(), citations: [] }, resolution: null } }, proposal())).toThrow();
  });
  it("preserves response extensions while validating and copying known fields", () => {
    const record = { ...meeting(), futureDetail: "retained", participants: [{ ...meeting().participants[0], futureConsent: "retained" }] };
    const parsed = parseMeetingDetail({ ...detail(record), unrelatedEnvelope: true }, "meeting:test");
    expect(parsed.meeting).toMatchObject({ futureDetail: "retained", participants: [{ futureConsent: "retained" }] });
    expect(parsed).not.toHaveProperty("unrelatedEnvelope");
    record.participants[0].displayName = "Changed after parse";
    expect(parsed.meeting.participants[0].displayName).toBe("Owner");
    expect(() => parseMeetingDetail(detail({ ...meeting(), actualStartAt: undefined } as never), "meeting:test")).toThrow();
    expect(() => parseMeetingList({ meetings: [], context: { ...context, canWrite: "true" } })).toThrow();
  });
  it("rejects unrelated linked-source evidence without discarding independent list results", () => {
    const invalid = { ...detail(), linkedSources: [{ linkId: "link:other", kind: "capture_asset", sourceId: "asset:other", mediaRole: "attachment", label: "Unrelated", revisionState: "exact", status: null, mediaType: null, durationMs: null, byteCount: null, updatedAt: null, transcript: null, transcriptTruncated: false, media: null, segments: [] }] };
    expect(() => parseMeetingDetail(invalid, "meeting:test")).toThrow("source identities");
    expect(parseMeetingList({ context, meetings: [meeting()] }).meetings).toHaveLength(1);
    expect(() => parseMeetingOptions("projects", { projects: [{ id: {}, title: "bad" }] })).toThrow();
    expect(parseMeetingOptions("library", { items: [] })).toEqual([]);
  });
  it("binds commitment reads to the requested meeting and rejects duplicate proposals", () => {
    const view = { proposal: proposal(), resolution: null };
    expect(parseMeetingCommitments(review([view]), "meeting:test").commitments).toHaveLength(1);
    expect(() => parseMeetingCommitments(review([view]), "other")).toThrow("match");
    expect(() => parseMeetingCommitments(review([view, view]), "meeting:test")).toThrow("conflicting");
  });
});

describe("Meeting mutation receipts", () => {
  it("freezes the edit base, request key and nested consent independently of later drafts/reads", () => {
    const editable = draft();
    const base = { meetingId: "meeting:test", revision: 1 };
    const frozen = freezeMeetingSubmission(editable, base, "meeting-update:exact");
    editable.title = "Changed after submit";
    editable.participants[0].recordingConsent = "declined";
    base.revision = 7;
    expect(frozen.draft.title).toBe("Customer review");
    expect(frozen.draft.participants[0].recordingConsent).toBe("granted");
    expect(frozen.base?.revision).toBe(1);
    expect(frozen.key).toBe("meeting-update:exact");
    expect(parseMeetingMutation(detail(meeting(2)), frozen.draft, frozen.base).meeting.revision).toBe(2);
    expect(() => parseMeetingMutation(detail(meeting(8)), frozen.draft, frozen.base)).toThrow("saved revision");
  });
  it("does not confirm a save that changed the exact submitted consent", () => {
    const output = meeting(2);
    output.participants[0].recordingConsent = "not_required";
    expect(() => parseMeetingMutation(detail(output), draft(), { meetingId: "meeting:test", revision: 1 })).toThrow("consent");
    expect(() => parseMeetingMutation({}, draft(), undefined)).toThrow("incomplete");
    expect(() => parseMeetingMutation(detail(meeting(3)), draft(), undefined)).toThrow("first revision");
  });
  it("requires proposed evidence to match meeting revision, project, media and action", () => {
    const target = { meetingId: "meeting:test", meetingRevisionId: "meeting:test:v1", projectId: "project:test", mediaRevisionId: proposal().mediaRevisionId, actionItemId: "action:test" };
    expect(parseMeetingProposalReceipt({ commitment: { proposal: proposal(), resolution: null } }, target).proposal.proposalSha256).toBe(sha);
    expect(() => parseMeetingProposalReceipt({ commitment: { proposal: proposal(), resolution: null } }, { ...target, meetingRevisionId: "meeting:test:v2" })).toThrow("evidence");
    expect(() => parseMeetingProposalReceipt({ commitment: { proposal: proposal(), resolution: null } }, { ...target, actionItemId: "another" })).toThrow();
  });
  it("accepts an exact decision and rejects a changed digest, owner or due date", () => {
    expect(parseMeetingResolutionReceipt({ commitment: confirmed() }, proposal(), submitted).commitment.resolution?.workItemId).toBe("work:test");
    expect(() => parseMeetingResolutionReceipt({ commitment: confirmed() }, { ...proposal(), proposalSha256: "c".repeat(64) }, submitted)).toThrow("proposal");
    expect(() => parseMeetingResolutionReceipt({ commitment: confirmed() }, proposal(), { ...submitted, ownerParticipantId: "other" })).toThrow("owner");
    expect(() => parseMeetingResolutionReceipt({ commitment: confirmed() }, proposal(), { ...submitted, dueAt: stamp })).toThrow("due date");
  });
  it("validates returned draft identity, recipient and normalized content", () => {
    const body = { commitment: confirmed(true), draft: { id: "draft:test", policyId: "policy:test", recipient: "Owner@Example.Test", subject: "Review", body: "Exact body", draftSha256: sha } };
    const submission = { ...submitted, communication };
    expect(parseMeetingResolutionReceipt(body, proposal(), submission, "owner@example.test").draftVerification).toBe("returned_content");
    expect(() => parseMeetingResolutionReceipt(body, proposal(), submission, "someone@example.test")).toThrow("recipient");
    expect(() => parseMeetingResolutionReceipt({ ...body, draft: { ...body.draft, body: "Unrelated content" } }, proposal(), submission, "owner@example.test")).toThrow("content");
  });
  it("keeps replayed draft identity distinct from returned content verification", () => {
    const result = parseMeetingResolutionReceipt({ commitment: confirmed(true) }, proposal(), { ...submitted, communication }, "owner@example.test");
    expect(result.draftVerification).toBe("identity_only");
    expect(result.commitment.resolution?.draftId).toBe("draft:test");
  });
  it("does not let a later missing/unresolved read replace an accepted result", () => {
    const accepted = confirmed();
    expect(() => assertMeetingCommitmentRead([], [accepted], "meeting:test")).toThrow("retained");
    expect(() => assertMeetingCommitmentRead([{ proposal: proposal(), resolution: null }], [accepted], "meeting:test")).toThrow("retained");
    expect(() => assertMeetingCommitmentRead([accepted], [accepted], "meeting:test")).not.toThrow();
    // A new immutable proposal version is reviewed with a new draft identity.
    expect(() => assertMeetingCommitmentRead([{ proposal: { ...proposal(), proposalSha256: "d".repeat(64) }, resolution: null }], [accepted], "meeting:test")).not.toThrow();
  });
  it("accepts the lean queued media head and requires exact recording, meeting and job", () => {
    const value = { recording: { id: "recording:one" }, media: { recordingId: "recording:one", meetingId: "meeting:test", processingStatus: "queued", operationJobId: "job:one", updatedAt: stamp }, job: { id: "job:one", status: "queued" } };
    expect(parseMeetingMediaReceipt(value, "recording:one", "meeting:test")).toMatchObject({ output: null, rawAudioDeletedAt: null, processingStatus: "queued" });
    expect(() => parseMeetingMediaReceipt(value, "recording:other", "meeting:test")).toThrow("recording");
    expect(() => parseMeetingMediaReceipt({ ...value, job: { id: "job:other", status: "queued" } }, "recording:one", "meeting:test")).toThrow("recording");
  });
  it("distinguishes Calendar failure, continuation and success without inventing zero", () => {
    const response = (status: string) => ({ provider: "google", sources: [{ source: "calendar", status, imported: 2 }] });
    expect(meetingCalendarReceipt(response("healthy")).message).toContain("2 calendar changes synchronized");
    expect(meetingCalendarReceipt(response("syncing")).message).toContain("continuing");
    expect(meetingCalendarReceipt(response("error")).message).toContain("could not");
    expect(() => meetingCalendarReceipt({ provider: "google", sources: [] })).toThrow("no confirmed");
    expect(() => meetingCalendarReceipt({ provider: "google", sources: [{ source: "calendar", status: "healthy" }] })).toThrow("incomplete");
  });
});

describe("Meeting request lifetimes", () => {
  it("fences held A→B→A replies and keeps independent read channels active", () => {
    const gate = createMeetingRequestGate();
    gate.mount();
    const firstA = gate.beginRead("detail");
    const options = gate.beginRead("projects");
    const b = gate.beginRead("detail");
    const lastA = gate.beginRead("detail");
    expect(firstA.signal.aborted).toBe(true);
    expect(firstA.current()).toBe(false);
    expect(b.current()).toBe(false);
    expect(lastA.current()).toBe(true);
    expect(options.current()).toBe(true);
  });
  it("claims writes synchronously across action kinds and releases accepted effects before refresh", () => {
    const gate = createMeetingRequestGate();
    gate.mount();
    const action = gate.beginWrite()!;
    expect(gate.beginWrite()).toBeUndefined();
    expect(gate.isWriting()).toBe(true);
    action.finish();
    const heldRefresh = gate.beginRead("detail");
    expect(gate.beginWrite()?.current()).toBe(true);
    expect(heldRefresh.current()).toBe(true);
  });
  it("disposal and remount cannot revive old writes or let old finally release a new action", () => {
    const gate = createMeetingRequestGate();
    gate.mount();
    const old = gate.beginWrite()!;
    const read = gate.beginRead("detail");
    gate.dispose();
    gate.mount();
    const current = gate.beginWrite()!;
    old.finish();
    expect(old.current()).toBe(false);
    expect(read.current()).toBe(false);
    expect(read.signal.aborted).toBe(true);
    expect(current.current()).toBe(true);
    expect(gate.beginWrite()).toBeUndefined();
  });
  it("an old poll cancellation does not abort a newer explicit detail retry", () => {
    const gate = createMeetingRequestGate();
    gate.mount();
    const poll = gate.beginRead("detail");
    const retry = gate.beginRead("detail");
    poll.abort();
    expect(retry.current()).toBe(true);
    expect(retry.signal.aborted).toBe(false);
  });
});

describe("Visible pending media reads", () => {
  function environment() {
    let visible = true;
    let sequence = 0;
    const timers = new Map<number, () => void>();
    const visibility = new Set<() => void>();
    const focus = new Set<() => void>();
    const value: VisibleRefreshEnvironment = { isVisible: () => visible, setTimer: (callback) => { const key = ++sequence; timers.set(key, callback); return key; }, clearTimer: (key) => { timers.delete(key); }, addFocusListener: (callback) => { focus.add(callback); }, removeFocusListener: (callback) => { focus.delete(callback); }, addVisibilityListener: (callback) => { visibility.add(callback); }, removeVisibilityListener: (callback) => { visibility.delete(callback); } };
    return { value, timers, visibility, focus, tick() { const next = timers.entries().next().value; if (!next) throw new Error("No poll scheduled"); timers.delete(next[0]); next[1](); }, setVisible(next: boolean) { visible = next; for (const listener of visibility) listener(); } };
  }
  it("continues unchanged pending heads, pauses while hidden and wakes when visible", async () => {
    const env = environment();
    const read = vi.fn(async () => undefined);
    const stop = startMeetingMediaReads(read, env.value);
    env.tick(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    env.tick(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    env.setVisible(false);
    expect(env.timers.size).toBe(0);
    env.setVisible(true); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    expect(env.timers.size).toBe(0);
  });
  it("aborts the held poll on disposal and its late continuation schedules nothing", async () => {
    const env = environment();
    let finish!: () => void;
    let signal!: AbortSignal;
    const stop = startMeetingMediaReads(async (value) => { signal = value; await new Promise<void>((resolve) => { finish = resolve; }); }, env.value);
    env.tick();
    stop();
    expect(signal.aborted).toBe(true);
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(env.timers.size).toBe(0);
    expect(env.visibility.size).toBe(0);
    expect(env.focus.size).toBe(0);
  });
});
