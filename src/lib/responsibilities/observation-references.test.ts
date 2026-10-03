import { describe, expect, it, vi } from "vitest";
import { buildMeetingRevision, type MeetingDraftInput } from "@/lib/meetings/contracts";
import type { SqlClient } from "@/lib/db/sql-types";
import type { SecurityContext } from "@/lib/security/types";
import { responsibilityObservationReader } from "./observation-references";
import { authoritativeSourceReadSchema } from "./observation-contracts";
import { observationNow as now, observationOwner as owner, observationRecord as record } from "./observation-test-fixtures";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "./comparison-policy";

const context: SecurityContext = { tenantId: owner.tenantId, actorId: "current@example.test", role: "operator", source: "session", auth: { userId: owner.actorId.slice(6), email: "current@example.test", sessionId: "s", tenantName: "Fixture" } };
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const source = { kind: "meeting" as const, workspaceId: "workspace:owner", id: meetingId };
const target = { tenantId: owner.tenantId, actorId: owner.actorId, responsibilityId: record.id, responsibilityRevision: record.revision, reviewSha256: record.review!.reviewSha256 };
const definition: MeetingDraftInput = {
  title: "Source-backed title", summary: "Review costs; this prose is not a structured agenda.", status: "scheduled", scheduledStartAt: "2026-10-05T09:00:00.000Z", scheduledEndAt: "2026-10-05T10:00:00.000Z",
  actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "", projectId: null, declaredAccessClass: "owner_private",
  participants: [{ participantId: "p1", displayName: "Owner", email: "current@example.test", entityId: null, role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "not_required", consentCapturedAt: now, source: "manual" }],
  sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [],
};
function meeting(fields: Partial<MeetingDraftInput> = {}, revisedAt = now) {
  return buildMeetingRevision({ tenantId: owner.tenantId, workspaceId: source.workspaceId, ownerActorId: owner.actorId, meetingId, revision: 1, definition: { ...definition, ...fields, sourceLinks: [] }, revisedAt });
}
function database(value = meeting(), overrides: Record<string, unknown> = {}) {
  const sql = Object.assign(vi.fn().mockResolvedValue([{ meeting_snapshot: value, meeting_revision: value.revision, meeting_revision_id: value.meetingRevisionId,
    meeting_sha256: value.meetingSha256, consent_snapshot_sha256: value.consentSnapshotSha256, owner_actor_id: value.ownerActorId, effective_access_class: value.effectiveAccessClass, revised_at: value.revisedAt, ...overrides }]), { transactionScoped: true });
  return { sql, client: sql as unknown as SqlClient };
}
describe("Authoritative responsibility observation reads", () => {
  it("binds the canonical owner despite a different request email and keeps exact source/prose identities", async () => {
    const { sql, client } = database();
    const result = authoritativeSourceReadSchema.parse(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, client));
    expect(result).toMatchObject({ state: "available", authority: { tenantId: owner.tenantId, requestActorId: owner.actorId, authoredOwnerActorId: owner.actorId }, observedAt: now, freshUntil: "2026-10-04T01:00:00.000Z" });
    if (result.state !== "available") throw new Error("Expected available fixture");
    expect(result.projection.meeting?.agenda).toEqual([]);
    expect(result.projection.uninterpretedText.map((item) => item.value)).toContain(definition.summary);
    expect(result.evidence[0]).toMatchObject({ id: `${meetingId}:v1`, revisionSha256: meeting().meetingSha256 });
    expect(sql.mock.calls[0].slice(1)).toEqual([owner.tenantId, source.workspaceId, source.id, owner.actorId]);
  });
  it("does not refresh an old source merely by fetching it now", async () => {
    const old = "2026-10-03T20:00:00.000Z";
    const { client } = database(meeting({}, old));
    const result = authoritativeSourceReadSchema.parse(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, client));
    expect(result).toMatchObject({ state: "available", observedAt: old, sourceUpdatedAt: old, freshUntil: "2026-10-03T21:00:00.000Z" });
    // The admission layer, rather than a provider success flag, rejects it.
    const flow = createResponsibilityObservationPipeline({ record, policySha256: RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256,
      readAuthoritativeSource: async () => ({ ...result, source: record.draft.sources[0] }) });
    expect(flow.plan(await flow.read({ observationKey: "stale", observedAt: now }), null, 0)).toMatchObject({ outcome: "insufficient_evidence", reasons: ["stale"], nextBaseline: null });
  });
  it("requires exact current revision columns and fails closed on missing rows or a different owner", async () => {
    const bad = database(meeting(), { meeting_sha256: "f".repeat(64) });
    expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, bad.client)).toMatchObject({ state: "unavailable", reason: "evidence_invalid" });
    bad.sql.mockResolvedValue([]);
    expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, bad.client)).toMatchObject({ reason: "missing" });
    expect(await responsibilityObservationReader(context, { ...owner, actorId: "foreign" })({ target, source, observedAt: now }, bad.client)).toMatchObject({ reason: "access_denied" });
    expect(bad.sql).toHaveBeenCalledTimes(2);
  });
  it("rejects denied/unknown consent, shared meetings and unsupported source kinds without inventing facts", async () => {
    for (const [consent, reason] of [["declined", "access_denied"], ["pending", "partial"]] as const) {
      const { client } = database(meeting({ participants: [{ ...definition.participants[0], attendeeConsent: consent }] }));
      expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, client)).toMatchObject({ state: "unavailable", reason });
    }
    const { client, sql } = database(meeting({ declaredAccessClass: "workspace_members" }));
    expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, client)).toMatchObject({ reason: "unsupported" });
    expect(await responsibilityObservationReader(context, owner)({ target, source: { kind: "capture_asset", id: "a" }, observedAt: now }, client)).toMatchObject({ reason: "unsupported" });
    expect(sql).toHaveBeenCalledTimes(1);
  });
  it("requires transaction-scoped reads and a real signed-in binding before touching a source", async () => {
    const { client, sql } = database();
    expect(await responsibilityObservationReader({ ...context, auth: undefined }, owner)({ target, source, observedAt: now }, client)).toMatchObject({ reason: "access_denied" });
    expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, Object.assign(sql, { transactionScoped: false }) as unknown as SqlClient)).toMatchObject({ reason: "access_denied" });
    expect(sql).not.toHaveBeenCalled();
  });
  it("does not treat an old linked-source receipt as current authority even when its hashes are structurally valid", async () => {
    const linked = buildMeetingRevision({ tenantId: owner.tenantId, workspaceId: source.workspaceId, ownerActorId: owner.actorId, meetingId, revision: 1, revisedAt: now,
      definition: { ...definition, sourceLinks: [{ linkId: "calendar", kind: "calendar_event", sourceId: "source-a", sourceRevisionId: "revision-a", sourceRevisionSha256: "a".repeat(64),
        sourceAuthoritySha256: "b".repeat(64), accessClass: "owner_private", mediaRole: "calendar", label: "Imported event" }] } });
    const { client } = database(linked);
    expect(await responsibilityObservationReader(context, owner)({ target, source, observedAt: now }, client)).toMatchObject({ state: "unavailable", reason: "unsupported" });
  });
});
