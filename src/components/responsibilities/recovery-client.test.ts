import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildBaselineRebind } from "@/lib/responsibilities/baseline-rebind";
import { buildRuntimeReceipt, reserveResponsibilityWake, verifyPilotConfiguration } from "@/lib/responsibilities/lifecycle-state";
import { RESPONSIBILITY_PILOT_DISCLOSURE } from "@/lib/responsibilities/runtime-contracts";
import { buildNotificationReceipt, enableNotificationAdmission, transitionNotificationCandidate } from "@/lib/responsibilities/notification-state";
import { notificationOwner as owner, notificationPending, notificationRecord, notificationRecoveryFixture, notificationRuntime } from "@/lib/responsibilities/notification-test-fixtures";
import { createResponsibilityObservationPipeline } from "@/lib/responsibilities/observation-state";
import { observationNow, observationPolicySha256, sourceReadFixture } from "@/lib/responsibilities/observation-test-fixtures";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { readObservations, readRuntime } from "./client";
import { RUNTIME_CONTRACT } from "./model";
import { NOTIFICATIONS_CONTRACT, type NotificationsView } from "./notifications-model";
import { readNotifications, verifyNotificationsResult } from "./notifications-client";
import { RuntimePanel } from "./runtime-panel";
import { NotificationsPanel } from "./notifications-panel";

const runtimeBase = { schemaVersion: 1, contract: RUNTIME_CONTRACT, disclosure: RESPONSIBILITY_PILOT_DISCLOSURE, wakes: [], receipts: [],
  coverage: { limit: 40, total: null, hasMoreWakes: false, hasMoreReceipts: false }, dispatchReadiness: "not_observed", deliverySupported: false };
const notificationBase = { schemaVersion: 1, contract: NOTIFICATIONS_CONTRACT, disclosure: "Separate owner inbox admission.", externalDelivery: false,
  coverage: { limit: 40, total: null, hasMoreCandidates: false, hasMoreReceipts: false } };
const notificationMutation = { schemaVersion: 1, contract: NOTIFICATIONS_CONTRACT, disclosure: "Separate owner inbox admission.", externalDelivery: false };
const blockedRuntime = () => ({ ...notificationRuntime, revision: 6, generation: 2, state: "blocked" as const, reason: "authority_changed" as const, nextDueAt: null, updatedAt: "2026-10-04T00:01:00.000Z" });

describe("Same-record Follow-up recovery in the browser", () => {
  it("requires the server recovery capability and unchanged scope before offering Restart tracking", async () => {
    const fixture = notificationRecoveryFixture(); const blocked = blockedRuntime();
    const response = { ...runtimeBase, current: blocked, preview: { state: "ready", configuration: fixture.runtime.configuration, authorityEffect: "none", dispatchReadiness: "not_observed", recovery: "reviewed_authority_change" } };
    const view = await readRuntime(response, owner, fixture.record.id);
    const props = { record: fixture.record, enabled: true, frozen: false, refresh: vi.fn(), preview: vi.fn(), control: vi.fn() };
    const html = renderToStaticMarkup(createElement(RuntimePanel, { ...props, resource: { state: "ready", value: view } }));
    expect(html).toContain("Restart tracking"); expect(html).toContain("Inbox updates remain off"); expect(html).toContain("comparison baseline");
    const withoutCapability = await readRuntime({ ...response, preview: { ...response.preview, recovery: undefined } }, owner, fixture.record.id);
    const blockedHtml = renderToStaticMarkup(createElement(RuntimePanel, { ...props, resource: { state: "ready", value: withoutCapability } }));
    expect(blockedHtml).not.toContain(">Restart tracking<"); expect(blockedHtml).toContain("Accept a fresh review"); expect(blockedHtml).not.toContain("Refresh both before continuing");
    const { configurationSha256: ignored, ...body } = fixture.runtime.configuration; void ignored;
    const changed = { ...body, maximumChecks: body.maximumChecks + 1 };
    await expect(readRuntime({ ...response, preview: { ...response.preview, configuration: verifyPilotConfiguration({ ...changed, configurationSha256: canonicalJsonSha256(changed) }) } }, owner, fixture.record.id)).rejects.toThrow();
    await expect(readRuntime({ ...response, current: { ...blocked, reason: "budget_exhausted" } }, owner, fixture.record.id)).rejects.toThrow();
  });

  it("retains terminal check history only with scoped older configuration proof and rejects old pending work", async () => {
    const fixture = notificationRecoveryFixture(); const blocked = blockedRuntime();
    const reserved = reserveResponsibilityWake(notificationRuntime, observationNow, "2026-10-04T00:10:00.000Z");
    const wake = { ...reserved.wake, state: "canceled", updatedAt: blocked.updatedAt, settledAt: blocked.updatedAt };
    const proof = buildRuntimeReceipt({ current: blocked, previousRevision: blocked.revision - 1, action: "block", key: "blocked-history", request: { state: "blocked" } });
    const response = { ...runtimeBase, current: fixture.runtime, wakes: [wake], configurationReceipts: [proof] };
    expect(await readRuntime(response, owner, fixture.record.id)).toMatchObject({ wakes: [{ state: "canceled" }], configurationReceipts: [proof] });
    for (const bad of [{ ...response, configurationReceipts: [] }, { ...response, wakes: [{ ...wake, state: "running" }] }, { ...response, wakes: [{ ...wake, configurationSha256: "f".repeat(64) }] }, { ...response, configurationReceipts: Array(41).fill(proof) }]) {
      await expect(readRuntime(bad, owner, fixture.record.id)).rejects.toThrow();
    }
  });

  it("verifies renewed inbox consent and old canceled rows without resetting cumulative use", async () => {
    const fixture = notificationRecoveryFixture(); const pending = await notificationPending();
    const canceled = transitionNotificationCandidate(pending.current, pending.candidate, { now: fixture.previous.updatedAt, outcome: "cancel", reason: "runtime_blocked" });
    const previous = { ...fixture.previous, revision: canceled.current.revision + 1 };
    const proof = buildNotificationReceipt({ previous: canceled.current, current: previous, action: "lifecycle", key: "ended-history", request: { state: "blocked" } });
    const request = { ...fixture.request, expectedRevision: previous.revision };
    const current = enableNotificationAdmission(fixture.configuration, fixture.runtime, request, fixture.now, previous);
    const receipt = buildNotificationReceipt({ previous, current, action: "enable", key: "renew", request: { responsibilityId: fixture.record.id, ...request } });
    expect(await verifyNotificationsResult({ ...notificationMutation, current, receipt, replayed: false }, owner, fixture.record.id, request, "renew")).toMatchObject({ current: { used: 1, generation: 3 } });
    const history = { ...notificationBase, current, candidates: [canceled.candidate], receipts: [receipt], configurationReceipts: [proof] };
    expect(await readNotifications(history, owner, fixture.record.id)).toMatchObject({ candidates: [{ state: "canceled" }] });
    await expect(readNotifications({ ...history, configurationReceipts: [] }, owner, fixture.record.id)).rejects.toThrow();
    await expect(readNotifications({ ...history, candidates: [{ ...canceled.candidate, configurationSha256: "f".repeat(64) }] }, owner, fixture.record.id)).rejects.toThrow();
    await expect(verifyNotificationsResult({ ...notificationMutation, current, receipt, replayed: false }, owner, fixture.record.id, { ...request, expectedGeneration: 99 }, "renew")).rejects.toThrow();
    const preview = await readNotifications({ ...notificationBase, current: previous, candidates: [], receipts: [], preview: { state: "ready", authorityEffect: "none", configuration: fixture.configuration,
      expectedRuntimeRevision: fixture.runtime.revision, expectedRuntimeGeneration: fixture.runtime.generation, expectedRevision: previous.revision, expectedGeneration: previous.generation } }, owner, fixture.record.id);
    const html = renderToStaticMarkup(createElement(NotificationsPanel, { record: fixture.record, resource: { state: "ready", value: preview }, enabled: true, frozen: false, refresh: vi.fn(), preview: vi.fn(), control: vi.fn() }));
    expect(html).toContain("Re-enable in-app notifications"); expect(html).toContain("2 notifications remain"); expect(html).toContain("canceled updates stay canceled");
    const terminal = { ...preview, current: { ...previous, reason: "owner_stopped" as const }, preview: undefined } satisfies NotificationsView;
    expect(renderToStaticMarkup(createElement(NotificationsPanel, { record: fixture.record, resource: { state: "ready", value: terminal }, enabled: true, frozen: false, refresh: vi.fn(), preview: vi.fn(), control: vi.fn() }))).not.toContain("Re-enable in-app notifications");
  });

  it("validates baseline review transfer while retaining the original observation and evidence time", async () => {
    const fixture = notificationRecoveryFixture(); const blocked = blockedRuntime();
    const flow = createResponsibilityObservationPipeline({ record: notificationRecord, policySha256: observationPolicySha256, readAuthoritativeSource: async () => sourceReadFixture() });
    const plan = flow.plan(await flow.read({ observationKey: "baseline", observedAt: observationNow }), null, 0);
    const receipt = buildRuntimeReceipt({ current: fixture.runtime, previousRevision: blocked.revision, action: "resume", key: "restart", request: { action: "resume" } });
    const rebind = buildBaselineRebind(plan.nextBaseline!, blocked, receipt);
    const response = { schemaVersion: 1, contract: "asael-responsibility-observation:1", policy: RESPONSIBILITY_MEETING_COMPARISON_POLICY, authorityEffect: "none", deliverySupported: false,
      receipts: [], baseline: rebind.next, baselineRebinds: [rebind], hasMore: false, coverage: { kind: "bounded_recent", limit: 25, returned: 0, total: null } };
    expect(await readObservations(response, owner, fixture.record.id)).toMatchObject({ baseline: { observationId: plan.nextBaseline!.observationId, acceptedAt: observationNow } });
    const { baselineSha256: oldHash, ...body } = { ...rebind.next, acceptedAt: fixture.now }; void oldHash;
    const next = { ...body, baselineSha256: canonicalJsonSha256(body) };
    const { receiptSha256: oldReceiptHash, ...forgedBody } = { ...rebind, next }; void oldReceiptHash;
    await expect(readObservations({ ...response, baselineRebinds: [{ ...forgedBody, receiptSha256: canonicalJsonSha256(forgedBody) }] }, owner, fixture.record.id)).rejects.toThrow();
  });
});
