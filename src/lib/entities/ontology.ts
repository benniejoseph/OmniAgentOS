import { z } from "zod";

import { sourceContractSha256 } from "@/lib/sources/contracts";

export const ASAEL_ONTOLOGY_SCHEMA_VERSION = 1 as const;
export const ASAEL_ONTOLOGY_VERSION_ID = "asael-ontology:1" as const;
export const ASAEL_ONTOLOGY_EFFECTIVE_AT =
  "2026-09-06T00:00:00.000Z" as const;

export const entityTypeIdSchema = z.enum([
  "person",
  "organization",
  "account",
  "project",
  "work_item",
  "event",
  "meeting",
  "place",
  "asset",
  "decision",
  "commitment",
  "preference",
  "risk",
  "goal",
  "product",
  "case",
  "opportunity",
]);

export const entityRelationTypeIdSchema = z.enum([
  "affiliated_with",
  "belongs_to",
  "assigned_to",
  "attends",
  "located_at",
  "references",
  "decides",
  "commits_to",
  "prefers",
  "introduces_risk_to",
  "targets",
  "produces",
  "related_to",
]);

const ontologyIdSchema = z.string().trim().min(1).max(120).regex(
  /^[a-z][a-z0-9_.:-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const entityTypeDefinitionSchema = z.object({
  typeId: entityTypeIdSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  scope: z.literal("required"),
  sensitivity: z.literal("required"),
  allowedPurposeIds: z.literal("required"),
  lineage: z.literal("required"),
  temporalClaims: z.enum(["supported", "required"]),
}).strict();

const entityRelationDefinitionSchema = z.object({
  relationTypeId: entityRelationTypeIdSchema,
  label: z.string().trim().min(1).max(80),
  sourceTypeIds: z.array(entityTypeIdSchema).min(1).max(17),
  targetTypeIds: z.array(entityTypeIdSchema).min(1).max(17),
  direction: z.enum(["directed", "symmetric"]),
  temporalClaims: z.enum(["supported", "required"]),
  scope: z.literal("required"),
  sensitivity: z.literal("required"),
  allowedPurposeIds: z.literal("required"),
  lineage: z.literal("required"),
}).strict();

const ontologyRegistryBodySchema = z.object({
  schemaVersion: z.literal(ASAEL_ONTOLOGY_SCHEMA_VERSION),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  previousOntologyVersionId: ontologyIdSchema.nullable(),
  status: z.literal("active"),
  effectiveAt: z.literal(ASAEL_ONTOLOGY_EFFECTIVE_AT),
  compatibility: z.literal("historical_records_remain_pinned"),
  entityTypes: z.array(entityTypeDefinitionSchema).length(17),
  relationTypes: z.array(entityRelationDefinitionSchema).length(13),
}).strict();

export const ontologyRegistrySchema = ontologyRegistryBodySchema.extend({
  ontologySha256: sha256Schema,
}).strict();

export type EntityTypeId = z.infer<typeof entityTypeIdSchema>;
export type EntityRelationTypeId = z.infer<
  typeof entityRelationTypeIdSchema
>;
export type OntologyRegistry = z.infer<typeof ontologyRegistrySchema>;

const everyEntityType = entityTypeIdSchema.options;
const workTypes: EntityTypeId[] = [
  "account",
  "project",
  "work_item",
  "event",
  "meeting",
  "asset",
  "decision",
  "commitment",
  "risk",
  "goal",
  "product",
  "case",
  "opportunity",
];

const entityTypes: OntologyRegistry["entityTypes"] = [
  entity("person", "Person", "A human identity within one actor-owned scope."),
  entity("organization", "Organization", "A company, institution, team, or other organized group."),
  entity("account", "Account", "A governed customer or business account."),
  entity("project", "Project", "A bounded body of work with an explicit owner and scope."),
  entity("work_item", "Work item", "A task, issue, deliverable, or other actionable unit.", "required"),
  entity("event", "Event", "A time-bounded occurrence from a canonical source.", "required"),
  entity("meeting", "Meeting", "A scheduled or observed meeting with participant lineage.", "required"),
  entity("place", "Place", "A physical or virtual location."),
  entity("asset", "Asset", "A versioned file, recording, image, or other durable artifact."),
  entity("decision", "Decision", "A decision claim tied to exact evidence and validity time.", "required"),
  entity("commitment", "Commitment", "A promised action with owner, target, and due-time semantics.", "required"),
  entity("preference", "Preference", "A scoped preference claim that can change over time.", "required"),
  entity("risk", "Risk", "A scoped risk claim with evidence and lifecycle."),
  entity("goal", "Goal", "A desired outcome with owner and measurable target."),
  entity("product", "Product", "A product, service, or governed offering."),
  entity("case", "Case", "A support, success, legal, or operational case."),
  entity("opportunity", "Opportunity", "A potential commercial or strategic outcome."),
];

const relationTypes: OntologyRegistry["relationTypes"] = [
  relation("affiliated_with", "Affiliated with", ["person", "organization"], ["organization", "account"], "directed", "required"),
  relation("belongs_to", "Belongs to", workTypes, ["organization", "account", "project"], "directed"),
  relation("assigned_to", "Assigned to", ["work_item", "case", "opportunity", "commitment"], ["person", "organization"], "directed", "required"),
  relation("attends", "Attends", ["person", "organization"], ["meeting", "event"], "directed", "required"),
  relation("located_at", "Located at", ["person", "organization", "event", "meeting", "asset"], ["place"], "directed"),
  relation("references", "References", everyEntityType, ["asset", "decision", "commitment"], "directed"),
  relation("decides", "Decides", ["person", "organization", "meeting"], ["decision"], "directed", "required"),
  relation("commits_to", "Commits to", ["person", "organization"], ["commitment", "goal", "work_item"], "directed", "required"),
  relation("prefers", "Prefers", ["person", "organization"], ["preference", "product", "place"], "directed", "required"),
  relation("introduces_risk_to", "Introduces risk to", ["risk"], workTypes, "directed", "required"),
  relation("targets", "Targets", ["goal", "opportunity", "work_item"], workTypes, "directed", "required"),
  relation("produces", "Produces", ["person", "organization", "project", "work_item", "event", "meeting"], ["asset", "decision", "commitment"], "directed", "required"),
  relation("related_to", "Related to", everyEntityType, everyEntityType, "symmetric"),
];

const ontologyBody = ontologyRegistryBodySchema.parse({
  schemaVersion: ASAEL_ONTOLOGY_SCHEMA_VERSION,
  ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
  previousOntologyVersionId: null,
  status: "active",
  effectiveAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  compatibility: "historical_records_remain_pinned",
  entityTypes,
  relationTypes,
});

export const asaelOntologyV1: OntologyRegistry = deepFreeze(
  ontologyRegistrySchema.parse({
    ...ontologyBody,
    ontologySha256: sourceContractSha256(ontologyBody),
  }),
);

export function parseOntologyRegistry(value: unknown): OntologyRegistry {
  const registry = ontologyRegistrySchema.parse(value);
  const { ontologySha256, ...body } = registry;
  if (sourceContractSha256(body) !== ontologySha256) {
    throw new Error("Ontology registry digest is invalid.");
  }
  assertUniqueDefinitions(registry);
  return deepFreeze(registry);
}

export function getEntityTypeDefinition(
  ontologyVersionId: string,
  entityTypeId: EntityTypeId,
) {
  if (ontologyVersionId !== asaelOntologyV1.ontologyVersionId) {
    throw new Error("Entity record references an unsupported ontology version.");
  }
  const definition = asaelOntologyV1.entityTypes.find(
    (candidate) => candidate.typeId === entityTypeId,
  );
  if (!definition) throw new Error("Entity type is not registered.");
  return definition;
}

function entity(
  typeId: EntityTypeId,
  label: string,
  description: string,
  temporalClaims: "supported" | "required" = "supported",
): OntologyRegistry["entityTypes"][number] {
  return {
    typeId,
    label,
    description,
    scope: "required",
    sensitivity: "required",
    allowedPurposeIds: "required",
    lineage: "required",
    temporalClaims,
  };
}

function relation(
  relationTypeId: EntityRelationTypeId,
  label: string,
  sourceTypeIds: EntityTypeId[],
  targetTypeIds: EntityTypeId[],
  direction: "directed" | "symmetric",
  temporalClaims: "supported" | "required" = "supported",
): OntologyRegistry["relationTypes"][number] {
  return {
    relationTypeId,
    label,
    sourceTypeIds: uniqueSorted(sourceTypeIds),
    targetTypeIds: uniqueSorted(targetTypeIds),
    direction,
    temporalClaims,
    scope: "required",
    sensitivity: "required",
    allowedPurposeIds: "required",
    lineage: "required",
  };
}

function assertUniqueDefinitions(registry: OntologyRegistry) {
  if (
    new Set(registry.entityTypes.map((definition) => definition.typeId)).size !==
      registry.entityTypes.length ||
    new Set(registry.relationTypes.map((definition) => definition.relationTypeId)).size !==
      registry.relationTypes.length
  ) {
    throw new Error("Ontology registry contains duplicate definitions.");
  }
}

function uniqueSorted<T extends string>(values: readonly T[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
