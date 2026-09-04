import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { oauthGrantActorReadOrder } from "@/lib/connectors/oauth-actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "oauth-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("OAuth grant actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(oauthGrantActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact actor for absent or malformed bindings", () => {
    expect(oauthGrantActorReadOrder(actorId)).toEqual([actorId, actorId]);
    expect(oauthGrantActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    })).toEqual([actorId, actorId]);
    expect(oauthGrantActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-a-user-id",
      canonicalActorId: "actor:not-a-user-id",
    })).toEqual([actorId, actorId]);
  });

  it("honors the request actor whitespace and length contract", () => {
    const maximumActorId = "a".repeat(320);
    expect(oauthGrantActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(321);
    expect(oauthGrantActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    })).toEqual([oversizedActorId, oversizedActorId]);

    const paddedActorId = ` ${actorId} `;
    expect(oauthGrantActorReadOrder(paddedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([paddedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        paddedActorId,
      ]),
    })).toEqual([paddedActorId, paddedActorId]);
  });
});
