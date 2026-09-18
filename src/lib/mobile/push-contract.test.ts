import { describe, expect, it } from "vitest";
import {
  createMobilePushEnvelope,
  mobilePushDeepLink,
  mobilePushEnvelopeSchema,
  mobilePushPreview,
  mobilePushReceiptRequestSchema,
} from "@/lib/mobile/push-contract";

describe("mobile push causal contract", () => {
  it.each([
    [{ kind: "approval", id: "approval/one" }, "/inbox/approvals/approval%2Fone"],
    [{ kind: "work_item", id: "task/one", parentId: "project one" }, "/projects/project%20one?workItemId=task%2Fone"],
    [{ kind: "work_item", id: "today/one" }, "/today?workItemId=today%2Fone"],
    [{ kind: "meeting", id: "meeting/one" }, "/meetings/meeting%2Fone"],
    [{ kind: "customer", id: "account/one" }, "/customers/account%2Fone"],
    [{ kind: "run", id: "run/one" }, "/results/agent%3Arun%2Fone"],
    [{ kind: "canary", id: "canary/one" }, "/settings?pushCanary=canary%2Fone"],
  ] as const)("builds an exact allowlisted deep link", (target, expected) => {
    expect(mobilePushDeepLink(target)).toBe(expected);
  });

  it("keeps sensitive titles out of hidden and generic previews", () => {
    const target = { kind: "approval", id: "approval-one" } as const;
    expect(mobilePushPreview("hidden", target, "Secret acquisition")).toBeUndefined();
    expect(mobilePushPreview("generic", target, "Secret acquisition")).toEqual({
      title: "Asael",
      body: "An approval needs your attention.",
    });
    expect(mobilePushPreview("title", target, "Secret acquisition")).toEqual({
      title: "Asael",
      body: "Secret acquisition",
    });
  });

  it("rejects parent scope on a non-work-item envelope", () => {
    const envelope = createMobilePushEnvelope({
      deliveryId: "delivery-one",
      target: { kind: "meeting", id: "meeting-one" },
    });
    expect(envelope.deepLink).toBe("/meetings/meeting-one");
    expect(mobilePushEnvelopeSchema.safeParse({
      ...envelope,
      parentId: "not-allowed",
    }).success).toBe(false);
  });

  it("requires typed lifecycle evidence and an action only for action receipts", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "received",
      observedAt: "2026-09-18T12:00:00.000+05:30",
      appLifecycle: "background",
    } as const;
    expect(mobilePushReceiptRequestSchema.safeParse(receipt).success).toBe(true);
    expect(mobilePushReceiptRequestSchema.safeParse({
      ...receipt,
      action: "open",
    }).success).toBe(false);
    expect(mobilePushReceiptRequestSchema.safeParse({
      ...receipt,
      kind: "action",
      action: "complete",
    }).success).toBe(true);
    expect(mobilePushReceiptRequestSchema.safeParse({
      ...receipt,
      kind: "action",
    }).success).toBe(false);
  });
});
