import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { RESPONSIBILITY_COMPATIBILITY, RESPONSIBILITY_CONTRACT } from "@/lib/responsibilities/contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { buildRuntimeReceipt } from "@/lib/responsibilities/lifecycle-state";
import { buildNotificationReceipt } from "@/lib/responsibilities/notification-state";
import {
  notificationConfiguration, notificationEnableRequest, notificationHead,
  notificationNow, notificationOwner, notificationPending, notificationRecord, notificationRuntime,
} from "@/lib/responsibilities/notification-test-fixtures";
import { RESPONSIBILITY_NOTIFICATION_CONTRACT } from "@/lib/responsibilities/notification-contracts";
import { RESPONSIBILITY_OBSERVATION_CONTRACT } from "@/lib/responsibilities/observation-contracts";
import { createResponsibilityObservationPipeline } from "@/lib/responsibilities/observation-state";
import { sourceReadFixture } from "@/lib/responsibilities/observation-test-fixtures";
import { RESPONSIBILITY_PILOT, RESPONSIBILITY_PILOT_DISCLOSURE, RESPONSIBILITY_RUNTIME_CONTRACT } from "@/lib/responsibilities/runtime-contracts";
import { prepareResponsibilityChange, responsibilityId, reviewPreview } from "@/lib/responsibilities/state";
import { draftFixture, nowFixture, ownerFixture, pinsFixture } from "@/lib/responsibilities/test-fixtures";
import {
  nativeResponsibilityChangeRequestSchema,
  nativeResponsibilityContractSchemas,
  nativeResponsibilityCreateRequestSchema,
  nativeResponsibilityErrorResponseSchema,
  nativeResponsibilityLifecycleMutationResponseSchema,
  nativeResponsibilityLifecycleReadResponseSchema,
  nativeResponsibilityLifecycleRequestSchema,
  nativeResponsibilityListResponseSchema,
  nativeResponsibilityMutationResponseSchema,
  nativeResponsibilityNotificationControlRequestSchema,
  nativeResponsibilityNotificationsMutationResponseSchema,
  nativeResponsibilityNotificationsReadResponseSchema,
  nativeResponsibilityObservationsResponseSchema,
  nativeResponsibilityReadResponseSchema,
  nativeResponsibilityReferencesResponseSchema,
} from "./responsibility-contracts";

const draftEnvelope = { schemaVersion: 1, contract: RESPONSIBILITY_CONTRACT, compatibility: RESPONSIBILITY_COMPATIBILITY };
const createRequest = { action: "create" as const, expectedRevision: 0 as const, draft: draftFixture };
const created = prepareResponsibilityChange({
  owner: ownerFixture, id: responsibilityId(ownerFixture, "native-contract"), key: "native-contract",
  now: nowFixture, mutation: createRequest,
});
const runtimeEnvelope = { schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT };
const lifecycleRead = {
  ...runtimeEnvelope, current: notificationRuntime, disclosure: RESPONSIBILITY_PILOT_DISCLOSURE,
  wakes: [], receipts: [], coverage: { limit: 40, total: null, hasMoreWakes: false, hasMoreReceipts: false },
  dispatchReadiness: "not_observed", deliverySupported: false,
};
const notificationEnvelope = {
  schemaVersion: 1, contract: RESPONSIBILITY_NOTIFICATION_CONTRACT,
  disclosure: "Only explicitly enabled changes create owner inbox items.", externalDelivery: false,
};
const notificationsRead = {
  ...notificationEnvelope, current: null, candidates: [], receipts: [],
  coverage: { limit: 40, total: null, hasMoreCandidates: false, hasMoreReceipts: false },
};
const available = { state: "available", items: [], hasMore: false };
const unavailable = { state: "unavailable", items: [], hasMore: null, errorCode: "responsibility_reference_read_unavailable" };
const references = {
  schemaVersion: 1, contract: "asael-responsibility-references:1", owner: ownerFixture,
  groups: { sources: available, work: available, procedures: unavailable, agents: available },
  coverage: { perGroupLimit: 40, totals: "unavailable" }, authorityEffect: "none",
};

describe("Native Responsibility wire contracts", () => {
  it("reuses strict create, change, runtime and separate inbox admission requests", () => {
    expect(nativeResponsibilityCreateRequestSchema.parse(createRequest)).toEqual(createRequest);
    expect(nativeResponsibilityChangeRequestSchema.parse({ action: "update", expectedRevision: 1, draft: draftFixture }).action).toBe("update");
    expect(nativeResponsibilityChangeRequestSchema.parse({ action: "review", expectedRevision: 1, draftSha256: "a".repeat(64), reviewSha256: "b".repeat(64) }).action).toBe("review");
    expect(nativeResponsibilityLifecycleRequestSchema.parse({
      action: "activate", expectedRevision: 0, expectedGeneration: 0,
      configurationSha256: notificationRuntime.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT,
    }).action).toBe("activate");
    expect(nativeResponsibilityLifecycleRequestSchema.parse({ action: "pause", expectedRevision: 1, expectedGeneration: 1 }).action).toBe("pause");
    expect(nativeResponsibilityNotificationControlRequestSchema.parse(notificationEnableRequest)).toEqual(notificationEnableRequest);
    expect(nativeResponsibilityNotificationControlRequestSchema.parse({ action: "stop", expectedRevision: 2, expectedGeneration: 1 }).action).toBe("stop");
    expect(nativeResponsibilityCreateRequestSchema.safeParse({ ...createRequest, tenantId: ownerFixture.tenantId }).success).toBe(false);
    expect(nativeResponsibilityNotificationControlRequestSchema.safeParse({ action: "stop", expectedRevision: 2 }).success).toBe(false);
    expect(nativeResponsibilityNotificationControlRequestSchema.safeParse({ ...notificationEnableRequest, acknowledgeDestination: "push" }).success).toBe(false);
  });

  it("preserves draft compatibility and all four bounded readiness variants", () => {
    const list = { ...draftEnvelope, records: [created.current], hasMore: false, coverage: { kind: "bounded_recent", limit: 40, returned: 1, total: null } };
    expect(nativeResponsibilityListResponseSchema.parse(list)).toEqual(list);
    for (const readiness of [
      { state: "not_checked", issues: [] },
      { state: "incomplete", issues: ["sources_required"] },
      { state: "blocked", issues: ["responsibility_reference_changed"] },
      reviewPreview(created.current, pinsFixture),
    ]) {
      const response = { ...draftEnvelope, record: created.current, readiness };
      expect(nativeResponsibilityReadResponseSchema.parse(response)).toEqual(response);
    }
    expect(nativeResponsibilityListResponseSchema.safeParse({ ...list, coverage: { ...list.coverage, returned: 0 } }).success).toBe(false);
    expect(nativeResponsibilityReadResponseSchema.safeParse({
      ...draftEnvelope, record: created.current, readiness: { ...reviewPreview(created.current, pinsFixture), activationSupported: true },
    }).success).toBe(false);
    expect(nativeResponsibilityListResponseSchema.safeParse({ ...list, compatibility: { ...RESPONSIBILITY_COMPATIBILITY, executionAuthority: "active" } }).success).toBe(false);
  });

  it("keeps mutation receipts distinct from current state and permits accepted replay", () => {
    const changed = prepareResponsibilityChange({
      owner: ownerFixture, id: created.current.id, key: "native-update", current: created.current, now: nowFixture,
      mutation: { action: "update", expectedRevision: 1, draft: { ...draftFixture, purpose: "Updated purpose" } },
    });
    const response = { ...draftEnvelope, current: changed.current, receipt: created.receipt, replayed: true };
    expect(nativeResponsibilityMutationResponseSchema.parse(response)).toEqual(response);
    expect(nativeResponsibilityMutationResponseSchema.safeParse({ ...response, receipt: null }).success).toBe(false);
    expect(nativeResponsibilityMutationResponseSchema.safeParse({ ...response, authorityEffect: "none" }).success).toBe(false);
  });

  it("keeps unavailable reference groups distinct from available empty results", () => {
    expect(nativeResponsibilityReferencesResponseSchema.parse(references)).toEqual(references);
    const sources = { ...available, items: [{ source: draftFixture.sources[0], label: "Selected thread" }] };
    expect(nativeResponsibilityReferencesResponseSchema.parse({ ...references, groups: { ...references.groups, sources } }).groups.sources.state).toBe("available");
    for (const procedures of [
      { ...unavailable, hasMore: false },
      { ...unavailable, items: [{ id: "procedure-a", label: "Procedure" }] },
      { ...available, items: Array.from({ length: 41 }, () => ({ id: "procedure-a", label: "Procedure" })) },
    ]) {
      expect(nativeResponsibilityReferencesResponseSchema.safeParse({ ...references, groups: { ...references.groups, procedures } }).success).toBe(false);
    }
    expect(nativeResponsibilityReferencesResponseSchema.safeParse({ ...references, owner: { ...ownerFixture, actorId: "owner@example.test" } }).success).toBe(false);
  });

  it("describes nullable lifecycle reads and previews without granting delivery", () => {
    expect(nativeResponsibilityLifecycleReadResponseSchema.parse(lifecycleRead)).toEqual(lifecycleRead);
    expect(nativeResponsibilityLifecycleReadResponseSchema.parse({ ...lifecycleRead, current: null }).current).toBeNull();
    for (const preview of [
      { state: "ready", configuration: notificationRuntime.configuration, authorityEffect: "none", dispatchReadiness: "not_observed" },
      { state: "blocked", reason: "responsibility_owner_revoked", authorityEffect: "none" },
    ]) {
      expect(nativeResponsibilityLifecycleReadResponseSchema.parse({ ...lifecycleRead, preview }).preview).toEqual(preview);
    }
    const receipt = buildRuntimeReceipt({ key: "native-activate", request: {}, action: "activate", previousRevision: 0, current: notificationRuntime });
    expect(nativeResponsibilityLifecycleMutationResponseSchema.parse({ ...runtimeEnvelope, current: notificationRuntime, receipt, replayed: false }).receipt).toEqual(receipt);
    expect(nativeResponsibilityLifecycleReadResponseSchema.safeParse({ ...lifecycleRead, deliverySupported: true }).success).toBe(false);
    expect(nativeResponsibilityLifecycleReadResponseSchema.safeParse({ ...lifecycleRead, coverage: { ...lifecycleRead.coverage, total: 0 } }).success).toBe(false);
    expect(nativeResponsibilityLifecycleMutationResponseSchema.safeParse({ ...runtimeEnvelope, current: null, receipt, replayed: false }).success).toBe(false);
  });

  it("retains typed observation evidence and bounded history with a nullable baseline", async () => {
    const policy = RESPONSIBILITY_MEETING_COMPARISON_POLICY;
    const pipeline = createResponsibilityObservationPipeline({ record: notificationRecord, policySha256: policy.policySha256, readAuthoritativeSource: async () => sourceReadFixture() });
    const plan = pipeline.plan(await pipeline.read({ observationKey: "native-baseline", observedAt: notificationNow }), null, 0);
    const request = { responsibilityId: notificationRecord.id, expectedResponsibilityRevision: notificationRecord.revision,
      expectedReviewSha256: notificationRecord.review!.reviewSha256, expectedBaselineRevision: 0, policySha256: policy.policySha256 };
    const body = { schemaVersion: 1, request, requestSha256: canonicalJsonSha256({ owner: notificationOwner, request }), plan, savedAt: notificationNow };
    const receipt = { ...body, receiptSha256: canonicalJsonSha256(body) };
    const response = {
      schemaVersion: 1, contract: RESPONSIBILITY_OBSERVATION_CONTRACT, policy, authorityEffect: "none", activationSupported: false, deliverySupported: false,
      receipts: [receipt], baseline: plan.nextBaseline, hasMore: false, coverage: { kind: "bounded_recent", limit: 25, returned: 1, total: null },
    };
    expect(nativeResponsibilityObservationsResponseSchema.parse(response)).toEqual(response);
    expect(nativeResponsibilityObservationsResponseSchema.parse({ ...response, receipts: [], baseline: null, coverage: { ...response.coverage, returned: 0 } }).baseline).toBeNull();
    expect(nativeResponsibilityObservationsResponseSchema.safeParse({ ...response, coverage: { ...response.coverage, limit: 101 } }).success).toBe(false);
    expect(nativeResponsibilityObservationsResponseSchema.safeParse({ ...response, deliverySupported: true }).success).toBe(false);
  });

  it("publishes separate nullable inbox authority, pending candidates, previews and immutable receipts", async () => {
    expect(nativeResponsibilityNotificationsReadResponseSchema.parse(notificationsRead)).toEqual(notificationsRead);
    const pending = await notificationPending();
    const receipt = buildNotificationReceipt({ previous: notificationHead(), ...pending, key: "native-admit", request: {}, action: "admit" });
    const response = { ...notificationsRead, current: pending.current, candidates: [pending.candidate], receipts: [receipt] };
    expect(nativeResponsibilityNotificationsReadResponseSchema.parse(response)).toEqual(response);
    for (const preview of [
      { state: "ready", authorityEffect: "none", configuration: notificationConfiguration,
        expectedRuntimeRevision: notificationRuntime.revision, expectedRuntimeGeneration: notificationRuntime.generation },
      { state: "blocked", reason: "responsibility_notification_preferences_unavailable", authorityEffect: "none" },
    ]) {
      expect(nativeResponsibilityNotificationsReadResponseSchema.parse({ ...notificationsRead, preview }).preview).toEqual(preview);
    }
    expect(nativeResponsibilityNotificationsMutationResponseSchema.parse({ ...notificationEnvelope, current: pending.current, receipt, replayed: true }).receipt).toEqual(receipt);
    expect(nativeResponsibilityNotificationsReadResponseSchema.safeParse({ ...response, candidates: Array.from({ length: 41 }, () => pending.candidate) }).success).toBe(false);
    expect(nativeResponsibilityNotificationsReadResponseSchema.safeParse({ ...response, externalDelivery: true }).success).toBe(false);
    expect(nativeResponsibilityNotificationsReadResponseSchema.safeParse({ ...response, preview: null }).success).toBe(false);
  });

  it("preserves the three actual flat error families and refuses nested or ambiguous errors", () => {
    for (const response of [
      { error: "The exact revision changed.", code: "responsibility_notification_changed", reload: true },
      { error: "Responsibility drafts are temporarily unavailable.", code: "responsibility_unavailable" },
      { error: "Unauthorized", message: "Authentication required" },
      { error: "Forbidden", message: "Access denied" },
      { error: "Invalid request", message: "An Idempotency-Key header is required for this change." },
    ]) expect(nativeResponsibilityErrorResponseSchema.parse(response)).toEqual(response);
    for (const response of [
      { error: { code: "responsibility_unavailable", message: "Unavailable" } },
      { error: "Unavailable", code: "responsibility_unavailable", reload: false },
      { error: "Forbidden", message: "Denied", code: "unexpected" },
    ]) expect(nativeResponsibilityErrorResponseSchema.safeParse(response).success).toBe(false);
  });

  it("exports every request and response as structural JSON Schema without transforms", () => {
    expect(Object.keys(nativeResponsibilityContractSchemas)).toHaveLength(14);
    for (const schema of Object.values(nativeResponsibilityContractSchemas)) {
      const document = z.toJSONSchema(schema, { target: "draft-2020-12" });
      expect(document).toBeTypeOf("object");
      expect(JSON.stringify(document)).not.toContain('"additionalProperties":true');
    }
  });
});
