import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { modelAssignmentActorReadOrder } from "@/lib/settings/model-assignment-actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "assignment-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("model assignment actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(modelAssignmentActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back only to the exact request actor", () => {
    expect(modelAssignmentActorReadOrder(actorId)).toEqual([actorId, actorId]);
    expect(modelAssignmentActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    })).toEqual([actorId, actorId]);
    expect(modelAssignmentActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-a-user-id",
      canonicalActorId: "actor:not-a-user-id",
    })).toEqual([actorId, actorId]);
    expect(modelAssignmentActorReadOrder(actorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze(["prior-owner@example.test"]),
    })).toEqual([actorId, actorId]);
  });

  it("honors the authenticated actor length and whitespace contract", () => {
    const maximumActorId = "a".repeat(320);
    expect(modelAssignmentActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(321);
    expect(modelAssignmentActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    })).toEqual([oversizedActorId, oversizedActorId]);
    expect(modelAssignmentActorReadOrder(` ${actorId} `, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([` ${actorId} `]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        ` ${actorId} `,
      ]),
    })).toEqual([` ${actorId} `, ` ${actorId} `]);
  });
});
