import { describe, expect, it } from "vitest";

import {
  ASAEL_ONTOLOGY_VERSION_ID,
  asaelOntologyV1,
  entityTypeIdSchema,
  getEntityTypeDefinition,
  parseOntologyRegistry,
} from "@/lib/entities/ontology";

describe("Asael ontology registry", () => {
  it("registers every master-plan entity with mandatory policy and lineage fields", () => {
    expect(asaelOntologyV1.entityTypes.map((definition) => definition.typeId))
      .toEqual(entityTypeIdSchema.options);
    expect(asaelOntologyV1.entityTypes).toHaveLength(17);
    expect(asaelOntologyV1.relationTypes).toHaveLength(13);
    expect(asaelOntologyV1.entityTypes.every((definition) =>
      definition.scope === "required" &&
      definition.sensitivity === "required" &&
      definition.allowedPurposeIds === "required" &&
      definition.lineage === "required"
    )).toBe(true);
    expect(asaelOntologyV1.relationTypes.every((definition) =>
      definition.scope === "required" &&
      definition.sensitivity === "required" &&
      definition.allowedPurposeIds === "required" &&
      definition.lineage === "required"
    )).toBe(true);
  });

  it("pins lookups to the exact historical ontology version", () => {
    expect(getEntityTypeDefinition(ASAEL_ONTOLOGY_VERSION_ID, "person"))
      .toMatchObject({ typeId: "person", label: "Person" });
    expect(() => getEntityTypeDefinition("asael-ontology:2", "person"))
      .toThrow("unsupported ontology version");
  });

  it("rejects registry tampering without rewriting the pinned version", () => {
    expect(parseOntologyRegistry(asaelOntologyV1)).toEqual(asaelOntologyV1);
    expect(() => parseOntologyRegistry({
      ...asaelOntologyV1,
      status: "retired",
    })).toThrow();
    expect(() => parseOntologyRegistry({
      ...asaelOntologyV1,
      entityTypes: asaelOntologyV1.entityTypes.map((definition) =>
        definition.typeId === "person"
          ? { ...definition, label: "Contact" }
          : definition
      ),
    })).toThrow("digest");
  });
});
