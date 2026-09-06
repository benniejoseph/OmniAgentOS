import {
  projectAgentIdentityCardV1,
  projectPinnedAgentIdentityCardV1,
  type AgentDefinitionPresentationV1,
} from "@/lib/agents/card";
import {
  buildBuiltInAgentIdentityV1,
  isBuiltInAgentIdentityId,
} from "@/lib/agents/identity-contracts";
import { parseAgentPersonaV1 } from "@/lib/agents/persona";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { getAgentRunIdentityPin } from "@/lib/runs/store";

export type RunAgentIdentityCardResult = Readonly<
  | { state: "unbound" }
  | { state: "definition_unavailable" }
  | { state: "ready"; card: ReturnType<typeof projectAgentIdentityCardV1> }
>;

export async function getAgentIdentityCardForRun(
  runId: string,
  options: { tenantId: string },
): Promise<RunAgentIdentityCardResult> {
  const pin = await getAgentRunIdentityPin(runId, {
    tenantId: options.tenantId,
  });
  if (!pin) return Object.freeze({ state: "unbound" });

  if (isBuiltInAgentIdentityId(pin.logicalAgentId)) {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: pin.logicalAgentId,
      tenantId: pin.tenantId,
      controllerActorId: pin.actorId,
    });
    if (
      identity.definition.definitionVersionId !== pin.definitionVersionId ||
      identity.definition.definitionSha256 !== pin.definitionSha256 ||
      identity.definition.personaSha256 !== pin.personaSha256
    ) {
      throw new Error("Built-in Agent identity no longer matches its run pin.");
    }
    return Object.freeze({
      state: "ready",
      card: projectAgentIdentityCardV1(identity.definition),
    });
  }

  if (!hasDatabaseUrl()) {
    return Object.freeze({ state: "definition_unavailable" });
  }
  await ensureDatabaseSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      agent_definition_id,
      definition_version,
      name,
      role,
      description,
      instructions,
      persona_profile,
      status,
      accent
    FROM omni_agent_definition_versions
    WHERE tenant_id = ${pin.tenantId}
      AND owner_actor_id = ${pin.actorId}
      AND agent_definition_id = ${pin.logicalAgentId}
      AND definition_version = ${pin.definitionVersion}
    LIMIT 1
  `;
  if (!rows[0]) {
    return Object.freeze({ state: "definition_unavailable" });
  }
  const presentation: AgentDefinitionPresentationV1 = {
    logicalAgentId: String(rows[0].agent_definition_id),
    definitionVersion: Number(rows[0].definition_version),
    definitionVersionId: pin.definitionVersionId,
    name: String(rows[0].name),
    role: String(rows[0].role),
    description: String(rows[0].description),
    instructions: String(rows[0].instructions),
    persona: parseAgentPersonaV1(rows[0].persona_profile),
    status: String(rows[0].status) as AgentDefinitionPresentationV1["status"],
    accent: String(rows[0].accent) as AgentDefinitionPresentationV1["accent"],
  };
  return Object.freeze({
    state: "ready",
    card: projectPinnedAgentIdentityCardV1({ pin, presentation }),
  });
}
