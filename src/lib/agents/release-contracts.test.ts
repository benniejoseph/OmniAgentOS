import { describe, expect, it } from "vitest";

import { buildCustomAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import {
  evaluateAgentReleaseCandidateV1,
  parseAgentReleaseChannelV1,
  parseAgentReleaseEvaluationV1,
} from "@/lib/agents/release-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { CustomAgentDefinition } from "@/lib/skills/types";

describe("P7.5 agent release contracts", () => {
  it("evaluates a forward behavior version without carrying authority", () => {
    const baseline = definition(1, agent());
    const candidate = definition(2, {
      ...agent(),
      instructions: "Use exact primary evidence and report uncertainty.",
      updatedAt: "2026-09-07T02:00:00.000Z",
    });

    const evaluation = evaluateAgentReleaseCandidateV1({
      baseline,
      candidate,
      evaluatedAt: "2026-09-07T02:01:00.000Z",
    });

    expect(evaluation).toMatchObject({
      agentId: "agent-one",
      definitionVersion: 2,
      baselineDefinitionVersion: 1,
      direction: "promotion",
      changedFields: ["instructions"],
      verdict: "passed",
      checks: { authorityExcluded: true },
    });
    expect(evaluation).not.toHaveProperty("tenantId");
    expect(evaluation).not.toHaveProperty("instructions");
    expect(parseAgentReleaseEvaluationV1(evaluation)).toEqual(evaluation);
  });

  it("rejects cross-owner, same-version, and no-op candidates", () => {
    const baseline = definition(1, agent());
    expect(() => evaluateAgentReleaseCandidateV1({
      baseline,
      candidate: definition(2, {
        ...agent(),
        actorId: "actor:22222222-2222-4222-8222-222222222222",
      }),
    })).toThrow("exact owner");
    expect(() => evaluateAgentReleaseCandidateV1({
      baseline,
      candidate: definition(1, { ...agent(), description: "Changed." }),
    })).toThrow("change the active version");
    expect(() => evaluateAgentReleaseCandidateV1({
      baseline,
      candidate: definition(2, agent()),
    })).toThrow("material behavior change");
  });

  it("produces a separately bound rollback evaluation", () => {
    const target = definition(1, agent());
    const active = definition(2, {
      ...agent(),
      description: "A candidate that can be rolled back.",
      updatedAt: "2026-09-07T02:00:00.000Z",
    });
    const evaluation = evaluateAgentReleaseCandidateV1({
      baseline: active,
      candidate: target,
      evaluatedAt: "2026-09-07T03:00:00.000Z",
    });
    expect(evaluation).toMatchObject({
      direction: "rollback",
      definitionVersion: 1,
      baselineDefinitionVersion: 2,
      changedFields: ["description"],
    });
  });

  it("validates active, rollback, candidate, and retirement coordinates", () => {
    const baseline = definition(1, agent());
    const candidate = definition(2, {
      ...agent(),
      role: "Evidence lead",
      updatedAt: "2026-09-07T02:00:00.000Z",
    });
    const evaluation = evaluateAgentReleaseCandidateV1({ baseline, candidate });
    const channel = parseAgentReleaseChannelV1({
      schemaVersion: 1,
      agentId: "agent-one",
      state: "active",
      releaseRevision: 2,
      activeDefinitionVersion: 1,
      activeDefinitionVersionId: "definition:custom:agent-one:v1",
      previousDefinitionVersion: null,
      previousDefinitionVersionId: null,
      latestDefinitionVersion: 2,
      latestDefinitionVersionId: "definition:custom:agent-one:v2",
      candidateEvaluation: evaluation,
      updatedAt: "2026-09-07T02:01:00.000Z",
      retiredAt: null,
    });
    expect(channel.candidateEvaluation?.definitionVersion).toBe(2);
    expect(() => parseAgentReleaseChannelV1({
      ...channel,
      state: "retired",
      retiredAt: null,
    })).toThrow();
  });
});

function definition(version: number, definitionAgent: CustomAgentDefinition) {
  return buildCustomAgentIdentityV1({
    agent: definitionAgent,
    skills: [],
    definitionVersion: version,
    principalGeneration: 1,
  }).definition;
}

function agent(): CustomAgentDefinition {
  return {
    id: "agent-one",
    tenantId: "tenant-one",
    actorId: "actor:11111111-1111-4111-8111-111111111111",
    slug: "researcher",
    name: "Researcher",
    role: "Research specialist",
    description: "Finds exact evidence.",
    instructions: "Use exact primary evidence.",
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    modelPolicy: "openai_fast",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    memoryScope: "all",
    skillIds: [],
    toolIds: [],
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:00:00.000Z",
  };
}
