import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { verifyPilotConfiguration } from "./lifecycle-state";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { observationNow, observationOwner, observationPolicySha256, observationRecord, projectionFixture, sourceReadFixture } from "./observation-test-fixtures";
import { runtimeHead } from "./runtime-test-fixtures";
import { admitNotificationCandidate, buildNotificationConfiguration, enableNotificationAdmission } from "./notification-state";

export const notificationNow = observationNow;
export const notificationOwner = observationOwner;
export const notificationRecord = observationRecord;
export const notificationContext = { tenantId: notificationOwner.tenantId, actorId: "owner@example.test", role: "operator" as const, source: "session" as const,
  auth: { userId: notificationOwner.actorId.slice(6), email: "owner@example.test", sessionId: "notification-fixture", tenantName: "Fixture" } };
const source = observationRecord.draft.sources[0];
if (source.kind !== "meeting") throw new Error("Expected Meeting fixture");
const { configurationSha256: omittedHash, ...old } = runtimeHead.configuration; void omittedHash;
const body = { ...old, responsibilityRevision: observationRecord.revision, reviewSha256: observationRecord.review!.reviewSha256,
  draftSha256: observationRecord.draftSha256, pins: observationRecord.review!.pins, source,
  tool: { ...old.tool, input: { workspaceId: source.workspaceId, meetingId: source.id } } };
export const notificationRuntime = { ...runtimeHead, responsibilityId: observationRecord.id,
  configuration: verifyPilotConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) }) };
export const notificationConfiguration = buildNotificationConfiguration(observationRecord, notificationRuntime, observationNow);
export const notificationEnableRequest = { action: "enable" as const, expectedRuntimeRevision: notificationRuntime.revision, expectedRuntimeGeneration: notificationRuntime.generation,
  configurationSha256: notificationConfiguration.configurationSha256, acknowledgeDestination: "owner_in_app" as const };
export function notificationHead() { return enableNotificationAdmission(notificationConfiguration, notificationRuntime, notificationEnableRequest, observationNow); }
export async function notificationPending() {
  let projection = projectionFixture;
  const flow = createResponsibilityObservationPipeline({ record: observationRecord, policySha256: observationPolicySha256, readAuthoritativeSource: async () => sourceReadFixture(projection) });
  const baseline = flow.plan(await flow.read({ observationKey: "baseline", observedAt: observationNow }), null, 0);
  projection = { ...projection, meeting: { ...projection.meeting!, startsAt: "2026-10-05T10:00:00.000Z" } };
  const changed = flow.plan(await flow.read({ observationKey: "change", observedAt: observationNow }), baseline.nextBaseline, 1);
  return admitNotificationCandidate(notificationHead(), changed.change!, "2026-10-04T01:00:00.000Z", observationNow);
}
