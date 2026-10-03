import { describe, expect, it } from "vitest";
import { meetingResolutionIntentBody, meetingResolutionReconciliationSchema, type MeetingResolutionReconciliation } from "@/lib/meetings/commitment-resolution-intent";
import { assertMeetingReconciliationRead, meetingResolutionReceiptHref, meetingResolutionRequestDigest, readMeetingProposalEnvelope, readMeetingReconciliation, readMeetingReconciliationError } from "./meetings-response-validation";
import { parseMeetingResolutionReceipt } from "./meetings-workspace-state";
import type { MeetingCommitmentProposal, MeetingCommitmentView } from "./meetings-workspace";

const at = "2026-10-04T12:00:00.000Z", sha = "a".repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
const proposal: MeetingCommitmentProposal = {
  proposalId: `meeting-commitment-proposal:${sha}`, proposalSha256: sha, proposedByActorId: `actor:${projectId}`,
  meetingId: "meeting:33333333-3333-4333-8333-333333333333", meetingRevisionId: "meeting:33333333-3333-4333-8333-333333333333:v1",
  projectId, mediaRevisionId: "recording:media:v1", actionItemId: `media-action:${sha}`, title: "Reviewed follow-up",
  citations: [{ turnId: `media-turn:${sha}`, segmentIndex: 0, startMilliseconds: 0, endMilliseconds: 1000, speakerLabel: "Owner" }],
  ownership: { participantId: "person:owner", displayName: "Owner", authority: "explicit_transcript" }, dueDate: { dueAt: null, authority: "confirmation_required" },
};
type Phase = MeetingResolutionReconciliation["phases"][number];
function phase(name: Phase["phase"]): Phase {
  return { phase: name, at, resourceId: name === "work_completed" ? taskId : name === "meeting_completed" ? `${proposal.meetingId}:v2` : name === "draft_completed" ? "message_draft:44444444-4444-4444-8444-444444444444" : null,
    evidenceSha256: name.endsWith("_completed") ? sha : null };
}
function pending(): MeetingResolutionReconciliation {
  return { schemaVersion: 1, requestSha256: sha, decision: "confirmed", state: "pending", automaticRetryAllowed: false, createdAt: at, phases: [] };
}
function known(): MeetingResolutionReconciliation { return { ...pending(), state: "partial", phases: [phase("work_started"), phase("work_completed")] }; }
function completed(): MeetingResolutionReconciliation { return { ...pending(), state: "resolved", phases: ["work_started", "work_completed", "meeting_started", "meeting_completed", "resolution_started"].map((name) => phase(name as Phase["phase"])) }; }
function view(reconciliation: MeetingResolutionReconciliation = known()): MeetingCommitmentView { return { proposal, resolution: null, reconciliation }; }
function succeeds(value: unknown) { try { readMeetingReconciliation(value); return true; } catch { return false; } }

describe("web Meeting reconciliation boundary", () => {
  it("binds the normalized full submitted decision to the exact server intent fingerprint", async () => {
    const scope = { tenantId: "tenant", workspaceId: "workspace:tenant", ownerActorId: `actor:${projectId}` };
    const communication = { policyId: `contact_policy:${taskId}`, recipientParticipantId: "person:recipient", subject: " Reviewed subject ", body: " Exact private content " };
    const submitted = { decision: "confirmed" as const, communication, dueAt: "2026-10-04T14:00:00+02:00" };
    const actual = await meetingResolutionRequestDigest(proposal, scope, submitted);
    const expected = meetingResolutionIntentBody({ ...scope, meetingId: proposal.meetingId, proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256,
      request: { decision: "confirmed", ownerParticipantId: "person:owner", dueAt: at, communication: { ...communication, connectionId: null, subject: communication.subject.trim(), body: communication.body.trim() } } });
    expect(actual).toBe(expected.requestSha256);
    expect(await meetingResolutionRequestDigest(proposal, scope, { ...submitted, communication: { ...communication, recipientParticipantId: "person:same-email-other" } })).not.toBe(actual);
    expect(await meetingResolutionRequestDigest(proposal, scope, { decision: "dismissed" })).toBe(meetingResolutionIntentBody({ ...scope, meetingId: proposal.meetingId, proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, request: { decision: "dismissed" } }).requestSha256);
  });
  it.each(["confirmed", "dismissed"] as const)("binds a shared Meeting's %s decision to the proposal owner", async (decision) => {
    const scope = { tenantId: "tenant", workspaceId: "workspace:tenant", ownerActorId: `actor:${taskId}` };
    const submitted = { decision, ownerParticipantId: "person:owner", dueAt: null, communication: null };
    const request = decision === "dismissed" ? { decision } : { ...submitted, decision };
    const expected = meetingResolutionIntentBody({ ...scope, ownerActorId: proposal.proposedByActorId,
      meetingId: proposal.meetingId, proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, request });
    expect(scope.ownerActorId).not.toBe(proposal.proposedByActorId);
    expect(await meetingResolutionRequestDigest(proposal, scope, submitted)).toBe(expected.requestSha256);
    const otherMeetingOwner = { ...scope, ownerActorId: "actor:another-meeting-owner" };
    expect(await meetingResolutionRequestDigest(proposal, otherMeetingOwner, submitted)).toBe(expected.requestSha256);
    expect(await meetingResolutionRequestDigest({ ...proposal, proposedByActorId: scope.ownerActorId }, scope, submitted)).not.toBe(expected.requestSha256);
  });
  it("validates and normalizes the proposal owner without falling back to a Meeting owner", async () => {
    const scope = { tenantId: "tenant", workspaceId: "workspace:tenant", ownerActorId: proposal.proposedByActorId };
    for (const proposedByActorId of [undefined, null, false, {}, "", " \t\n", "x".repeat(241)]) {
      const malformed = { ...proposal, proposedByActorId };
      expect(() => readMeetingProposalEnvelope({ commitment: { proposal: malformed, resolution: null } })).toThrow();
      await expect(meetingResolutionRequestDigest(malformed as MeetingCommitmentProposal, scope, { decision: "dismissed" })).rejects.toThrow();
    }
    const padded = { ...proposal, proposedByActorId: ` ${proposal.proposedByActorId}\t` };
    expect(readMeetingProposalEnvelope({ commitment: { proposal: padded, resolution: null } }).commitment.proposal.proposedByActorId).toBe(proposal.proposedByActorId);
    expect(await meetingResolutionRequestDigest(padded, scope, { decision: "dismissed" })).toBe(await meetingResolutionRequestDigest(proposal, scope, { decision: "dismissed" }));
  });
  it("accepts and reconciles the proposal owner's decision on another actor's Meeting", async () => {
    const scope = { tenantId: "tenant", workspaceId: "workspace:tenant", ownerActorId: `actor:${taskId}` };
    const submitted = { decision: "confirmed" as const, ownerParticipantId: "person:owner", dueAt: null, communication: null };
    const intent = meetingResolutionIntentBody({ ...scope, ownerActorId: proposal.proposedByActorId,
      meetingId: proposal.meetingId, proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, request: submitted });
    const expectedDigest = await meetingResolutionRequestDigest(proposal, scope, submitted);
    const partial = { ...known(), requestSha256: intent.requestSha256 };
    const conflict = readMeetingReconciliationError({ error: "Inspect recorded Work.", code: "meeting_commitment_reconciliation_required", reconciliation: partial });
    expect(conflict?.requestSha256).toBe(expectedDigest);
    const resolution = { proposalId: proposal.proposalId, proposalSha256: sha, resolutionSha256: sha, decision: "confirmed", ownerParticipantId: "person:owner", ownerDisplayName: "Owner", ownershipAuthority: "explicit_transcript", dueAt: null, dueDateAuthority: null, workItemId: taskId, draftId: null, communicationPolicyId: null, meetingRevisionId: `${proposal.meetingId}:v2` };
    const accepted = parseMeetingResolutionReceipt({ commitment: { proposal, resolution, reconciliation: { ...completed(), requestSha256: intent.requestSha256 } } }, proposal, submitted);
    expect(accepted.commitment.reconciliation?.requestSha256).toBe(expectedDigest);
    expect(accepted.commitment.resolution?.workItemId).toBe(taskId);
    expect(() => assertMeetingReconciliationRead([accepted.commitment], [view(partial)])).not.toThrow();
    expect(() => assertMeetingReconciliationRead([{ ...accepted.commitment, proposal: { ...proposal, proposedByActorId: scope.ownerActorId } }], [view(partial)])).toThrow("recorded resolution intent");
  });
  it("agrees with the authoritative schema on every bounded decision sequence and state", () => {
    const plans: Phase["phase"][][] = [["resolution_started"], ["work_started", "work_completed", "meeting_started", "meeting_completed", "resolution_started"], ["work_started", "work_completed", "draft_started", "draft_completed", "meeting_started", "meeting_completed", "resolution_started"]];
    for (const plan of plans) for (let length = 0; length <= plan.length; length++) {
      for (const interrupted of [false, true]) for (const state of ["pending", "partial", "uncertain", "resolved"]) {
        const value = { ...pending(), decision: plan.length === 1 ? "dismissed" : "confirmed", state,
          phases: [...plan.slice(0, length).map(phase), ...(interrupted ? [phase("interrupted")] : [])] };
        expect(succeeds(value), JSON.stringify(value)).toBe(meetingResolutionReconciliationSchema.safeParse(value).success);
      }
    }
  });
  it.each(["2024-02-29T14:00+05:30", "2026-10-04T12:00:00.12345Z", "2000-02-29T00:00:00-23:59", "1900-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-10-04T24:00:00Z", "2026-10-04T12:60:00Z", "2026-10-04T12:00:00+24:00", "2026-10-04"])("matches offset datetime validation for %s", (value) => {
    const changed = { ...pending(), createdAt: value };
    expect(succeeds(changed)).toBe(meetingResolutionReconciliationSchema.safeParse(changed).success);
  });
  it("rejects extra authority, malformed receipts, duplicate phases and missing fields", () => {
    const invalid = [
      { ...pending(), resumeAllowed: true }, { ...pending(), automaticRetryAllowed: true }, { ...pending(), requestSha256: "not-a-digest" },
      { ...pending(), phases: Array.from({ length: 9 }, () => phase("interrupted")) },
      { ...known(), phases: [phase("work_started"), phase("work_started")] },
      { ...known(), phases: [phase("work_started"), { ...phase("work_completed"), resourceId: "x".repeat(241) }] },
      { ...known(), phases: [phase("work_started"), { ...phase("work_completed"), evidenceSha256: null }] },
      { ...pending(), state: "uncertain", phases: [{ ...phase("work_started"), resourceId: taskId }] },
      { ...pending(), state: "uncertain", phases: [{ ...phase("work_started"), execute: "send" }] },
      { ...pending(), state: "uncertain", phases: [{ phase: "work_started", at, resourceId: null }] },
      { ...pending(), phases: undefined }, { ...pending(), createdAt: null },
    ];
    invalid.forEach((value) => { expect(succeeds(value)).toBe(false); expect(meetingResolutionReconciliationSchema.safeParse(value).success).toBe(false); });
    expect(readMeetingReconciliation({ ...known(), phases: [phase("work_started"), { ...phase("work_completed"), resourceId: ` ${taskId} ` }] }).phases[1].resourceId).toBe(taskId);
  });
  it("copies each known phase and does not retain untrusted extension objects", () => {
    const input = known(), parsed = readMeetingReconciliation(input);
    input.phases[1].resourceId = "changed";
    expect(parsed.phases[1].resourceId).toBe(taskId);
    expect(Object.keys(parsed.phases[1])).toEqual(["phase", "at", "resourceId", "evidenceSha256"]);
  });
  it("keeps legacy views readable and requires terminal evidence to match accepted child identities", () => {
    expect(readMeetingProposalEnvelope({ commitment: { proposal, resolution: null } }).commitment.reconciliation).toBeUndefined();
    expect(readMeetingProposalEnvelope({ commitment: view() }).commitment.reconciliation).toEqual(known());
    expect(() => readMeetingProposalEnvelope({ commitment: view(completed()) })).toThrow();
    const resolution = { proposalId: proposal.proposalId, proposalSha256: sha, resolutionSha256: sha, decision: "confirmed", ownerParticipantId: "person:owner", ownerDisplayName: "Owner", ownershipAuthority: "explicit_transcript", dueAt: null, dueDateAuthority: null, workItemId: taskId, draftId: null, communicationPolicyId: null, meetingRevisionId: `${proposal.meetingId}:v2` };
    expect(() => readMeetingProposalEnvelope({ commitment: { proposal, resolution } })).not.toThrow();
    expect(() => readMeetingProposalEnvelope({ commitment: { proposal, resolution, reconciliation: completed() } })).not.toThrow();
    expect(() => readMeetingProposalEnvelope({ commitment: { proposal, resolution: { ...resolution, workItemId: projectId }, reconciliation: completed() } })).toThrow();
    expect(() => readMeetingProposalEnvelope({ commitment: { proposal, resolution, reconciliation: known() } })).toThrow();
  });
  it("cannot erase, replace or regress a known claim during a successful refresh", () => {
    const retained = view();
    for (const next of [{ proposal, resolution: null }, view(pending()), view({ ...known(), requestSha256: "b".repeat(64) }), view({ ...known(), createdAt: "2026-10-05T12:00:00.000Z" }), view({ ...known(), phases: [phase("work_started"), { ...phase("work_completed"), resourceId: projectId }] })])
      expect(() => assertMeetingReconciliationRead([next], [retained])).toThrow("recorded resolution intent");
    expect(() => assertMeetingReconciliationRead([view({ ...known(), state: "uncertain", phases: [...known().phases, phase("interrupted")] })], [retained])).not.toThrow();
    expect(() => assertMeetingReconciliationRead([], [retained])).toThrow();
  });
  it("parses only the bounded exact reconciliation conflict envelope", () => {
    const body = { error: "Inspect existing work.", code: "meeting_commitment_reconciliation_required", reconciliation: known() };
    expect(readMeetingReconciliationError(body)).toEqual(known());
    expect(readMeetingReconciliationError({ error: "Legacy decision is ambiguous.", code: body.code })).toBeUndefined();
    for (const changed of [{ ...body, code: "other" }, { ...body, retry: true }, { ...body, reconciliation: { ...known(), automaticRetryAllowed: true } }, { ...body, error: "x".repeat(4001) }]) expect(() => readMeetingReconciliationError(changed)).toThrow();
  });
  it("links only known canonical local destinations, never a supplied URL or unrelated revision", () => {
    expect(meetingResolutionReceiptHref(proposal, phase("work_completed"))).toBe(`/app/projects?project=${projectId}&task=${taskId}`);
    expect(meetingResolutionReceiptHref(proposal, phase("meeting_completed"))).toBe(`/app/meetings/${encodeURIComponent(proposal.meetingId)}`);
    for (const resourceId of ["javascript:alert(1)", "https://foreign.example/private", "../another", `${proposal.meetingId}:v2?external=1`, "meeting:55555555-5555-4555-8555-555555555555:v1"]) {
      expect(meetingResolutionReceiptHref(proposal, { ...phase("meeting_completed"), resourceId })).toBeUndefined();
      expect(meetingResolutionReceiptHref(proposal, { ...phase("work_completed"), resourceId })).toBeUndefined();
    }
    expect(meetingResolutionReceiptHref({ ...proposal, projectId: "unverified-project" }, phase("work_completed"))).toBeUndefined();
    expect(meetingResolutionReceiptHref(proposal, phase("draft_completed"))).toBeUndefined();
    expect(meetingResolutionReceiptHref(proposal, phase("work_started"))).toBeUndefined();
  });
});
