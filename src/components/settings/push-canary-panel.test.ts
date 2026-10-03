import { describe, expect, it } from "vitest";
import { pushCanaryOutcomeCopy, readPushCanaryResult, readPushTargets } from "@/components/settings/push-canary-panel";

const base = {
  schemaVersion: 1 as const,
  canaryId: "mobile_push_canary_test",
  deliveryId: "mobile_push_delivery_test",
  timedOut: false,
  state: {
    providerState: "accepted" as const,
    appState: "none" as const,
    providerAcceptedAt: "2026-09-18T10:00:00.000Z",
    receivedAt: null,
    failureCode: null,
  },
};

describe("push receipt canary presentation", () => {
  it("does not describe provider acceptance as device delivery", () => {
    expect(pushCanaryOutcomeCopy({
      ...base,
      outcome: "timed_out",
      timedOut: true,
    })).toMatchObject({
      tone: "warning",
      title: "Provider accepted; device receipt timed out",
    });
  });

  it("describes only an app receipt as confirmed", () => {
    expect(pushCanaryOutcomeCopy({
      ...base,
      outcome: "received",
      state: { ...base.state, appState: "received", receivedAt: "2026-09-18T10:00:01.000Z" },
    })).toMatchObject({
      tone: "success",
      title: "Device receipt confirmed",
    });
  });

  it("does not claim provider acceptance while delivery is still queued", () => {
    expect(pushCanaryOutcomeCopy({
      ...base,
      outcome: "timed_out",
      timedOut: true,
      state: {
        ...base.state,
        providerState: "queued",
        providerAcceptedAt: null,
      },
    })).toMatchObject({
      tone: "warning",
      title: "Device receipt timed out",
    });
  });

  it("requires an exact delivery ID and canary cause before showing an outcome", () => {
    const value = { ...base, outcome: "timed_out", timedOut: true, state: { ...base.state, id: base.deliveryId, causeKind: "canary", causeId: base.canaryId } };
    expect(readPushCanaryResult(value).outcome).toBe("timed_out");
    expect(() => readPushCanaryResult({ ...value, state: { ...value.state, id: "other-delivery" } })).toThrow("unconfirmed");
    expect(() => readPushCanaryResult({ ...value, state: { ...value.state, causeId: "other-canary" } })).toThrow("unconfirmed");
  });

  it("rejects contradictory delivery claims rather than turning them into success", () => {
    const state = { ...base.state, id: base.deliveryId, causeKind: "canary", causeId: base.canaryId };
    expect(() => readPushCanaryResult({ ...base, outcome: "received", state })).toThrow("unconfirmed");
    expect(() => readPushCanaryResult({ ...base, outcome: "timed_out", timedOut: false, state })).toThrow("unconfirmed");
    expect(() => readPushCanaryResult({ ...base, outcome: "provider_failed", state })).toThrow("unconfirmed");
    expect(readPushCanaryResult({ ...base, outcome: "received", state: { ...state, appState: "received", receivedAt: "2026-09-18T10:00:01.000Z" } }).outcome).toBe("received");
  });

  it("distinguishes successful empty target reads from malformed/unavailable reads", () => {
    const value = { schemaVersion: 1, registrations: [], providers: { apns: "configured", fcm: "configuration_required" } };
    expect(readPushTargets(value).registrations).toEqual([]);
    expect(() => readPushTargets({ ...value, registrations: undefined })).toThrow("incomplete");
    expect(() => readPushTargets({ ...value, providers: { apns: ["configured"], fcm: "configured" } })).toThrow("incomplete");
  });
});
