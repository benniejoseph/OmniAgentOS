import { describe, expect, it } from "vitest";
import {
  assertOfflineCaptureOwnerBinding,
  offlineCaptureOwnerSha256,
} from "@/lib/capture/offline-outbox";

describe("offline capture owner binding", () => {
  it("pins the cross-platform owner digest contract", () => {
    expect(offlineCaptureOwnerSha256("tenant-one", "actor:one")).toBe(
      "e805018789977bc2b464705983fc7be9467702e8e0b466dfbe2543bfebbd5fc2",
    );
  });

  it("accepts only the exact tenant and actor for an offline retry key", () => {
    const input = {
      idempotencyKey: "capture-offline-abcdefghijklmnopqrstuvwx",
      correlationId: "capture-offline-abcdefghijklmnopqrstuvwx",
      tenantId: "tenant-one",
      actorId: "actor:one",
    };
    expect(() => assertOfflineCaptureOwnerBinding({
      ...input,
      ownerSha256: offlineCaptureOwnerSha256(input.tenantId, input.actorId),
    })).not.toThrow();
    expect(() => assertOfflineCaptureOwnerBinding({
      ...input,
      tenantId: "tenant-two",
      ownerSha256: offlineCaptureOwnerSha256(input.tenantId, input.actorId),
    })).toThrow(/owner binding/i);
  });

  it("leaves ordinary web capture keys unchanged", () => {
    expect(() => assertOfflineCaptureOwnerBinding({
      idempotencyKey: "web-capture-one",
      tenantId: "tenant-one",
      actorId: "actor:one",
    })).not.toThrow();
  });

  it("requires the stable retry key to bind the asset correlation", () => {
    expect(() => assertOfflineCaptureOwnerBinding({
      idempotencyKey: "capture-offline-abcdefghijklmnopqrstuvwx",
      correlationId: "capture-offline-zyxwvutsrqponmlkjihgfedc",
      ownerSha256: offlineCaptureOwnerSha256("tenant-one", "actor:one"),
      tenantId: "tenant-one",
      actorId: "actor:one",
    })).toThrow(/correlation binding/i);
  });
});
