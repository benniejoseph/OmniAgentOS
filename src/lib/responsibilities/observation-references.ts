import type { SqlClient } from "@/lib/db/sql-types";
import { parseMeetingRevision } from "@/lib/meetings/contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY, type ComparisonProjection } from "./comparison-policy";
import type { AuthoritativeSourceRead } from "./observation-contracts";
import type { TransactionalObservationReader } from "./observation-store";
import type { ResponsibilityOwner } from "./state";

/** Read-only canonical admission. Owner-private native Meeting heads are the
 * supported authority in v1. Shared and linked sources need additional current
 * permission/revocation adapters; no stale link receipt stands in for those.
 * No provider fetch, source indexing, model interpretation, or principal setup.
 */
export function responsibilityObservationReader(context: SecurityContext, owner: ResponsibilityOwner): TransactionalObservationReader {
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  const boundOwner = canonical?.actorId ?? context.actorId;
  return async ({ target, source }, sql: SqlClient): Promise<AuthoritativeSourceRead> => {
    const unavailable = (reason: Extract<AuthoritativeSourceRead, { state: "unavailable" }>["reason"]): AuthoritativeSourceRead => ({ state: "unavailable", source, reason });
    if (!sql.transactionScoped || owner.tenantId !== context.tenantId || owner.actorId !== boundOwner || target.tenantId !== owner.tenantId || target.actorId !== owner.actorId ||
      ((context.source === "session" || context.source === "mobile") && !canonical)) return unavailable("access_denied");
    if (source.kind !== "meeting") return unavailable("unsupported");
    // The transaction's exact canonical actor RLS is supplemented by explicit
    // owner predicates. FOR SHARE keeps revision/consent/visibility immutable
    // until the observation, baseline and event commit together.
    const rows = await sql`SELECT meeting_snapshot, current_revision AS meeting_revision, current_revision_id AS meeting_revision_id, meeting_sha256, consent_snapshot_sha256,
        owner_actor_id, effective_access_class, updated_at AS revised_at
      FROM omni_meetings WHERE tenant_id = ${owner.tenantId} AND workspace_id = ${source.workspaceId}
        AND meeting_id = ${source.id} AND owner_actor_id = ${owner.actorId} FOR SHARE`;
    if (!rows.length) return unavailable("missing");
    if (rows.length !== 1) return unavailable("evidence_invalid");
    const row = rows[0]; const meeting = parseMeetingRevision(row.meeting_snapshot);
    if (!meeting || meeting.tenantId !== owner.tenantId || meeting.ownerActorId !== owner.actorId || meeting.workspaceId !== source.workspaceId || meeting.meetingId !== source.id ||
      row.owner_actor_id !== owner.actorId || Number(row.meeting_revision) !== meeting.revision || row.meeting_revision_id !== meeting.meetingRevisionId || row.meeting_sha256 !== meeting.meetingSha256 ||
      row.consent_snapshot_sha256 !== meeting.consentSnapshotSha256 || row.effective_access_class !== meeting.effectiveAccessClass || instant(row.revised_at) !== meeting.revisedAt) return unavailable("evidence_invalid");
    if (meeting.effectiveAccessClass !== "owner_private" || meeting.sourceLinks.length) return unavailable("unsupported");
    if (meeting.participants.some((participant) => participant.attendeeConsent === "declined")) return unavailable("access_denied");
    if (meeting.participants.some((participant) => participant.attendeeConsent !== "granted")) return unavailable("partial");
    const evidenceIds = [meeting.meetingRevisionId];
    const key = (kind: string, id = meeting.meetingId) => canonicalJsonSha256([meeting.workspaceId, meeting.meetingId, kind, id]);
    const projection: ComparisonProjection = {
      comparisonState: "deterministic",
      meeting: { key: key("meeting"), status: meeting.status, startsAt: meeting.scheduledStartAt, endsAt: meeting.scheduledEndAt,
        agenda: [], // The Meeting contract has no structured agenda field.
        participantKeys: meeting.participants.map((participant) => canonicalJsonSha256([participant.participantId, participant.entityId, participant.email, participant.role, participant.response])), evidenceIds },
      facts: [
        { key: key("actual-start"), value: meeting.actualStartAt, evidenceIds },
        { key: key("actual-end"), value: meeting.actualEndAt, evidenceIds },
        { key: key("timezone"), value: meeting.timezone, evidenceIds },
      ],
      commitments: meeting.commitments.map((item) => ({ key: key("commitment", item.commitmentId), value: JSON.stringify([item.ownerParticipantId, item.dueAt]), evidenceIds })),
      uninterpretedText: [
        { key: key("title"), value: meeting.title, evidenceIds }, { key: key("summary"), value: meeting.summary, evidenceIds },
        { key: key("location"), value: meeting.location, evidenceIds },
        ...meeting.decisions.map((item) => ({ key: key("decision-text", item.decisionId), value: item.summary, evidenceIds })),
        ...meeting.commitments.map((item) => ({ key: key("commitment-text", item.commitmentId), value: item.summary, evidenceIds })),
      ],
    };
    const authoritySha256 = canonicalJsonSha256({ purpose: "responsibility_observation", tenantId: owner.tenantId, actorId: owner.actorId,
      workspaceId: source.workspaceId, accessClass: meeting.effectiveAccessClass, consentSnapshotSha256: meeting.consentSnapshotSha256 });
    return { state: "available", source,
      authority: { tenantId: owner.tenantId, requestActorId: owner.actorId, authoredOwnerActorId: meeting.ownerActorId, authoritySha256, purpose: "responsibility_observation" },
      revisionId: meeting.meetingRevisionId, revisionSha256: meeting.meetingSha256,
      // Reading an old revision now does not renew its freshness. This is a
      // conservative source-revision age bound, not a claim of provider sync.
      observedAt: meeting.revisedAt, sourceUpdatedAt: meeting.revisedAt,
      freshUntil: new Date(Date.parse(meeting.revisedAt) + RESPONSIBILITY_MEETING_COMPARISON_POLICY.maximumSourceAgeSeconds * 1_000).toISOString(),
      current: true, complete: true, evidence: [{ kind: "meeting_revision", id: meeting.meetingRevisionId, revisionId: meeting.meetingRevisionId,
        revisionSha256: meeting.meetingSha256, contentSha256: meeting.meetingSha256 }], projection };
  };
}
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
