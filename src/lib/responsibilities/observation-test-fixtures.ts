import { draftFixture, nowFixture, ownerFixture, pinsFixture } from "./test-fixtures";
import { prepareResponsibilityChange, responsibilityId, reviewPreview } from "./state";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY, type ComparisonProjection } from "./comparison-policy";
import type { AuthoritativeSourceRead } from "./observation-contracts";
export const observationNow = nowFixture;
export const observationOwner = ownerFixture;
export const observationSource = { kind: "meeting" as const, id: "meeting-a", workspaceId: "workspace:owner" };
const draft = { ...draftFixture, sources: [observationSource] };
const id = responsibilityId(ownerFixture, "observe-fixture");
const created = prepareResponsibilityChange({ owner: ownerFixture, id, key: "observe-fixture", now: nowFixture, mutation: { action: "create", expectedRevision: 0, draft } });
const pins = { ...pinsFixture, sources: [{ source: observationSource, revisionSha256: "a".repeat(64) }] };
const preview = reviewPreview(created.current, pins);
export const observationRecord = prepareResponsibilityChange({ owner: ownerFixture, id, key: "review-fixture", now: nowFixture, current: created.current, preview,
  mutation: { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 } }).current;
export const observationPolicySha256 = RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256;
export const projectionFixture: ComparisonProjection = {
  comparisonState: "deterministic", meeting: { key: "meeting-a", status: "scheduled", startsAt: "2026-10-05T09:00:00.000Z", endsAt: "2026-10-05T10:00:00.000Z",
    agenda: ["Budget review", "Release planning"], participantKeys: ["participant-a", "participant-b"], evidenceIds: ["meeting-a:v1"] },
  facts: [{ key: "budget-ceiling", value: 100, evidenceIds: ["meeting-a:v1"] }],
  commitments: [{ key: "deliver-brief", value: "Owner prepares briefing", evidenceIds: ["meeting-a:v1"] }],
  uninterpretedText: [],
};
export function sourceReadFixture(projection = projectionFixture): Extract<AuthoritativeSourceRead, { state: "available" }> {
  return { state: "available", source: observationSource, authority: { tenantId: observationOwner.tenantId, requestActorId: observationOwner.actorId,
    authoredOwnerActorId: observationOwner.actorId, authoritySha256: "a".repeat(64), purpose: "responsibility_observation" },
    revisionId: "meeting-a:v1", revisionSha256: "b".repeat(64), observedAt: observationNow, sourceUpdatedAt: observationNow, freshUntil: "2026-10-04T01:00:00.000Z",
    current: true, complete: true, evidence: [{ kind: "meeting_revision", id: "meeting-a:v1", revisionId: "meeting-a:v1", revisionSha256: "b".repeat(64), contentSha256: "c".repeat(64) }], projection };
}
