import { describe, expect, it } from "vitest";

import {
  projectAgentIdentityCardV1,
  projectPinnedAgentIdentityCardV1,
} from "@/lib/agents/card";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
  buildCustomAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { CustomAgentDefinition } from "@/lib/skills/types";

describe("P7.2 agent identity card", () => {
  it("projects the exact built-in persona without advertising authority", () => {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });

    const card = projectAgentIdentityCardV1(identity.definition);

    expect(card).toMatchObject({
      version: "p7.2-agent-identity-card:1",
      publicationState: "internal_identity_only",
      externalA2AEnabled: false,
      authorityAdvertised: false,
      name: "Scout",
      role: "Research",
      persona: identity.definition.persona,
    });
    expect(card.definitionSha256).toBe(identity.definition.definitionSha256);
    expect(card.personaSha256).toBe(identity.definition.personaSha256);
  });

  it("excludes scope, ownership, grants, budgets, endpoints, and credentials", () => {
    const identity = buildCustomAgentIdentityV1({
      agent: customAgent(),
      skills: [],
      definitionVersion: 1,
      principalGeneration: 1,
    });

    const card = projectAgentIdentityCardV1(identity.definition);
    const serialized = JSON.stringify(card);

    for (const forbidden of [
      "tenantId",
      "ownerActorId",
      "principalId",
      "toolGrantIds",
      "contextGrantIds",
      "capabilityGrantIds",
      "budgetPolicyVersionId",
      "endpoint",
      "credential",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(card.persona.allowedDomains)).toBe(true);
  });

  it("reconstructs the same identity card from an immutable run pin", () => {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: "forge",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });
    const pin = buildAgentRunIdentityPinV1({
      runId: "run-one",
      identity,
    });
    const pinnedCard = projectPinnedAgentIdentityCardV1({
      pin,
      presentation: identity.definition,
    });

    expect(pinnedCard).toEqual(projectAgentIdentityCardV1(identity.definition));
    expect(() => projectPinnedAgentIdentityCardV1({
      pin,
      presentation: { ...identity.definition, name: "Tampered" },
    })).toThrow(/persona digest/i);
  });
});

function customAgent(): CustomAgentDefinition {
  return {
    id: "agent-one",
    tenantId: "tenant-one",
    actorId: "actor-one",
    slug: "researcher",
    name: "Researcher",
    role: "Research specialist",
    description: "Finds exact evidence for a bounded question.",
    instructions: "Use exact evidence and report uncertainty clearly.",
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    modelPolicy: "openai_fast",
    autonomy: "assist",
    approvalPolicy: "read_only",
    memoryScope: "session",
    skillIds: [],
    toolIds: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}
