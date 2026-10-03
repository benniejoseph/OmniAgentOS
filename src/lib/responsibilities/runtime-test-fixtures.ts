import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "./comparison-policy";
import { PILOT_CHECK_RESERVATION } from "./cumulative-budget";
import { changeResponsibilityLifecycle, verifyPilotConfiguration } from "./lifecycle-state";
import { RESPONSIBILITY_PILOT } from "./runtime-contracts";
import { draftFixture, nowFixture, ownerFixture, pinsFixture } from "./test-fixtures";
import { responsibilityId } from "./state";

export const runtimeOwner = ownerFixture;
export const runtimeNow = nowFixture;
export const runtimeId = responsibilityId(runtimeOwner, "runtime-fixture");
export const runtimeSource = { kind: "meeting" as const, workspaceId: "workspace:owner", id: "meeting:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const body = { schemaVersion: 1 as const, pilot: RESPONSIBILITY_PILOT, responsibilityRevision: 2, reviewSha256: "1".repeat(64), draftSha256: "2".repeat(64),
  pins: { ...pinsFixture, sources: [{ source: runtimeSource, revisionSha256: "a".repeat(64) }] }, source: runtimeSource,
  tool: { id: "app.meetings.show" as const, input: { workspaceId: runtimeSource.workspaceId, meetingId: runtimeSource.id }, contractSha256: "3".repeat(64) },
  cadence: draftFixture.cadence!, maximumChecks: 7, cumulativeLimits: draftFixture.limits!.cumulative, checkReservation: PILOT_CHECK_RESERVATION,
  comparisonPolicySha256: RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256, stops: ["expiry", "meeting_started", "meeting_canceled"],
  notificationAuthority: "none" as const, approvalAuthority: "none" as const, mutationAuthority: "none" as const };
export const runtimeConfiguration = verifyPilotConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) });
export const runtimeHead = changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: null,
  configuration: runtimeConfiguration, now: runtimeNow, nextDueAt: runtimeNow,
  request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: runtimeConfiguration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT } });
