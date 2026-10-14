import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { verifyPilotConfiguration } from "./lifecycle-state";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { observationNow, observationOwner, observationPolicySha256, observationRecord, projectionFixture, sourceReadFixture } from "./observation-test-fixtures";
import { runtimeHead } from "./runtime-test-fixtures";
import { admitNotificationCandidate, buildNotificationConfiguration, enableNotificationAdmission } from "./notification-state";
import { prepareResponsibilityChange, reviewPreview } from "./state";

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
export function notificationRecoveryFixture() {
  const now = "2026-10-04T00:02:00.000Z";
  const preview = reviewPreview(notificationRecord, notificationRecord.review!.pins);
  const record = prepareResponsibilityChange({ owner: notificationOwner, id: notificationRecord.id, current: notificationRecord, key: "notification-fresh-review", now,
    mutation: { action: "review", expectedRevision: notificationRecord.revision, draftSha256: notificationRecord.draftSha256, reviewSha256: preview.reviewSha256 }, preview }).current;
  const { configurationSha256: ignored, ...oldConfiguration } = notificationRuntime.configuration; void ignored;
  const configurationBody = { ...oldConfiguration, responsibilityRevision: record.revision, reviewSha256: record.review!.reviewSha256, pins: record.review!.pins };
  const runtime = { ...notificationRuntime, revision: 7, generation: 3, reason: "owner_resumed" as const, updatedAt: now,
    configuration: verifyPilotConfiguration({ ...configurationBody, configurationSha256: canonicalJsonSha256(configurationBody) }) };
  const previous = { ...notificationHead(), revision: 2, generation: 2, state: "ended" as const, reason: "runtime_blocked" as const, used: 1, updatedAt: "2026-10-04T00:01:00.000Z" };
  const configuration = buildNotificationConfiguration(record, runtime, now);
  const request = { action: "enable" as const, expectedRevision: previous.revision, expectedGeneration: previous.generation,
    expectedRuntimeRevision: runtime.revision, expectedRuntimeGeneration: runtime.generation, configurationSha256: configuration.configurationSha256, acknowledgeDestination: "owner_in_app" as const };
  return { previous, record, runtime, configuration, request, now };
}
export async function notificationPending() {
  let projection = projectionFixture;
  const flow = createResponsibilityObservationPipeline({ record: observationRecord, policySha256: observationPolicySha256, readAuthoritativeSource: async () => sourceReadFixture(projection) });
  const baseline = flow.plan(await flow.read({ observationKey: "baseline", observedAt: observationNow }), null, 0);
  projection = { ...projection, meeting: { ...projection.meeting!, startsAt: "2026-10-05T10:00:00.000Z" } };
  const changed = flow.plan(await flow.read({ observationKey: "change", observedAt: observationNow }), baseline.nextBaseline, 1);
  return admitNotificationCandidate(notificationHead(), changed.change!, "2026-10-04T01:00:00.000Z", observationNow);
}
