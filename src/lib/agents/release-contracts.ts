import { z } from "zod";

import {
  parseAgentDefinitionV1,
  type AgentDefinitionV1,
} from "@/lib/agents/identity-contracts";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const AGENT_RELEASE_SCHEMA_VERSION = 1 as const;
export const AGENT_RELEASE_EVALUATION_VERSION =
  "p7.5-agent-release-evaluation:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const agentReleaseChangedFieldSchema = z.enum([
  "slug",
  "name",
  "role",
  "description",
  "instructions",
  "persona",
  "status",
  "accent",
  "model_policy",
  "skills",
]);

const agentReleaseEvaluationBodySchema = z.object({
  schemaVersion: z.literal(AGENT_RELEASE_SCHEMA_VERSION),
  version: z.literal(AGENT_RELEASE_EVALUATION_VERSION),
  evaluationId: idSchema,
  agentId: idSchema,
  definitionId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionVersionId: idSchema,
  definitionSha256: sha256Schema,
  baselineDefinitionVersion: positiveVersionSchema,
  baselineDefinitionVersionId: idSchema,
  baselineDefinitionSha256: sha256Schema,
  policyVersionId: z.literal("agent-release-policy:1"),
  direction: z.enum(["promotion", "rollback"]),
  changedFields: z.array(agentReleaseChangedFieldSchema).min(1).max(10),
  checks: z.object({
    exactOwnerBinding: z.literal(true),
    versionTransition: z.literal(true),
    immutableDefinitionDigest: z.literal(true),
    personaContract: z.literal(true),
    skillPins: z.literal(true),
    authorityExcluded: z.literal(true),
    materialChange: z.literal(true),
  }).strict(),
  verdict: z.literal("passed"),
  evaluatedAt: timestampSchema,
}).strict();

export const agentReleaseEvaluationV1Schema =
  agentReleaseEvaluationBodySchema.extend({
    evaluationSha256: sha256Schema,
  }).strict();

export const agentReleaseChannelV1Schema = z.object({
  schemaVersion: z.literal(AGENT_RELEASE_SCHEMA_VERSION),
  agentId: idSchema,
  state: z.enum(["active", "retired"]),
  releaseRevision: positiveVersionSchema,
  activeDefinitionVersion: positiveVersionSchema,
  activeDefinitionVersionId: idSchema,
  previousDefinitionVersion: positiveVersionSchema.nullable(),
  previousDefinitionVersionId: idSchema.nullable(),
  latestDefinitionVersion: positiveVersionSchema,
  latestDefinitionVersionId: idSchema,
  candidateEvaluation: agentReleaseEvaluationV1Schema.nullable(),
  updatedAt: timestampSchema,
  retiredAt: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.activeDefinitionVersionId !==
      `definition:custom:${value.agentId}:v${value.activeDefinitionVersion}` ||
    value.latestDefinitionVersionId !==
      `definition:custom:${value.agentId}:v${value.latestDefinitionVersion}` ||
    (value.previousDefinitionVersion === null) !==
      (value.previousDefinitionVersionId === null) ||
    (value.previousDefinitionVersion !== null &&
      value.previousDefinitionVersionId !==
        `definition:custom:${value.agentId}:v${value.previousDefinitionVersion}`)
  ) {
    context.addIssue({
      code: "custom",
      message: "Agent release channel version identity is inconsistent.",
    });
  }
  if (value.latestDefinitionVersion < value.activeDefinitionVersion) {
    context.addIssue({
      code: "custom",
      path: ["latestDefinitionVersion"],
      message: "The latest definition cannot precede the active release.",
    });
  }
  if ((value.state === "retired") !== (value.retiredAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["retiredAt"],
      message: "Only a retired release channel has a retirement time.",
    });
  }
});

export type AgentReleaseChangedField = z.infer<
  typeof agentReleaseChangedFieldSchema
>;
export type AgentReleaseEvaluationV1 = Readonly<
  z.infer<typeof agentReleaseEvaluationV1Schema>
>;
export type AgentReleaseChannelV1 = Readonly<
  z.infer<typeof agentReleaseChannelV1Schema>
>;

export function evaluateAgentReleaseCandidateV1(input: {
  candidate: AgentDefinitionV1;
  baseline: AgentDefinitionV1;
  evaluatedAt?: string;
}): AgentReleaseEvaluationV1 {
  const candidate = parseAgentDefinitionV1(input.candidate);
  const baseline = parseAgentDefinitionV1(input.baseline);
  if (
    candidate.origin !== "custom" ||
    baseline.origin !== "custom" ||
    candidate.tenantId !== baseline.tenantId ||
    candidate.ownerActorId !== baseline.ownerActorId ||
    candidate.logicalAgentId !== baseline.logicalAgentId ||
    candidate.definitionId !== baseline.definitionId
  ) {
    throw new Error("Agent release evaluation requires one exact owner binding.");
  }
  if (candidate.definitionVersion === baseline.definitionVersion) {
    throw new Error("Agent release candidates must change the active version.");
  }
  const changedFields = releaseChangedFields(baseline, candidate);
  if (!changedFields.length) {
    throw new Error("Agent release candidates require a material behavior change.");
  }
  const evaluatedAt = canonicalTimestamp(input.evaluatedAt || Date.now());
  const direction = candidate.definitionVersion > baseline.definitionVersion
    ? "promotion"
    : "rollback";
  const evaluationCoordinates = {
    agentId: candidate.logicalAgentId,
    definitionVersionId: candidate.definitionVersionId,
    definitionSha256: candidate.definitionSha256,
    baselineDefinitionVersionId: baseline.definitionVersionId,
    baselineDefinitionSha256: baseline.definitionSha256,
    policyVersionId: "agent-release-policy:1",
    direction,
  };
  const evaluationId = `agent-release-evaluation:${sourceContractSha256(
    evaluationCoordinates,
  )}`;
  const body = agentReleaseEvaluationBodySchema.parse({
    schemaVersion: AGENT_RELEASE_SCHEMA_VERSION,
    version: AGENT_RELEASE_EVALUATION_VERSION,
    evaluationId,
    agentId: candidate.logicalAgentId,
    definitionId: candidate.definitionId,
    definitionVersion: candidate.definitionVersion,
    definitionVersionId: candidate.definitionVersionId,
    definitionSha256: candidate.definitionSha256,
    baselineDefinitionVersion: baseline.definitionVersion,
    baselineDefinitionVersionId: baseline.definitionVersionId,
    baselineDefinitionSha256: baseline.definitionSha256,
    policyVersionId: "agent-release-policy:1",
    direction,
    changedFields,
    checks: {
      exactOwnerBinding: true,
      versionTransition: true,
      immutableDefinitionDigest: true,
      personaContract: true,
      skillPins: true,
      authorityExcluded: true,
      materialChange: true,
    },
    verdict: "passed",
    evaluatedAt,
  });
  return parseAgentReleaseEvaluationV1({
    ...body,
    evaluationSha256: sourceContractSha256(body),
  });
}

export function parseAgentReleaseEvaluationV1(
  value: unknown,
): AgentReleaseEvaluationV1 {
  const parsed = agentReleaseEvaluationV1Schema.parse(value);
  const { evaluationSha256, ...body } = parsed;
  if (
    parsed.definitionVersionId !==
      `${parsed.definitionId}:v${parsed.definitionVersion}` ||
    parsed.baselineDefinitionVersionId !==
      `${parsed.definitionId}:v${parsed.baselineDefinitionVersion}` ||
    parsed.definitionVersion === parsed.baselineDefinitionVersion ||
    parsed.direction !== (parsed.definitionVersion >
      parsed.baselineDefinitionVersion ? "promotion" : "rollback") ||
    parsed.evaluationId !== `agent-release-evaluation:${sourceContractSha256({
      agentId: parsed.agentId,
      definitionVersionId: parsed.definitionVersionId,
      definitionSha256: parsed.definitionSha256,
      baselineDefinitionVersionId: parsed.baselineDefinitionVersionId,
      baselineDefinitionSha256: parsed.baselineDefinitionSha256,
      policyVersionId: parsed.policyVersionId,
      direction: parsed.direction,
    })}` ||
    sourceContractSha256(body) !== evaluationSha256
  ) {
    throw new Error("Agent release evaluation integrity is invalid.");
  }
  return deepFreeze(parsed);
}

export function parseAgentReleaseChannelV1(value: unknown) {
  return deepFreeze(agentReleaseChannelV1Schema.parse(value));
}

function releaseChangedFields(
  baseline: AgentDefinitionV1,
  candidate: AgentDefinitionV1,
) {
  const changed: AgentReleaseChangedField[] = [];
  if (baseline.slug !== candidate.slug) changed.push("slug");
  if (baseline.name !== candidate.name) changed.push("name");
  if (baseline.role !== candidate.role) changed.push("role");
  if (baseline.description !== candidate.description) changed.push("description");
  if (baseline.instructions !== candidate.instructions) changed.push("instructions");
  if (sourceContractSha256(baseline.persona) !==
    sourceContractSha256(candidate.persona)) {
    changed.push("persona");
  }
  if (baseline.status !== candidate.status) changed.push("status");
  if (baseline.accent !== candidate.accent) changed.push("accent");
  if (baseline.modelPolicy !== candidate.modelPolicy) {
    changed.push("model_policy");
  }
  if (sourceContractSha256(baseline.declaredSkills) !==
    sourceContractSha256(candidate.declaredSkills)) {
    changed.push("skills");
  }
  return changed;
}

function canonicalTimestamp(value: string | number) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Agent release timestamp is invalid.");
  }
  return parsed.toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
