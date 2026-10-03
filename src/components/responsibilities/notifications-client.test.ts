import { describe, expect, it } from "vitest";
import { notificationEnableRequest as request, notificationHead, notificationNow as now, notificationOwner as owner, notificationPending, notificationRecord as record, notificationRuntime as runtime } from "@/lib/responsibilities/notification-test-fixtures";
import { buildNotificationReceipt, notificationCandidateId, transitionNotificationCandidate } from "@/lib/responsibilities/notification-state";
import { NOTIFICATIONS_CONTRACT } from "./notifications-model";
import { readNotifications, verifyNotificationsResult } from "./notifications-client";

const base = { schemaVersion: 1, contract: NOTIFICATIONS_CONTRACT, disclosure: "Separate owner inbox admission. No external delivery.", externalDelivery: false };
const coverage = { limit: 40, total: null, hasMoreCandidates: false, hasMoreReceipts: false };
const enabled = (key = "enable") => {
  const current = notificationHead();
  return { ...base, current, receipt: buildNotificationReceipt({ previous: null, current, action: "enable", key, request: { responsibilityId: record.id, ...request } }), replayed: false };
};
describe("Responsibility notification browser receipts", () => {
  it("accepts a read-only empty history and exact preview without interpreting them as delivery", async () => {
    const empty = { ...base, current: null, candidates: [], receipts: [], coverage };
    expect(await readNotifications(empty, owner, record.id)).toMatchObject({ current: null, candidates: [] });
    expect(await readNotifications({ ...empty, preview: { state: "ready", authorityEffect: "none", configuration: notificationHead().configuration,
      expectedRuntimeRevision: runtime.revision, expectedRuntimeGeneration: runtime.generation } }, owner, record.id)).toMatchObject({ preview: { state: "ready", authorityEffect: "none" } });
    await expect(readNotifications({ ...empty, coverage: { ...coverage, total: 0 } }, owner, record.id)).rejects.toThrow();
  });
  it("binds enable to exact owner, key, frozen configuration and immutable request digest", async () => {
    const result = enabled();
    expect(await verifyNotificationsResult(result, owner, record.id, request, "enable")).toMatchObject({ receipt: { action: "enable", candidate: null }, current: { used: 0 } });
    for (const attempt of [
      () => verifyNotificationsResult(result, { ...owner, tenantId: "other" }, record.id, request, "enable"),
      () => verifyNotificationsResult(result, { ...owner, actorId: "actor:00000000-0000-4000-8000-000000000000" }, record.id, request, "enable"),
      () => verifyNotificationsResult(result, owner, record.id, request, "other"),
      () => verifyNotificationsResult(result, owner, record.id, { ...request, expectedRuntimeGeneration: 99 }, "enable"),
      () => verifyNotificationsResult(result, owner, record.id, { ...request, configurationSha256: "f".repeat(64) }, "enable"),
    ]) await expect(attempt()).rejects.toThrow();
  });
  it("keeps an old accepted receipt distinct from a newer current head during same-key recovery", async () => {
    const first = enabled(); const pending = await notificationPending();
    const replay = { ...first, current: pending.current, replayed: true };
    expect(await verifyNotificationsResult(replay, owner, record.id, request, "enable")).toMatchObject({ current: { reserved: 1 }, receipt: { snapshot: { reserved: 0 } } });
    await expect(verifyNotificationsResult({ ...replay, replayed: false }, owner, record.id, request, "enable")).rejects.toThrow();
  });
  it("validates canceled hold identity and a stop receipt spanning its exact cancellation revisions", async () => {
    const pending = await notificationPending();
    const held = transitionNotificationCandidate(pending.current, pending.candidate, { now, outcome: "hold", reason: "quiet_hours", dispositionId: `notification_disposition_${"a".repeat(48)}` });
    const input = { action: "stop" as const, expectedRevision: held.current.revision, expectedGeneration: held.current.generation };
    const canceled = transitionNotificationCandidate(held.current, held.candidate, { now, outcome: "cancel", reason: "owner_stopped" });
    const current = { ...canceled.current, revision: canceled.current.revision + 1, generation: canceled.current.generation + 1, state: "ended" as const, reason: "owner_stopped" as const };
    const stop = buildNotificationReceipt({ previous: canceled.current, current, action: "stop", key: "stop", request: { responsibilityId: record.id, ...input } });
    expect(await verifyNotificationsResult({ ...base, current, receipt: stop, replayed: false }, owner, record.id, input, "stop")).toMatchObject({ current: { reserved: 0, reason: "owner_stopped" } });
    expect(await readNotifications({ ...base, current, candidates: [canceled.candidate], receipts: [stop], coverage }, owner, record.id)).toMatchObject({ candidates: [{ dispositionId: held.candidate.dispositionId, state: "canceled" }] });
    await expect(verifyNotificationsResult({ ...base, current, receipt: stop, replayed: false }, owner, record.id, { ...input, expectedRevision: 99 }, "stop")).rejects.toThrow();
  });
  it("rejects malformed, duplicate, foreign, over-limit or unsupported read data", async () => {
    const pending = await notificationPending();
    const valid = { ...base, current: pending.current, candidates: [pending.candidate], receipts: [], coverage };
    expect((await readNotifications(valid, owner, record.id)).candidates).toHaveLength(1);
    for (const bad of [
      { ...valid, schemaVersion: 2 }, { ...valid, externalDelivery: true }, { ...valid, current: null },
      { ...valid, candidates: Array(41).fill(pending.candidate) }, { ...valid, candidates: [pending.candidate, pending.candidate] },
      { ...valid, candidates: [{ ...pending.candidate, state: "delivered", notificationId: null }] },
      { ...valid, candidates: [{ ...pending.candidate, actorId: "foreign" }] },
      { ...valid, candidates: [{ ...pending.candidate, attempts: 101 }] },
      { ...valid, current: { ...pending.current, used: 1001 } },
      { ...valid, current: { ...pending.current, configuration: { ...pending.current.configuration, destination: "email" } } },
    ]) await expect(readNotifications(bad, owner, record.id)).rejects.toThrow();
  });
  it("only accepts a delivered candidate with its exact inbox, disposition and binding identities", async () => {
    const pending = await notificationPending();
    const delivered = transitionNotificationCandidate(pending.current, pending.candidate, { now, outcome: "deliver", reason: "in_app_recorded",
      delivery: { notificationId: `notification_${"a".repeat(48)}`, dispositionId: `notification_disposition_${"b".repeat(48)}`, deliveryBindingSha256: "c".repeat(64) } });
    const accepted = buildNotificationReceipt({ previous: pending.current, ...delivered, action: "deliver", key: "delivered", request: { candidateId: pending.candidate.id } });
    const response = { ...base, current: delivered.current, candidates: [delivered.candidate], receipts: [accepted], coverage };
    expect((await readNotifications(response, owner, record.id)).current?.used).toBe(1);
    await expect(readNotifications({ ...response, receipts: [{ ...accepted, candidate: null }] }, owner, record.id)).rejects.toThrow();
    await expect(readNotifications({ ...response, candidates: [{ ...delivered.candidate, dispositionId: null }] }, owner, record.id)).rejects.toThrow();
    await expect(readNotifications({ ...response, current: { ...delivered.current, used: 0 }, receipts: [] }, owner, record.id)).rejects.toThrow();
  });
  it("rejects pending rows from fenced generations or contradictory counts while allowing a bounded lower count", async () => {
    const pending = await notificationPending();
    const response = { ...base, current: pending.current, candidates: [pending.candidate], receipts: [], coverage };
    for (const current of [
      { ...pending.current, state: "ended", reason: "owner_stopped", reserved: 0 },
      { ...pending.current, state: "paused", reason: "runtime_paused", reserved: 0 },
      { ...pending.current, generation: pending.current.generation + 1 },
      { ...pending.current, reserved: 0 },
    ]) await expect(readNotifications({ ...response, current }, owner, record.id)).rejects.toThrow();
    const different = { ...pending.candidate, changeId: `responsibility-change:${"d".repeat(64)}` };
    const second = { ...different, id: notificationCandidateId(different) };
    await expect(readNotifications({ ...response, candidates: [pending.candidate, second] }, owner, record.id)).rejects.toThrow();
    const window = { ...response, current: { ...pending.current, reserved: 2, used: 1 }, coverage: { ...coverage, hasMoreCandidates: true } };
    expect(await readNotifications(window, owner, record.id)).toMatchObject({ current: { reserved: 2, used: 1 }, candidates: [pending.candidate] });
  });
});
