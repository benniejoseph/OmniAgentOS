import { z } from "zod";

import {
  parseAgentRunIdentityPinV1,
  parseAgentDefinitionV1,
  type AgentDefinitionV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import { agentPersonaV1Schema } from "@/lib/agents/persona";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const AGENT_IDENTITY_CARD_VERSION =
  "p7.2-agent-identity-card:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const definitionPresentationSchema = z.object({
  logicalAgentId: z.string().trim().min(1).max(240),
  definitionVersion: z.number().int().min(1),
  definitionVersionId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  instructions: z.string().max(12_000),
  status: z.enum(["ready", "learning", "watching", "paused"]),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]),
  persona: agentPersonaV1Schema,
});

/**
 * Identity-only card projection shared by product surfaces and the future A2A
 * discovery adapter. It deliberately carries no principal, grant, budget,
 * tenant, actor, endpoint, or authentication information.
 */
export const agentIdentityCardV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(AGENT_IDENTITY_CARD_VERSION),
  publicationState: z.literal("internal_identity_only"),
  externalA2AEnabled: z.literal(false),
  authorityAdvertised: z.literal(false),
  logicalAgentId: z.string().trim().min(1).max(240),
  definitionVersion: z.number().int().min(1),
  definitionVersionId: z.string().trim().min(1).max(240),
  definitionSha256: sha256Schema,
  personaVersionId: z.string().trim().min(1).max(240),
  personaSha256: sha256Schema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  status: z.enum(["ready", "learning", "watching", "paused"]),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]),
  persona: agentPersonaV1Schema,
}).strict();

export type AgentIdentityCardV1 = Readonly<
  z.infer<typeof agentIdentityCardV1Schema>
>;
export type AgentDefinitionPresentationV1 = Readonly<
  z.infer<typeof definitionPresentationSchema>
>;

export function projectAgentIdentityCardV1(
  value: AgentDefinitionV1,
): AgentIdentityCardV1 {
  const definition = parseAgentDefinitionV1(value);
  return deepFreeze(agentIdentityCardV1Schema.parse({
    schemaVersion: 1,
    version: AGENT_IDENTITY_CARD_VERSION,
    publicationState: "internal_identity_only",
    externalA2AEnabled: false,
    authorityAdvertised: false,
    logicalAgentId: definition.logicalAgentId,
    definitionVersion: definition.definitionVersion,
    definitionVersionId: definition.definitionVersionId,
    definitionSha256: definition.definitionSha256,
    personaVersionId: definition.personaVersionId,
    personaSha256: definition.personaSha256,
    name: definition.name,
    role: definition.role,
    description: definition.description,
    status: definition.status,
    accent: definition.accent,
    persona: definition.persona,
  }));
}

export function projectPinnedAgentIdentityCardV1(input: {
  pin: AgentRunIdentityPinV1;
  presentation: AgentDefinitionPresentationV1;
}): AgentIdentityCardV1 {
  const pin = parseAgentRunIdentityPinV1(input.pin);
  const presentation = definitionPresentationSchema.parse(input.presentation);
  if (
    presentation.logicalAgentId !== pin.logicalAgentId ||
    presentation.definitionVersion !== pin.definitionVersion ||
    presentation.definitionVersionId !== pin.definitionVersionId
  ) {
    throw new Error("Pinned Agent presentation does not match the run identity.");
  }
  const personaSha256 = sourceContractSha256({
    definitionVersionId: presentation.definitionVersionId,
    name: presentation.name,
    role: presentation.role,
    description: presentation.description,
    instructions: presentation.instructions,
    status: presentation.status,
    accent: presentation.accent,
    persona: presentation.persona,
  });
  if (personaSha256 !== pin.personaSha256) {
    throw new Error("Pinned Agent persona digest does not match its definition.");
  }
  return deepFreeze(agentIdentityCardV1Schema.parse({
    schemaVersion: 1,
    version: AGENT_IDENTITY_CARD_VERSION,
    publicationState: "internal_identity_only",
    externalA2AEnabled: false,
    authorityAdvertised: false,
    logicalAgentId: presentation.logicalAgentId,
    definitionVersion: presentation.definitionVersion,
    definitionVersionId: presentation.definitionVersionId,
    definitionSha256: pin.definitionSha256,
    personaVersionId: pin.personaVersionId,
    personaSha256: pin.personaSha256,
    name: presentation.name,
    role: presentation.role,
    description: presentation.description,
    status: presentation.status,
    accent: presentation.accent,
    persona: presentation.persona,
  }));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
