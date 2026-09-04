import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { skillActorReadOrder } from "@/lib/skills/actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "skill-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("custom Skill actor read scope", () => {
  it("returns the validated canonical and current-email tuple", () => {
    expect(skillActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact stored actor for missing or malformed bindings", () => {
    expect(skillActorReadOrder(actorId, undefined, "stored-owner")).toEqual([
      "stored-owner",
      "stored-owner",
    ]);
    expect(skillActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(skillActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-an-auth-user-id",
      canonicalActorId: "actor:not-an-auth-user-id",
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(skillActorReadOrder(` ${actorId} `, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([` ${actorId} `]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        ` ${actorId} `,
      ]),
    }, actorId)).toEqual([actorId, actorId]);
  });

  it("uses the store's 200 UTF-16-unit actor contract", () => {
    const maximumActorId = "a".repeat(200);
    expect(skillActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(201);
    expect(skillActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);

    const maximumUtf16ActorId = "😀".repeat(100);
    expect(skillActorReadOrder(maximumUtf16ActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumUtf16ActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumUtf16ActorId,
      ]),
    })).toEqual([canonicalActorId, maximumUtf16ActorId]);
    const oversizedUtf16ActorId = `${maximumUtf16ActorId}😀`;
    expect(skillActorReadOrder(oversizedUtf16ActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedUtf16ActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedUtf16ActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
  });
});
