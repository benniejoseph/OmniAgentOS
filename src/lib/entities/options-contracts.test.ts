import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENTITY_OPTIONS_CONTRACT, entityOptionSchema, entityOptionsQuerySchema, entityOptionsResponseSchema } from "./options-contracts";

const option = { entityId: "entity:a", entityTypeId: "person", canonicalLabel: "A full source label", state: "active" };
function page() {
  return { schemaVersion: 1, contract: ENTITY_OPTIONS_CONTRACT,
    scope: { tenantId: "tenant-a", ownerActorId: "actor:11111111-1111-4111-8111-111111111111", accessScopeSha256: "a".repeat(64), purposeId: "entity.read.v1" },
    items: [option], hasMore: true, nextAfter: option.entityId,
    coverage: { kind: "bounded_current", limit: 1, returned: 1, after: null, total: null }, authorityEffect: "none" };
}

describe("bounded current Entity option contracts", () => {
  it("requires bounded integer windows and an exact opaque ID cursor", () => {
    expect(entityOptionsQuerySchema.parse({})).toEqual({ limit: 40 });
    for (const value of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "10" }, { after: " entity:a " }, { after: "" }, { tenantId: "foreign" }]) {
      expect(entityOptionsQuerySchema.safeParse(value).success).toBe(false);
    }
    expect(entityOptionsQuerySchema.parse({ limit: 100, after: "entity:a/+" })).toEqual({ limit: 100, after: "entity:a/+" });
  });
  it("preserves all 320 label characters and accepts only the four active relationship types", () => {
    for (const entityTypeId of ["person", "organization", "account", "project"]) {
      expect(entityOptionSchema.parse({ ...option, entityTypeId, canonicalLabel: "x".repeat(320) }).canonicalLabel).toHaveLength(320);
    }
    for (const value of [{ ...option, state: "merged" }, { ...option, entityTypeId: "meeting" },
      { ...option, canonicalLabel: "x".repeat(321) }, { ...option, lineage: [] }]) expect(entityOptionSchema.safeParse(value).success).toBe(false);
  });
  it("requires a full page before claiming another page and binds its last exact ID", () => {
    expect(entityOptionsResponseSchema.safeParse(page()).success).toBe(true);
    expect(entityOptionsResponseSchema.safeParse({ ...page(), nextAfter: "entity:b" }).success).toBe(false);
    expect(entityOptionsResponseSchema.safeParse({ ...page(), coverage: { ...page().coverage, limit: 2 } }).success).toBe(false);
    expect(entityOptionsResponseSchema.safeParse({ ...page(), coverage: { ...page().coverage, returned: 0 } }).success).toBe(false);
  });
  it("does not manufacture a total or mutation authority", () => {
    expect(entityOptionsResponseSchema.safeParse({ ...page(), coverage: { ...page().coverage, total: 1 } }).success).toBe(false);
    expect(entityOptionsResponseSchema.safeParse({ ...page(), authorityEffect: "write" }).success).toBe(false);
    expect(entityOptionsResponseSchema.safeParse({ ...page(), scope: { ...page().scope, ownerActorId: "owner@example.test" } }).success).toBe(false);
  });
  it("rejects duplicate, descending or pre-cursor options", () => {
    for (const items of [[option, option], [{ ...option, entityId: "entity:b" }, option]]) {
      expect(entityOptionsResponseSchema.safeParse({ ...page(), items, hasMore: false, nextAfter: null,
        coverage: { ...page().coverage, returned: 2, limit: 2 } }).success).toBe(false);
    }
    expect(entityOptionsResponseSchema.safeParse({ ...page(), coverage: { ...page().coverage, after: "entity:a" } }).success).toBe(false);
  });
  it("represents empty current results with no continuation", () => {
    expect(entityOptionsResponseSchema.safeParse({ ...page(), items: [], hasMore: false, nextAfter: null,
      coverage: { ...page().coverage, returned: 0 } }).success).toBe(true);
  });
  it("exports strict structural schemas without a storage dependency", () => {
    for (const schema of [entityOptionsQuerySchema, entityOptionSchema, entityOptionsResponseSchema]) {
      expect(z.toJSONSchema(schema, { target: "draft-2020-12" }).additionalProperties).toBe(false);
    }
  });
});
