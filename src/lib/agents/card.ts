import { z } from "zod";

import {
  parseAgentDefinitionV1,
  type AgentDefinitionV1,
} from "@/lib/agents/identity-contracts";
import { agentPersonaV1Schema } from "@/lib/agents/persona";

export const AGENT_IDENTITY_CARD_VERSION =
  "p7.2-agent-identity-card:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
