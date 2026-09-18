import { describe, expect, it } from "vitest";
import { pushCanaryOutcomeCopy } from "@/components/settings/push-canary-panel";

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
});
