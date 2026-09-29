import {
  AgentIdentityResolutionError,
  buildAgentSkillPinV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { isAgentSkillRuntimeActive } from "@/lib/skills/store";
import type { AgentSkill } from "@/lib/skills/types";

export class AgentSkillChangedSinceReleaseError extends AgentIdentityResolutionError {
  constructor() {
    super(
      "A Skill this Agent uses changed after the Agent was released. Evaluate and promote the Agent's latest version before assigning it work.",
    );
    this.name = "AgentSkillChangedSinceReleaseError";
  }
}

/**
 * The Skills a run of this Agent may use: only the ones its active release
 * pins, so a Skill added to a later draft never reaches a run or widens its
 * tools. A pinned Skill that is disabled or gone is left out, which only
 * narrows the run. A custom Skill edited since the release stops the run,
 * because the version the release pinned no longer exists; a built-in Skill
 * ships with the deployment, so its id is enough.
 */
export function selectReleasedAgentSkills(
  identity: Pick<ResolvedAgentIdentityV1, "definition">,
  available: readonly AgentSkill[],
): AgentSkill[] {
  const byId = new Map(available.map((skill) => [skill.id, skill]));
  return identity.definition.declaredSkills.flatMap((pin) => {
    const skill = byId.get(pin.skillId);
    if (!skill || !isAgentSkillRuntimeActive(skill)) return [];
    // The digest covers the version and every field a run reads.
    if (!skill.builtIn && buildAgentSkillPinV1(skill).skillSha256 !== pin.skillSha256) {
      throw new AgentSkillChangedSinceReleaseError();
    }
    return [skill];
  });
}
