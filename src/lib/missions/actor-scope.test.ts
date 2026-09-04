import { describe, expect, it } from "vitest";
import { missionActorReadOrder } from "@/lib/missions/actor-scope";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "mission-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("Mission actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(missionActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact normalized actor for missing or malformed bindings", () => {
    expect(missionActorReadOrder(actorId, undefined, "stored-owner")).toEqual([
      "stored-owner",
      "stored-owner",
    ]);
    expect(missionActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(missionActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-an-auth-user-id",
      canonicalActorId: "actor:not-an-auth-user-id",
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(missionActorReadOrder(actorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze(["prior-owner@example.test"]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
  });

  it("honors the Mission 200-code-unit actor contract", () => {
    const maximumActorId = "a".repeat(200);
    expect(missionActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(201);
    expect(missionActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);

    const paddedActorId = ` ${actorId} `;
    expect(missionActorReadOrder(paddedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([paddedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        paddedActorId,
      ]),
    }, actorId)).toEqual([actorId, actorId]);
  });
});
