import { describe, expect, it } from "vitest";
import { serviceApiKeyActorReadOrder } from "@/lib/settings/service-api-key-actor-scope";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "settings-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("service API key actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(serviceApiKeyActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact actor for absent or malformed bindings", () => {
    expect(serviceApiKeyActorReadOrder(actorId, undefined)).toEqual([
      actorId,
      actorId,
    ]);
    expect(serviceApiKeyActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
    expect(serviceApiKeyActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-a-user-id",
      canonicalActorId: "actor:not-a-user-id",
    })).toEqual([actorId, actorId]);
  });

  it("honors the authenticated actor length and whitespace contract", () => {
    const maximumActorId = "a".repeat(320);
    expect(serviceApiKeyActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(321);
    expect(serviceApiKeyActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    })).toEqual([oversizedActorId, oversizedActorId]);
    expect(serviceApiKeyActorReadOrder(` ${actorId} `, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([` ${actorId} `]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        ` ${actorId} `,
      ]),
    }, actorId)).toEqual([actorId, actorId]);
  });
});
