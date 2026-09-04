import { describe, expect, it } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { mcpExportConfigurationActorReadOrder } from "@/lib/settings/mcp-export-actor-scope";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "mcp-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

describe("MCP export configuration actor read scope", () => {
  it("returns the validated canonical/current-email tuple", () => {
    expect(mcpExportConfigurationActorReadOrder(actorId, binding)).toEqual([
      canonicalActorId,
      actorId,
    ]);
  });

  it("falls back only to the exact request actor", () => {
    expect(mcpExportConfigurationActorReadOrder(actorId)).toEqual([
      actorId,
      actorId,
    ]);
    expect(mcpExportConfigurationActorReadOrder(actorId, {
      ...binding,
      readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
    })).toEqual([actorId, actorId]);
    expect(mcpExportConfigurationActorReadOrder(actorId, {
      ...binding,
      authUserId: "not-a-user-id",
      canonicalActorId: "actor:not-a-user-id",
    })).toEqual([actorId, actorId]);
    expect(mcpExportConfigurationActorReadOrder(actorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze(["prior-owner@example.test"]),
    })).toEqual([actorId, actorId]);
  });

  it("honors the authenticated actor length and whitespace contract", () => {
    const maximumActorId = "a".repeat(320);
    expect(mcpExportConfigurationActorReadOrder(maximumActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([maximumActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        maximumActorId,
      ]),
    })).toEqual([canonicalActorId, maximumActorId]);

    const oversizedActorId = "a".repeat(321);
    expect(mcpExportConfigurationActorReadOrder(oversizedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([oversizedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        oversizedActorId,
      ]),
    })).toEqual([oversizedActorId, oversizedActorId]);

    const paddedActorId = ` ${actorId} `;
    expect(mcpExportConfigurationActorReadOrder(paddedActorId, {
      ...binding,
      legacyOwnerActorIds: Object.freeze([paddedActorId]),
      readableOwnerActorIds: Object.freeze([
        canonicalActorId,
        paddedActorId,
      ]),
    })).toEqual([paddedActorId, paddedActorId]);
  });
});
