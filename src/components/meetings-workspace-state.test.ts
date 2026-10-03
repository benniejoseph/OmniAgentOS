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

describe("Compact meeting response parser parity", () => {
  function processedReceipt() {
    const citations = [{ turnId: "turn:one", segmentIndex: 0, startMilliseconds: 0, endMilliseconds: 1000, speakerLabel: "A" }];
    return {
      recording: { id: "recording:one" }, job: { id: "job:one", status: "completed" },
      media: {
        recordingId: "recording:one", meetingId: "meeting:test", processingStatus: "ready", operationJobId: "job:one", rawAudioDeletedAt: null, updatedAt: stamp,
        output: {
          mediaRevisionId: "recording:one:media:v1", processedAt: stamp, languageTags: ["en"],
          turns: [{ turnId: "turn:one", startMilliseconds: 0.5, endMilliseconds: 1000.25, languageTag: "en", speaker: { label: "A", identity: "diarized" }, text: "Exact transcript" }],
          chapters: [{ chapterId: "chapter:one", title: "Chapter", text: "Exact chapter", citations, startMilliseconds: -0.5, endMilliseconds: 1000.25 }],
          summary: { text: "Exact summary", citations },
          actionItems: [{ actionItemId: "action:one", text: "Exact action", citations, ownershipEvidence: "unconfirmed", dueDateEvidence: "unconfirmed" }],
          decisions: [{ decisionId: "decision:one", text: "Exact decision", citations }], warnings: ["Unconfirmed speaker"],
        },
      },
    };
  }
  const parseMedia = (value: unknown) => parseMeetingMediaReceipt(value, "recording:one", "meeting:test");

  it("copies every known media collection and nested record, retaining loose extensions", () => {
    const raw = processedReceipt();
    const extension = { future: ["retained extension identity"] };
    Object.assign(raw.media, { extension });
    Object.assign(raw.media.output.turns[0].speaker, { futureSpeaker: "preserved" });
    Object.assign(raw.media.output.summary, { futureSummary: "preserved" });
    const parsed = parseMedia(raw);
    expect(parsed).toMatchObject({ extension, output: { summary: { futureSummary: "preserved" }, turns: [{ speaker: { futureSpeaker: "preserved" } }] } });
    expect((parsed as unknown as Record<string, unknown>).extension).toBe(extension);
    expect(parsed.output).not.toBe(raw.media.output);
    expect(parsed.output?.turns).not.toBe(raw.media.output.turns);
    expect(parsed.output?.turns[0].speaker).not.toBe(raw.media.output.turns[0].speaker);
    expect(parsed.output?.summary.citations[0]).not.toBe(raw.media.output.summary.citations[0]);
    raw.media.output.turns[0].speaker.label = "Changed after parse";
    raw.media.output.summary.citations[0].speakerLabel = "Changed after parse";
    raw.media.output.languageTags.push("fr");
    expect(parsed.output?.turns[0].speaker.label).toBe("A");
    expect(parsed.output?.summary.citations[0].speakerLabel).toBe("A");
    expect(parsed.output?.languageTags).toEqual(["en"]);
  });

  it("preserves stripping at picker envelopes, rows and nested library versions", () => {
    expect(parseMeetingOptions("projects", { envelopeExtra: true, projects: [{ id: "project:one", title: "", extra: true }] })).toEqual([{ id: "project:one", title: "" }]);
    expect(parseMeetingOptions("entities", { entities: [{ entityId: "person:one", entityTypeId: "person", canonicalLabel: "", state: "active", extra: true }, { entityId: "other:one", entityTypeId: "unlisted", canonicalLabel: "Other", state: "active" }] })).toEqual([{ entityId: "person:one", entityTypeId: "person", canonicalLabel: "", state: "active" }]);
    const item = { id: "library:one", kind: "capture", sourceAuthority: "owner", sourceId: "asset:one", title: "", sourceLabel: "", status: "ready", currentVersion: { sourceRevisionId: null, mediaType: "image/png", extra: true }, extra: true };
    const parsed = parseMeetingOptions("library", { items: [item], extra: true });
    expect(parsed[0]).not.toHaveProperty("extra"); expect(parsed[0].currentVersion).toEqual({ sourceRevisionId: null, mediaType: "image/png" });
    item.currentVersion.mediaType = "changed";
    expect(parsed[0].currentVersion.mediaType).toBe("image/png");
  });

  it("distinguishes optional absence/undefined from null and required nullable fields", () => {
    const raw = processedReceipt();
    const withoutOptional = parseMedia(raw);
    expect(Object.hasOwn(withoutOptional.output!.turns[0].speaker, "participantId")).toBe(false);
    Object.assign(raw.media.output.turns[0].speaker, { participantId: undefined, displayName: undefined });
    const explicit = parseMedia(raw);
    expect(Object.hasOwn(explicit.output!.turns[0].speaker, "participantId")).toBe(true);
    expect(explicit.output!.turns[0].speaker.participantId).toBeUndefined();
    Object.assign(raw.media.output.turns[0].speaker, { participantId: null });
    expect(() => parseMedia(raw)).toThrow("incomplete");
    expect(() => parseMeetingResolutionReceipt({ commitment: confirmed(), meeting: null }, proposal(), submitted)).toThrow("incomplete");
    expect(parseMeetingResolutionReceipt({ commitment: confirmed(), draft: null }, proposal(), submitted).draftVerification).toBe("not_requested");
    const invalid = meeting(); Reflect.deleteProperty(invalid.participants[0], "email");
    expect(() => parseMeetingDetail(detail(invalid), "meeting:test")).toThrow("incomplete");
  });

  it("requires finite durations, keeps legal fractions and negative chapter offsets, and bounds integer citations", () => {
    const raw = processedReceipt();
    expect(parseMedia(raw).output?.turns[0].startMilliseconds).toBe(0.5);
    expect(parseMedia(raw).output?.chapters[0].startMilliseconds).toBe(-0.5);
    for (const value of [NaN, Infinity, -Infinity]) {
      const next = processedReceipt(); next.media.output.chapters[0].endMilliseconds = value;
      expect(() => parseMedia(next)).toThrow("incomplete");
    }
    for (const value of [-1, 0.25, Number.MAX_SAFE_INTEGER + 1]) {
      const next = processedReceipt(); next.media.output.summary.citations[0].segmentIndex = value;
      expect(() => parseMedia(next)).toThrow("incomplete");
    }
    raw.media.output.summary.citations[0].segmentIndex = Number.MAX_SAFE_INTEGER;
    expect(parseMedia(raw).output?.summary.citations[0].segmentIndex).toBe(Number.MAX_SAFE_INTEGER);
    raw.media.output.turns[0].startMilliseconds = -0.01;
    expect(() => parseMedia(raw)).toThrow("incomplete");
  });

  it("retains canonical ISO equality, identity lengths and exact UTF-16 string bounds", () => {
    for (const invalid of ["2026-02-30T12:00:00.000Z", "2026-10-03T12:00:00Z", "2026-10-03T12:00:00.000+00:00", "not a date"]) {
      expect(() => parseMeetingDetail(detail({ ...meeting(), revisedAt: invalid }), "meeting:test")).toThrow("incomplete");
    }
    expect(parseMeetingDetail(detail({ ...meeting(), revisedAt: "+010000-01-01T00:00:00.000Z" }), "meeting:test").meeting.revisedAt).toBe("+010000-01-01T00:00:00.000Z");
    expect(parseMeetingOptions("projects", { projects: [{ id: " ", title: "" }] })[0].id).toBe(" ");
    expect(parseMeetingOptions("projects", { projects: [{ id: "x".repeat(512), title: "" }] })[0].id).toHaveLength(512);
    expect(() => parseMeetingOptions("projects", { projects: [{ id: "x".repeat(513), title: "" }] })).toThrow("incomplete");
    expect(parseMeetingDetail(detail({ ...meeting(), title: "🦉".repeat(120) }), "meeting:test").meeting.title).toHaveLength(240);
    expect(() => parseMeetingDetail(detail({ ...meeting(), title: "🦉".repeat(121) }), "meeting:test")).toThrow("incomplete");
  });

  it("enforces media array and text bounds, including required sparse entries", () => {
    const cases: Array<(value: ReturnType<typeof processedReceipt>) => void> = [
      (value) => { value.media.output.languageTags = Array(25).fill("en"); },
      (value) => { value.media.output.turns = Array(50001).fill(value.media.output.turns[0]); },
      (value) => { value.media.output.chapters = Array(241).fill(value.media.output.chapters[0]); },
      (value) => { value.media.output.actionItems = Array(501).fill(value.media.output.actionItems[0]); },
      (value) => { value.media.output.decisions = Array(501).fill(value.media.output.decisions[0]); },
      (value) => { value.media.output.warnings = Array(101).fill(""); },
      (value) => { value.media.output.summary.citations = []; },
      (value) => { value.media.output.summary.citations = Array(25).fill(value.media.output.summary.citations[0]); },
      (value) => { value.media.output.turns[0].text = "x".repeat(24001); },
      (value) => { value.media.output.summary.text = "x".repeat(12001); },
      (value) => { value.media.output.summary.text = ""; },
      (value) => { value.media.output.turns = Array(1); },
    ];
    for (const change of cases) { const value = processedReceipt(); change(value); expect(() => parseMedia(value)).toThrow("incomplete"); }
    const accepted = processedReceipt(); accepted.media.output.turns[0].text = ""; accepted.media.output.summary.text = "x".repeat(12000);
    expect(parseMedia(accepted).output?.summary.text).toHaveLength(12000);
  });

  it("preserves nullable linked-media rules and linked transcript/segment limits", () => {
    const value = meeting();
    value.sourceLinks = [{ linkId: "link:one", kind: "capture_recording", sourceId: "recording:one", sourceRevisionId: "recording:one:v1", sourceRevisionSha256: sha, sourceAuthoritySha256: sha, accessClass: "owner_private", mediaRole: "recording", label: "Recording" }];
    const source = { linkId: "link:one", kind: "capture_recording", sourceId: "recording:one", mediaRole: "recording", label: "", revisionState: "exact", status: null, mediaType: null, durationMs: 0.5, byteCount: 1.25, updatedAt: null, transcript: "x".repeat(500000), transcriptTruncated: true, media: null, segments: [{ segmentIndex: 0, mimeType: "", durationMs: 0.25 }] };
    const envelope = { ...detail(value), linkedSources: [source] };
    expect(parseMeetingDetail(envelope, "meeting:test").linkedSources[0].byteCount).toBe(1.25);
    expect(() => parseMeetingDetail({ ...envelope, linkedSources: [{ ...source, transcript: "x".repeat(500001) }] }, "meeting:test")).toThrow("incomplete");
    expect(() => parseMeetingDetail({ ...envelope, linkedSources: [{ ...source, segments: Array(1441).fill(source.segments[0]) }] }, "meeting:test")).toThrow("incomplete");
    expect(() => parseMeetingDetail({ ...envelope, linkedSources: [{ ...source, media: undefined }] }, "meeting:test")).toThrow("incomplete");
    const head = processedReceipt().media;
    Reflect.deleteProperty(head, "output");
    expect(parseMedia({ ...processedReceipt(), media: head }).output).toBeNull();
    expect(() => parseMeetingDetail({ ...envelope, linkedSources: [{ ...source, media: head }] }, "meeting:test")).toThrow("incomplete");
  });

  it("retains exact resolution requirements and forbids a dismissed work/draft result", () => {
    const view = confirmed();
    const dismissed = { ...view, resolution: { ...view.resolution, decision: "dismissed", ownerParticipantId: null, workItemId: null, draftId: null, communicationPolicyId: null } };
    expect(parseMeetingResolutionReceipt({ commitment: dismissed }, proposal(), { decision: "dismissed" }).commitment.resolution?.decision).toBe("dismissed");
    expect(() => parseMeetingResolutionReceipt({ commitment: { ...dismissed, resolution: { ...dismissed.resolution, workItemId: "unexpected" } } }, proposal(), { decision: "dismissed" })).toThrow("incomplete");
    expect(() => parseMeetingResolutionReceipt({ commitment: { ...view, resolution: { ...view.resolution, ownerDisplayName: "" } } }, proposal(), submitted)).toThrow("incomplete");
    expect(() => parseMeetingResolutionReceipt({ commitment: { ...view, resolution: { ...view.resolution, communicationPolicyId: "policy:one" } } }, proposal(), submitted)).toThrow("incomplete");
  });

  it("does not coerce primitive contracts or allow unsafe calendar counts", () => {
    for (const imported of ["2", true, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => meetingCalendarReceipt({ provider: "google", sources: [{ source: "calendar", status: "healthy", imported }] })).toThrow("incomplete");
    }
    expect(meetingCalendarReceipt({ provider: "google", sources: [{ source: "calendar", status: "healthy", imported: Number.MAX_SAFE_INTEGER }] }).message).toContain(String(Number.MAX_SAFE_INTEGER));
    const sparse = Array(1);
    expect(() => parseMeetingOptions("projects", { projects: sparse })).toThrow("incomplete");
  });

  it("drops __proto__ passthrough keys without dropping ordinary extension fields", () => {
    const raw = JSON.parse(JSON.stringify({ ...detail(), meeting: { ...meeting(), extension: "kept" } })) as ReturnType<typeof detail>;
    Object.defineProperty(raw.meeting, "__proto__", { value: { polluted: true }, enumerable: true });
    const parsed = parseMeetingDetail(raw, "meeting:test");
    expect(Object.getPrototypeOf(parsed.meeting)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.meeting, "__proto__")).toBe(false);
    expect(parsed.meeting).toMatchObject({ extension: "kept" });
  });
});
