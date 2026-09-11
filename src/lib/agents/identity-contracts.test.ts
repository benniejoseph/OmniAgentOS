import { describe, expect, it } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
  buildCustomAgentIdentityV1,
  parseAgentDefinitionV1,
  parseAgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";

describe("P7.1 agent identity contracts", () => {
  it("separates behavioral definition fields from security authority", () => {
    const identity = buildCustomAgentIdentityV1({
      agent: customAgent(),
      skills: [skill()],
      definitionVersion: 1,
      principalGeneration: 1,
    });

    expect(identity.definition).toMatchObject({
      definitionVersionId: "definition:custom:agent-one:v1",
      name: "Researcher",
      declaredSkills: [{
        skillId: "skill-one",
        skillVersion: 3,
        skillVersionId: "skill:skill-one:v3",
      }],
    });
    expect(identity.definition).not.toHaveProperty("autonomy");
    expect(identity.definition).not.toHaveProperty("toolGrantIds");
    expect(identity.principal).toMatchObject({
      principalGeneration: 1,
      authorityMode: "explicit_grants",
      autonomy: "assist",
      toolGrantIds: ["runs.list"],
    });
    expect(identity.principal).not.toHaveProperty("name");
    expect(identity.principal).not.toHaveProperty("instructions");
    expect(identity.principal).not.toHaveProperty("modelPolicy");
  });

  it("pins the exact built-in prompt persona under an actor-scoped principal", () => {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });
    const pin = buildAgentRunIdentityPinV1({
      runId: "run-one",
      identity,
    });

    expect(identity.definition).toMatchObject({
      name: "Scout",
      role: "Research",
      promptContractVersionId: "agent-instructions:1",
    });
    expect(identity.principal).toMatchObject({
      authorityMode: "server_policy",
      toolGrantIds: [],
      controllerActorId: "actor-one",
    });
    expect(pin).toMatchObject({
      version: "p7.1-agent-identity-pin:1",
      logicalAgentId: "scout",
      definitionVersion: 1,
      principalGeneration: 1,
      skillPins: [],
    });
    expect(pin.policyPins).toHaveLength(4);
    expect(pin.pinSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("publishes Meridian as a read-only market-research identity", () => {
    const identity = buildBuiltInAgentIdentityV1({
      agentId: "meridian",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });

    expect(identity.definition).toMatchObject({
      logicalAgentId: "meridian",
      name: "Meridian",
      role: "Market research",
    });
    expect(identity.definition.persona.allowedDomains).toContain("ICT model research");
    expect(identity.principal).toMatchObject({
      authorityMode: "server_policy",
      autonomy: "governed",
      toolGrantIds: [],
    });
  });

  it("keeps definition edits independent from an unchanged principal", () => {
    const first = buildCustomAgentIdentityV1({
      agent: customAgent(),
      skills: [skill()],
      definitionVersion: 1,
      principalGeneration: 1,
    });
    const second = buildCustomAgentIdentityV1({
      agent: {
        ...customAgent(),
        description: "A revised behavioral description.",
        updatedAt: "2026-09-07T01:00:00.000Z",
      },
      skills: [skill()],
      definitionVersion: 2,
      previousDefinitionVersionId: first.definition.definitionVersionId,
      principalGeneration: 1,
      principalCreatedAt: first.principal.createdAt,
    });

    expect(second.definition.definitionSha256)
      .not.toBe(first.definition.definitionSha256);
    expect(second.principal.principalVersionId)
      .toBe(first.principal.principalVersionId);
    expect(second.principal.principalSha256).toBe(first.principal.principalSha256);
  });

  it("maps a legacy custom agent onto its canonical stored identities", () => {
    const identity = buildCustomAgentIdentityV1({
      agent: { ...customAgent(), actorId: "owner@example.test" },
      skills: [skill()],
      definitionVersion: 2,
      ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
      definitionPublishedAt: "2026-09-07T02:00:00.000Z",
      principalId: "agent:agent-one",
      principalGeneration: 3,
      principalCreatedAt: "2026-09-07T01:00:00.000Z",
    });

    expect(identity.definition).toMatchObject({
      ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
      definitionVersionId: "definition:custom:agent-one:v2",
      publishedAt: "2026-09-07T02:00:00.000Z",
    });
    expect(identity.principal).toMatchObject({
      principalId: "agent:agent-one",
      principalVersionId: "agent:agent-one:g3",
      controllerActorId: "actor:11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects tampered definitions, pins, and mismatched principal scope", () => {
    const identity = buildCustomAgentIdentityV1({
      agent: customAgent(),
      skills: [skill()],
      definitionVersion: 1,
      principalGeneration: 1,
    });
    const pin = buildAgentRunIdentityPinV1({ runId: "run-one", identity });

    expect(() => parseAgentDefinitionV1({
      ...identity.definition,
      name: "Tampered",
    })).toThrow(/persona digest/i);
    expect(() => parseAgentRunIdentityPinV1({
      ...pin,
      definitionVersion: 2,
    })).toThrow(/pin/i);
    expect(() => buildAgentRunIdentityPinV1({
      runId: "run-two",
      identity: {
        definition: identity.definition,
        principal: {
          ...identity.principal,
          controllerActorId: "actor-other",
        },
      },
    })).toThrow();
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
    skillIds: ["skill-one"],
    toolIds: ["runs.list"],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

function skill(): AgentSkill {
  return {
    id: "skill-one",
    tenantId: "tenant-one",
    actorId: "actor-one",
    slug: "evidence",
    name: "Evidence",
    description: "Find evidence.",
    instructions: "Return only claims supported by exact evidence.",
    category: "research",
    status: "active",
    version: 3,
    toolIds: ["runs.list"],
    tags: [],
    knowledgeTags: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}
