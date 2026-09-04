import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { projectActorReadOrder } from "@/lib/projects/actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "project-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("project actor read scope", () => {
  it("returns the validated canonical and current-email tuple", () => {
    expect(projectActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back to the exact stored actor without a valid binding", () => {
    expect(projectActorReadOrder(actorId, undefined, "stored-owner")).toEqual([
      "stored-owner",
      "stored-owner",
    ]);
    expect(projectActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
  });

  it("rejects request actors outside the 200-character store contract", () => {
    const oversizedActorId = "a".repeat(201);
    expect(projectActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    }, "stored-owner")).toEqual(["stored-owner", "stored-owner"]);
  });
});
