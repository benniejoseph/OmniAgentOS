import { describe, expect, it, vi } from "vitest";
import { RESPONSIBILITY_COMPATIBILITY } from "@/lib/responsibilities/contracts";
import { prepareResponsibilityChange, responsibilityId } from "@/lib/responsibilities/state";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner } from "@/lib/responsibilities/test-fixtures";
import { DRAFT_CONTRACT, type ResponsibilityMutation } from "./model";
import { ResponsibilityController } from "./controller";
import { ResponseError } from "./client";
import { notificationEnableRequest, notificationHead, notificationOwner, notificationRecord } from "@/lib/responsibilities/notification-test-fixtures";
import { buildNotificationReceipt } from "@/lib/responsibilities/notification-state";
import { buildRuntimeReceipt, changeResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-state";
import { runtimeHead, runtimeId, runtimeNow, runtimeOwner } from "@/lib/responsibilities/runtime-test-fixtures";
import { NOTIFICATIONS_CONTRACT } from "./notifications-model";

const key = "controller-create"; const id = responsibilityId(owner, key);
const mutation = { action: "create" as const, expectedRevision: 0 as const, draft };
const created = () => prepareResponsibilityChange({ owner, id, key, now, mutation });
const envelope = (value: object) => ({ schemaVersion: 1, contract: DRAFT_CONTRACT, compatibility: RESPONSIBILITY_COMPATIBILITY, ...value });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }

describe("Responsibility request state", () => {
  it("freezes submitted input, serializes mutations and retries exactly the same body and key", async () => {
    const first = deferred<unknown>(); const writes: { key: string; body: unknown }[] = [];
    const request = vi.fn(async (_path: string, _signal: AbortSignal, input?: { method: "POST" | "PATCH"; key: string; body: unknown }) => {
      if (!input) throw new Error("Refresh unavailable"); writes.push(input); if (writes.length === 1) return first.promise; return envelope(created());
    });
    const controller = new ResponsibilityController("owner-role-deployment", owner, { request, key: () => key }); controller.setActive(true);
    const submitted = structuredClone(mutation); const waiting = controller.submit({ kind: "draft", body: submitted });
    submitted.draft.purpose = "Edited after dispatch";
    await controller.submit({ kind: "draft", body: submitted }); expect(writes).toHaveLength(1);
    first.resolve({ schemaVersion: 999 }); await waiting;
    expect(controller.getSnapshot().pending?.body).toEqual(mutation);
    expect(controller.getSnapshot().mutationError).toContain("unconfirmed");
    await controller.retry();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(controller.getSnapshot().accepted).toMatchObject({ kind: "draft", result: { receipt: { snapshot: { revision: 1 } } } });
    expect(controller.getSnapshot().detail).toMatchObject({ state: "error", error: "Refresh unavailable" });
    expect(controller.getSnapshot().mutationError).toBeUndefined(); expect(controller.getSnapshot().pending).toBeUndefined();
  });
  it("does not publish a late response after same-owner suspension or disposal", async () => {
    for (const dispose of [false, true]) {
      const held = deferred<unknown>(); const request = vi.fn(async () => held.promise);
      const controller = new ResponsibilityController("scope", owner, { request, key: () => key }); controller.setActive(true);
      const pending = controller.load("detail", id);
      if (dispose) controller.dispose(); else controller.setActive(false);
      held.resolve(envelope({ record: created().current, readiness: { state: "not_checked", issues: [] } })); await pending;
      expect(controller.getSnapshot().detail.value).toBeUndefined();
    }
  });
  it("only publishes the newest read and does not trust abort delivery", async () => {
    const old = deferred<unknown>(); const latest = deferred<unknown>();
    const request = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    const controller = new ResponsibilityController("scope", owner, { request, key: () => key }); controller.setActive(true);
    const a = controller.load("detail", id); const b = controller.load("detail", id);
    latest.resolve(envelope({ record: created().current, readiness: { state: "not_checked", issues: [] } })); await b;
    old.resolve({ error: "Old malformed response" }); await a;
    expect(controller.getSnapshot().detail).toMatchObject({ state: "ready", value: { record: { id } } });
  });
  it("clears a definitively rejected CAS request but retains local draft inputs outside the controller", async () => {
    const request = vi.fn(async () => { throw new ResponseError("Revision changed", 409); });
    const controller = new ResponsibilityController("scope", owner, { request, key: () => key }); controller.setActive(true);
    const body: ResponsibilityMutation = { action: "update", expectedRevision: 1, draft };
    await controller.submit({ kind: "draft", id, body });
    expect(controller.getSnapshot()).toMatchObject({ submitting: false, mutationError: "Request rejected. Revision changed" });
    expect(controller.getSnapshot().pending).toBeUndefined(); expect(controller.getSnapshot().accepted).toBeUndefined();
  });
  it("keeps a submitted uncertain receipt bound to its original controller scope", async () => {
    const held = deferred<unknown>(); const request = vi.fn(async () => held.promise);
    const previous = new ResponsibilityController("tenant-owner-admin-release1", owner, { request, key: () => key }); previous.setActive(true);
    const pending = previous.submit({ kind: "draft", body: mutation }); previous.setActive(false);
    const next = new ResponsibilityController("tenant-other-viewer-release2", { ...owner, actorId: "other" }, { request, key: () => key }); next.setActive(true);
    held.resolve(envelope(created())); await pending;
    expect(previous.getSnapshot().accepted).toBeUndefined(); expect(next.getSnapshot().pending).toBeUndefined(); expect(next.getSnapshot().accepted).toBeUndefined();
  });
  it("shares one synchronous slot across notification, draft and lifecycle actions, settling acceptance before a failed read", async () => {
    const held = deferred<unknown>(); const writes: unknown[] = [];
    const request = vi.fn(async (_path: string, _signal: AbortSignal, input?: { method: "POST" | "PATCH"; key: string; body: unknown }) => {
      if (!input) throw new Error("Notification history unavailable"); writes.push(input); return held.promise;
    });
    const controller = new ResponsibilityController("notification-scope", notificationOwner, { request, key: () => "enable" }); controller.setActive(true);
    const waiting = controller.submit({ kind: "notifications", id: notificationRecord.id, body: notificationEnableRequest });
    await controller.submit({ kind: "draft", body: mutation });
    await controller.submit({ kind: "runtime", id: notificationRecord.id, body: { action: "pause", expectedRevision: 1, expectedGeneration: 1 } });
    expect(writes).toHaveLength(1);
    const current = notificationHead(); const receipt = buildNotificationReceipt({ previous: null, current, action: "enable", key: "enable", request: { responsibilityId: notificationRecord.id, ...notificationEnableRequest } });
    held.resolve({ schemaVersion: 1, contract: NOTIFICATIONS_CONTRACT, disclosure: "Separate admission", externalDelivery: false, current, receipt, replayed: false }); await waiting;
    expect(controller.getSnapshot()).toMatchObject({ submitting: false, accepted: { kind: "notifications", result: { receipt } }, notifications: { state: "error" } });
    expect(controller.getSnapshot().pending).toBeUndefined(); expect(controller.getSnapshot().mutationError).toBeUndefined();
  });
  it("retains earlier notification uncertainty after a later 4xx and never creates a replacement key", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("Transport interrupted")).mockRejectedValueOnce(new ResponseError("Permission changed", 403));
    const keyFactory = vi.fn(() => "frozen-enable");
    const controller = new ResponsibilityController("notification-scope", notificationOwner, { request, key: keyFactory }); controller.setActive(true);
    await controller.submit({ kind: "notifications", id: notificationRecord.id, body: notificationEnableRequest });
    await controller.retry();
    expect(controller.getSnapshot().pending).toMatchObject({ kind: "notifications", key: "frozen-enable", uncertain: true, body: notificationEnableRequest });
    expect(controller.getSnapshot().mutationError).toContain("earlier submitted request remains unconfirmed");
    expect(keyFactory).toHaveBeenCalledOnce(); expect(request.mock.calls[0][2]).toEqual(request.mock.calls[1][2]);
  });
  it("refreshes notification state after accepted lifecycle changes without changing that receipt", async () => {
    const body = { action: "pause" as const, expectedRevision: runtimeHead.revision, expectedGeneration: runtimeHead.generation };
    const current = changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: runtimeHead, request: body, now: runtimeNow });
    const receipt = buildRuntimeReceipt({ key: "pause", request: { responsibilityId: runtimeId, ...body }, action: "pause", previousRevision: runtimeHead.revision, current });
    const request = vi.fn(async (_path: string, _signal: AbortSignal, input?: unknown) => {
      if (input) return { schemaVersion: 1, contract: "asael-responsibility-runtime:1", current, receipt, replayed: false };
      throw new Error("Independent read failed");
    });
    const controller = new ResponsibilityController("scope", runtimeOwner, { request, key: () => "pause" }); controller.setActive(true);
    await controller.submit({ kind: "runtime", id: runtimeId, body });
    expect(request.mock.calls.some(([path, , input]) => path.endsWith("/notifications") && input === undefined)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ accepted: { kind: "runtime", result: { receipt } }, notifications: { state: "error" }, submitting: false });
  });
});
