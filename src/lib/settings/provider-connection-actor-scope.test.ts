import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { providerConnectionActorReadOrder } from "@/lib/settings/provider-connection-actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "provider-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("provider connection actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(providerConnectionActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact actor for absent or malformed bindings", () => {
    expect(providerConnectionActorReadOrder(actorId)).toEqual([actorId, actorId]);
    expect(providerConnectionActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    })).toEqual([actorId, actorId]);
    expect(providerConnectionActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-a-user-id",
      canonicalActorId: "actor:not-a-user-id",
    })).toEqual([actorId, actorId]);
  });

  it("honors the authenticated actor length and whitespace contract", () => {
    const maximumActorId = "a".repeat(320);
    expect(providerConnectionActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(321);
    expect(providerConnectionActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    })).toEqual([oversizedActorId, oversizedActorId]);
    expect(providerConnectionActorReadOrder(` ${actorId} `, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([` ${actorId} `]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        ` ${actorId} `,
      ]),
    })).toEqual([` ${actorId} `, ` ${actorId} `]);
  });
});
