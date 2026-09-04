import { describe, expect, it } from "vitest";
import { captureActorReadOrder } from "@/lib/capture/actor-scope";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "capture-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("Capture actor read scope", () => {
  it("returns the validated canonical and current-email tuple", () => {
    expect(captureActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact stored actor for missing or malformed bindings", () => {
    expect(captureActorReadOrder(actorId, undefined, "stored-owner")).toEqual([
      "stored-owner",
      "stored-owner",
    ]);
    expect(captureActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(captureActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-an-auth-user-id",
      canonicalActorId: "actor:not-an-auth-user-id",
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
  });

  it("honors the Capture 256-character actor contract", () => {
    const maximumActorId = "a".repeat(256);
    expect(captureActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(257);
    expect(captureActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);

    const maximumUtf16ActorId = "😀".repeat(128);
    expect(captureActorReadOrder(maximumUtf16ActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumUtf16ActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumUtf16ActorId,
      ]),
    })).toEqual([canonicalActorId, maximumUtf16ActorId]);
    const oversizedUtf16ActorId = `${maximumUtf16ActorId}😀`;
    expect(captureActorReadOrder(oversizedUtf16ActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedUtf16ActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedUtf16ActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);

    expect(captureActorReadOrder("", {
      ...binding,
      legacyOwnerActorIds: Object.freeze([""]),
      readableOwnerActorIds: Object.freeze([canonicalActorId, ""]),
    }, "anonymous")).toEqual(["anonymous", "anonymous"]);
    expect(captureActorReadOrder(` ${actorId} `, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([` ${actorId} `]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        ` ${actorId} `,
      ]),
    }, actorId)).toEqual([actorId, actorId]);
  });
});
