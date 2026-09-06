import { z } from "zod";

export const AGENT_PERSONA_SCHEMA_VERSION = 1 as const;

const conciseText = (max: number) => z.string().trim().min(2).max(max);
const uniqueTextList = (maxItems: number, maxLength: number) =>
  z.array(conciseText(maxLength)).max(maxItems).superRefine((values, context) => {
    const normalized = values.map((value) => value.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: "custom",
        message: "Agent persona entries must be unique.",
      });
    }
  });

/**
 * Behavioral presentation only. This contract is untrusted configuration and
 * must never be interpreted as a capability, context, budget, or approval grant.
 */
export const agentPersonaV1Schema = z.object({
  schemaVersion: z.literal(AGENT_PERSONA_SCHEMA_VERSION),
  charter: conciseText(2_000),
  operatingStyle: conciseText(2_000),
  voice: conciseText(500),
  visualIdentity: conciseText(500),
  allowedDomains: uniqueTextList(20, 120),
  escalationBehavior: conciseText(1_000),
  successMeasures: uniqueTextList(20, 200),
}).strict();

export type AgentPersonaV1 = Readonly<z.infer<typeof agentPersonaV1Schema>>;

export const DEFAULT_CUSTOM_AGENT_PERSONA: AgentPersonaV1 = Object.freeze({
  schemaVersion: AGENT_PERSONA_SCHEMA_VERSION,
  charter: "Complete the assigned objective within the user's stated scope.",
  operatingStyle: "Work in small, evidence-backed steps and verify the result before reporting completion.",
  voice: "Clear, direct, calm, and explicit about uncertainty.",
  visualIdentity: "A focused specialist companion using the selected Agent accent.",
  allowedDomains: ["General assistance"],
  escalationBehavior: "Escalate when authority, required context, or acceptance criteria are missing or when a consequential action needs approval.",
  successMeasures: [
    "The requested outcome is complete and verified.",
    "Claims and actions are traceable to evidence.",
  ],
});

export function parseAgentPersonaV1(
  value: unknown,
  fallback: AgentPersonaV1 = DEFAULT_CUSTOM_AGENT_PERSONA,
) {
  return deepFreeze(agentPersonaV1Schema.parse(value ?? fallback));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
