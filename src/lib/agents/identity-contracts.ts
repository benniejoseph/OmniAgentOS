import { z } from "zod";

import { arsenalAgents, type ArsenalAgent } from "@/lib/agents/arsenal";
import {
  AGENT_PROMPT_CONTRACT_VERSION_ID,
  getBuiltInAgentPromptIdentity,
  isBuiltInPromptAgentId,
  type BuiltInAgentId,
} from "@/lib/orchestration/prompts";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";

export const AGENT_IDENTITY_SCHEMA_VERSION = 1 as const;
export const AGENT_IDENTITY_PIN_VERSION = "p7.1-agent-identity-pin:1" as const;
export const BUILT_IN_AGENT_DEFINITION_VERSION = 1 as const;
export const BUILT_IN_AGENT_PRINCIPAL_GENERATION = 1 as const;
export const BUILT_IN_AGENT_IDENTITY_EFFECTIVE_AT =
  "2026-09-07T00:00:00.000Z" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const uniqueIdsSchema = z.array(idSchema).max(256).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Agent identity IDs must be unique." });
  }
});

const skillPinSchema = z.object({
  skillId: idSchema,
  skillVersion: positiveVersionSchema,
  skillVersionId: idSchema,
  skillSha256: sha256Schema,
}).strict();

const agentDefinitionBodySchema = z.object({
  schemaVersion: z.literal(AGENT_IDENTITY_SCHEMA_VERSION),
  definitionId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionVersionId: idSchema,
  previousDefinitionVersionId: idSchema.nullable(),
  origin: z.enum(["built_in", "custom"]),
  tenantId: idSchema,
  ownerActorId: idSchema,
  logicalAgentId: idSchema,
  slug: idSchema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  instructions: z.string().max(12_000),
  status: z.enum(["ready", "learning", "watching", "paused"]),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]),
  modelPolicy: z.enum([
    "auto",
    "openai_fast",
    "openai_reasoning",
    "gemini_fast",
    "anthropic_fast",
    "anthropic_reasoning",
  ]),
  personaVersionId: idSchema,
  personaSha256: sha256Schema,
  modelPolicyVersionId: idSchema,
  modelPolicySha256: sha256Schema,
  promptContractVersionId: idSchema,
  declaredSkills: z.array(skillPinSchema).max(50),
  publishedAt: timestampSchema,
}).strict();

export const agentDefinitionV1Schema = agentDefinitionBodySchema.extend({
  definitionSha256: sha256Schema,
}).strict();

const agentPrincipalBodySchema = z.object({
  schemaVersion: z.literal(AGENT_IDENTITY_SCHEMA_VERSION),
  principalId: idSchema,
  principalGeneration: positiveVersionSchema,
  principalVersionId: idSchema,
  previousPrincipalVersionId: idSchema.nullable(),
  tenantId: idSchema,
  controllerActorId: idSchema,
  logicalAgentId: idSchema,
  definitionId: idSchema,
  state: z.enum(["held", "active", "revoked"]),
  authorityMode: z.enum(["server_policy", "explicit_grants"]),
  autonomy: z.enum(["assist", "governed", "execute"]),
  approvalPolicy: z.enum(["always", "risk_based", "read_only"]),
  memoryScope: z.enum(["session", "project", "all"]),
  toolGrantIds: uniqueIdsSchema,
  contextGrantIds: uniqueIdsSchema,
  capabilityGrantIds: uniqueIdsSchema,
  budgetPolicyVersionId: idSchema,
  expiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.state === "revoked") !== (value.revokedAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Only a revoked agent principal has a revocation time.",
    });
  }
  if (
    value.authorityMode === "server_policy" &&
    (value.toolGrantIds.length > 0 ||
      value.contextGrantIds.length > 0 ||
      value.capabilityGrantIds.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["authorityMode"],
      message: "Server-policy agent principals cannot imply explicit grants.",
    });
  }
});

export const agentPrincipalDefinitionV1Schema = agentPrincipalBodySchema.extend({
  principalSha256: sha256Schema,
}).strict();

const policyPinSchema = z.object({
  policyId: idSchema,
  policyVersionId: idSchema,
  policySha256: sha256Schema,
}).strict();

const agentRunIdentityPinBodySchema = z.object({
  schemaVersion: z.literal(AGENT_IDENTITY_SCHEMA_VERSION),
  version: z.literal(AGENT_IDENTITY_PIN_VERSION),
  runId: idSchema,
  tenantId: idSchema,
  actorId: idSchema,
  logicalAgentId: idSchema,
  definitionId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionVersionId: idSchema,
  definitionSha256: sha256Schema,
  personaVersionId: idSchema,
  personaSha256: sha256Schema,
  modelPolicyVersionId: idSchema,
  modelPolicySha256: sha256Schema,
  promptContractVersionId: idSchema,
  skillPins: z.array(skillPinSchema).max(50),
  principalId: idSchema,
  principalGeneration: positiveVersionSchema,
  principalVersionId: idSchema,
  principalSha256: sha256Schema,
  policyPins: z.array(policyPinSchema).length(4),
}).strict();

export const agentRunIdentityPinV1Schema = agentRunIdentityPinBodySchema.extend({
  pinSha256: sha256Schema,
}).strict();

export type AgentDefinitionV1 = Readonly<z.infer<typeof agentDefinitionV1Schema>>;
export type AgentPrincipalDefinitionV1 = Readonly<
  z.infer<typeof agentPrincipalDefinitionV1Schema>
>;
export type AgentRunIdentityPinV1 = Readonly<
  z.infer<typeof agentRunIdentityPinV1Schema>
>;
export type ResolvedAgentIdentityV1 = Readonly<{
  definition: AgentDefinitionV1;
  principal: AgentPrincipalDefinitionV1;
}>;

export function buildCustomAgentIdentityV1(input: {
  agent: CustomAgentDefinition;
  skills: readonly AgentSkill[];
  definitionVersion: number;
  previousDefinitionVersionId?: string | null;
  ownerActorId?: string;
  definitionPublishedAt?: string;
  principalId?: string;
  principalGeneration: number;
  previousPrincipalVersionId?: string | null;
  principalState?: "held" | "active" | "revoked";
  principalAuthorityMode?: "server_policy" | "explicit_grants";
  principalContextGrantIds?: readonly string[];
  principalCapabilityGrantIds?: readonly string[];
  principalBudgetPolicyVersionId?: string;
  principalExpiresAt?: string | null;
  principalCreatedAt?: string;
  principalRevokedAt?: string | null;
}) {
  const ownerActorId = input.ownerActorId || input.agent.actorId;
  const definitionId = `definition:custom:${input.agent.id}`;
  const principalId = input.principalId || scopedPrincipalId(
    input.agent.id,
    input.agent.tenantId,
    ownerActorId,
  );
  const definition = buildAgentDefinitionV1({
    definitionId,
    definitionVersion: input.definitionVersion,
    previousDefinitionVersionId: input.previousDefinitionVersionId === undefined
      ? previousVersionId(definitionId, "v", input.definitionVersion)
      : input.previousDefinitionVersionId,
    origin: "custom",
    tenantId: input.agent.tenantId,
    ownerActorId,
    logicalAgentId: input.agent.id,
    slug: input.agent.slug,
    name: input.agent.name,
    role: input.agent.role,
    description: input.agent.description,
    instructions: input.agent.instructions,
    status: input.agent.status,
    accent: input.agent.accent,
    modelPolicy: input.agent.modelPolicy,
    skills: input.skills,
    publishedAt: input.definitionPublishedAt || input.agent.updatedAt,
  });
  const principal = buildAgentPrincipalDefinitionV1({
    principalId,
    principalGeneration: input.principalGeneration,
    previousPrincipalVersionId: input.previousPrincipalVersionId === undefined
      ? previousVersionId(principalId, "g", input.principalGeneration)
      : input.previousPrincipalVersionId,
    tenantId: input.agent.tenantId,
    controllerActorId: ownerActorId,
    logicalAgentId: input.agent.id,
    definitionId: definition.definitionId,
    state: input.principalState || "active",
    authorityMode: input.principalAuthorityMode || "explicit_grants",
    autonomy: input.agent.autonomy,
    approvalPolicy: input.agent.approvalPolicy,
    memoryScope: input.agent.memoryScope,
    toolGrantIds: input.agent.toolIds,
    contextGrantIds: [...(input.principalContextGrantIds || [])],
    capabilityGrantIds: [...(input.principalCapabilityGrantIds || [])],
    budgetPolicyVersionId:
      input.principalBudgetPolicyVersionId || "agent-run-budget:2",
    expiresAt: input.principalExpiresAt || null,
    revokedAt: input.principalRevokedAt || null,
    createdAt: input.principalCreatedAt || input.agent.createdAt,
  });
  return deepFreeze({ definition, principal });
}

export function buildBuiltInAgentIdentityV1(input: {
  agentId: BuiltInAgentId;
  tenantId: string;
  controllerActorId: string;
}) {
  const display = requireBuiltInAgent(input.agentId);
  const prompt = getBuiltInAgentPromptIdentity(input.agentId);
  const definition = buildAgentDefinitionV1({
    definitionId: `definition:built-in:${input.agentId}`,
    definitionVersion: BUILT_IN_AGENT_DEFINITION_VERSION,
    previousDefinitionVersionId: null,
    origin: "built_in",
    tenantId: input.tenantId,
    ownerActorId: input.controllerActorId,
    logicalAgentId: input.agentId,
    slug: input.agentId,
    name: prompt.name,
    role: prompt.role,
    description: prompt.mandate,
    instructions: "",
    status: display.status,
    accent: display.accent,
    modelPolicy: "auto",
    skills: [],
    publishedAt: BUILT_IN_AGENT_IDENTITY_EFFECTIVE_AT,
  });
  const principal = buildAgentPrincipalDefinitionV1({
    principalId: scopedPrincipalId(
      input.agentId,
      input.tenantId,
      input.controllerActorId,
    ),
    principalGeneration: BUILT_IN_AGENT_PRINCIPAL_GENERATION,
    previousPrincipalVersionId: null,
    tenantId: input.tenantId,
    controllerActorId: input.controllerActorId,
    logicalAgentId: input.agentId,
    definitionId: definition.definitionId,
    state: "active",
    authorityMode: "server_policy",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    memoryScope: "all",
    toolGrantIds: [],
    contextGrantIds: [],
    capabilityGrantIds: [],
    budgetPolicyVersionId: "agent-run-budget:2",
    expiresAt: null,
    revokedAt: null,
    createdAt: BUILT_IN_AGENT_IDENTITY_EFFECTIVE_AT,
  });
  return deepFreeze({ definition, principal });
}

export function buildAgentRunIdentityPinV1(input: {
  runId: string;
  identity: ResolvedAgentIdentityV1;
}) {
  const definition = parseAgentDefinitionV1(input.identity.definition);
  const principal = parseAgentPrincipalDefinitionV1(input.identity.principal);
  if (
    definition.tenantId !== principal.tenantId ||
    definition.ownerActorId !== principal.controllerActorId ||
    definition.logicalAgentId !== principal.logicalAgentId ||
    definition.definitionId !== principal.definitionId ||
    principal.state !== "active"
  ) {
    throw new Error("Agent definition and principal identity do not match.");
  }
  const policyPins = [
    policyPin("autonomy", principal.autonomy),
    policyPin("approval", principal.approvalPolicy),
    policyPin("memory-scope", principal.memoryScope),
    policyPin("budget", principal.budgetPolicyVersionId),
  ];
  const body = agentRunIdentityPinBodySchema.parse({
    schemaVersion: AGENT_IDENTITY_SCHEMA_VERSION,
    version: AGENT_IDENTITY_PIN_VERSION,
    runId: input.runId,
    tenantId: definition.tenantId,
    actorId: definition.ownerActorId,
    logicalAgentId: definition.logicalAgentId,
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    definitionVersionId: definition.definitionVersionId,
    definitionSha256: definition.definitionSha256,
    personaVersionId: definition.personaVersionId,
    personaSha256: definition.personaSha256,
    modelPolicyVersionId: definition.modelPolicyVersionId,
    modelPolicySha256: definition.modelPolicySha256,
    promptContractVersionId: definition.promptContractVersionId,
    skillPins: definition.declaredSkills,
    principalId: principal.principalId,
    principalGeneration: principal.principalGeneration,
    principalVersionId: principal.principalVersionId,
    principalSha256: principal.principalSha256,
    policyPins,
  });
  return parseAgentRunIdentityPinV1({
    ...body,
    pinSha256: sourceContractSha256(body),
  });
}

export function parseAgentDefinitionV1(value: unknown): AgentDefinitionV1 {
  const parsed = agentDefinitionV1Schema.parse(value);
  const { definitionSha256, ...body } = parsed;
  const expectedVersionId = `${parsed.definitionId}:v${parsed.definitionVersion}`;
  const expectedPreviousVersionId = parsed.definitionVersion === 1
    ? null
    : `${parsed.definitionId}:v${parsed.definitionVersion - 1}`;
  if (
    parsed.definitionVersionId !== expectedVersionId ||
    parsed.previousDefinitionVersionId !== expectedPreviousVersionId ||
    parsed.personaVersionId !== `${expectedVersionId}:persona` ||
    parsed.modelPolicyVersionId !== `${expectedVersionId}:model-policy` ||
    parsed.promptContractVersionId !== AGENT_PROMPT_CONTRACT_VERSION_ID
  ) {
    throw new Error("Agent definition version identity is invalid.");
  }
  if (sourceContractSha256(personaBody(parsed)) !== parsed.personaSha256) {
    throw new Error("Agent persona digest is invalid.");
  }
  if (sourceContractSha256(modelPolicyBody(parsed)) !== parsed.modelPolicySha256) {
    throw new Error("Agent model-policy digest is invalid.");
  }
  for (const skill of parsed.declaredSkills) parseSkillPin(skill);
  if (sourceContractSha256(body) !== definitionSha256) {
    throw new Error("Agent definition digest is invalid.");
  }
  return deepFreeze(parsed);
}

export function parseAgentPrincipalDefinitionV1(
  value: unknown,
): AgentPrincipalDefinitionV1 {
  const parsed = agentPrincipalDefinitionV1Schema.parse(value);
  const { principalSha256 } = parsed;
  const expectedVersionId = `${parsed.principalId}:g${parsed.principalGeneration}`;
  const expectedPreviousVersionId = parsed.principalGeneration === 1
    ? null
    : `${parsed.principalId}:g${parsed.principalGeneration - 1}`;
  if (
    parsed.principalVersionId !== expectedVersionId ||
    parsed.previousPrincipalVersionId !== expectedPreviousVersionId ||
    (parsed.expiresAt !== null && parsed.expiresAt <= parsed.createdAt) ||
    (parsed.revokedAt !== null && parsed.revokedAt < parsed.createdAt)
  ) {
    throw new Error("Agent principal version identity is invalid.");
  }
  if (sourceContractSha256(principalImmutableBody(parsed)) !== principalSha256) {
    throw new Error("Agent principal digest is invalid.");
  }
  return deepFreeze(parsed);
}

export function parseAgentRunIdentityPinV1(value: unknown): AgentRunIdentityPinV1 {
  const parsed = agentRunIdentityPinV1Schema.parse(value);
  const { pinSha256, ...body } = parsed;
  if (
    parsed.definitionVersionId !==
      `${parsed.definitionId}:v${parsed.definitionVersion}` ||
    parsed.personaVersionId !== `${parsed.definitionVersionId}:persona` ||
    parsed.modelPolicyVersionId !==
      `${parsed.definitionVersionId}:model-policy` ||
    parsed.principalVersionId !==
      `${parsed.principalId}:g${parsed.principalGeneration}` ||
    new Set(parsed.skillPins.map((skill) => skill.skillId)).size !==
      parsed.skillPins.length ||
    new Set(parsed.policyPins.map((policy) => policy.policyId)).size !==
      parsed.policyPins.length
  ) {
    throw new Error("Agent run identity pin versions are inconsistent.");
  }
  if (sourceContractSha256(body) !== pinSha256) {
    throw new Error("Agent run identity pin digest is invalid.");
  }
  return deepFreeze(parsed);
}

export function isBuiltInAgentIdentityId(value: string): value is BuiltInAgentId {
  return isBuiltInPromptAgentId(value);
}

function buildAgentDefinitionV1(input: {
  definitionId: string;
  definitionVersion: number;
  previousDefinitionVersionId: string | null;
  origin: "built_in" | "custom";
  tenantId: string;
  ownerActorId: string;
  logicalAgentId: string;
  slug: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  status: "ready" | "learning" | "watching" | "paused";
  accent: "emerald" | "blue" | "amber" | "violet" | "rose";
  modelPolicy: CustomAgentDefinition["modelPolicy"];
  skills: readonly AgentSkill[];
  publishedAt: string;
}) {
  const definitionVersionId = `${input.definitionId}:v${input.definitionVersion}`;
  const persona = {
    definitionVersionId,
    name: input.name,
    role: input.role,
    description: input.description,
    instructions: input.instructions,
    status: input.status,
    accent: input.accent,
  };
  const modelPolicy = {
    definitionVersionId,
    modelPolicy: input.modelPolicy,
  };
  const body = agentDefinitionBodySchema.parse({
    schemaVersion: AGENT_IDENTITY_SCHEMA_VERSION,
    definitionId: input.definitionId,
    definitionVersion: input.definitionVersion,
    definitionVersionId,
    previousDefinitionVersionId: input.previousDefinitionVersionId,
    origin: input.origin,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    logicalAgentId: input.logicalAgentId,
    slug: input.slug,
    name: input.name,
    role: input.role,
    description: input.description,
    instructions: input.instructions,
    status: input.status,
    accent: input.accent,
    modelPolicy: input.modelPolicy,
    personaVersionId: `${definitionVersionId}:persona`,
    personaSha256: sourceContractSha256(persona),
    modelPolicyVersionId: `${definitionVersionId}:model-policy`,
    modelPolicySha256: sourceContractSha256(modelPolicy),
    promptContractVersionId: AGENT_PROMPT_CONTRACT_VERSION_ID,
    declaredSkills: [...input.skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(buildSkillPin),
    publishedAt: canonicalTimestamp(input.publishedAt),
  });
  return parseAgentDefinitionV1({
    ...body,
    definitionSha256: sourceContractSha256(body),
  });
}

function buildAgentPrincipalDefinitionV1(
  input: Omit<
    z.input<typeof agentPrincipalBodySchema>,
    "schemaVersion" | "principalVersionId"
  >,
) {
  const principalVersionId = `${input.principalId}:g${input.principalGeneration}`;
  const body = agentPrincipalBodySchema.parse({
    ...input,
    schemaVersion: AGENT_IDENTITY_SCHEMA_VERSION,
    principalVersionId,
    toolGrantIds: uniqueSorted(input.toolGrantIds),
    contextGrantIds: uniqueSorted(input.contextGrantIds),
    capabilityGrantIds: uniqueSorted(input.capabilityGrantIds),
    createdAt: canonicalTimestamp(input.createdAt),
    expiresAt: input.expiresAt ? canonicalTimestamp(input.expiresAt) : null,
    revokedAt: input.revokedAt ? canonicalTimestamp(input.revokedAt) : null,
  });
  return parseAgentPrincipalDefinitionV1({
    ...body,
    principalSha256: sourceContractSha256(principalImmutableBody(body)),
  });
}

function principalImmutableBody(
  value: z.infer<typeof agentPrincipalBodySchema> & { principalSha256?: string },
) {
  const {
    state: _state,
    revokedAt: _revokedAt,
    principalSha256: _principalSha256,
    ...immutable
  } = value;
  return immutable;
}

function previousVersionId(
  id: string,
  marker: "v" | "g",
  version: number,
) {
  return version === 1 ? null : `${id}:${marker}${version - 1}`;
}

function buildSkillPin(skill: AgentSkill) {
  const body = {
    skillId: skill.id,
    skillVersion: skill.version,
    skillVersionId: `skill:${skill.id}:v${skill.version}`,
    skillSha256: sourceContractSha256({
      skillId: skill.id,
      version: skill.version,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      category: skill.category,
      toolIds: uniqueSorted(skill.toolIds),
    }),
  };
  return skillPinSchema.parse(body);
}

function parseSkillPin(value: z.infer<typeof skillPinSchema>) {
  if (value.skillVersionId !== `skill:${value.skillId}:v${value.skillVersion}`) {
    throw new Error("Agent skill version identity is invalid.");
  }
  return value;
}

function personaBody(value: z.infer<typeof agentDefinitionV1Schema>) {
  return {
    definitionVersionId: value.definitionVersionId,
    name: value.name,
    role: value.role,
    description: value.description,
    instructions: value.instructions,
    status: value.status,
    accent: value.accent,
  };
}

function modelPolicyBody(value: z.infer<typeof agentDefinitionV1Schema>) {
  return {
    definitionVersionId: value.definitionVersionId,
    modelPolicy: value.modelPolicy,
  };
}

function policyPin(kind: string, value: string) {
  const policyVersionId = `agent-policy:${kind}:${value}:1`;
  return {
    policyId: `agent-policy:${kind}`,
    policyVersionId,
    policySha256: sourceContractSha256({ kind, value, version: 1 }),
  };
}

function scopedPrincipalId(agentId: string, tenantId: string, actorId: string) {
  return `agent:${agentId}:${sourceContractSha256({ tenantId, actorId }).slice(0, 16)}`;
}

function requireBuiltInAgent(agentId: BuiltInAgentId): ArsenalAgent {
  const agent = arsenalAgents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error("Built-in agent definition is unavailable.");
  return agent;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Agent identity timestamp is invalid.");
  }
  return parsed.toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
