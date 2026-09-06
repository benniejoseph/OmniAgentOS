import { describe, expect, it } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildCustomAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import {
  buildInitialShadowRunContract,
  resolveShadowRunContract,
} from "@/lib/runs/contract-runtime";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";

describe("P7.1 run identity contract binding", () => {
  it("pins definition, principal, persona, skill, and policy versions", () => {
    const identity = buildCustomAgentIdentityV1({
      agent: agent,
      skills: [skill],
      definitionVersion: 4,
      principalId: "agent:agent-one",
      principalGeneration: 2,
    });
    const pin = buildAgentRunIdentityPinV1({ runId: "run-one", identity });
    const initial = buildInitialShadowRunContract({
      runId: "run-one",
      tenantId: agent.tenantId,
      agentId: agent.id,
      agentIdentityPin: pin,
      executionScope,
      requestSha256: "1".repeat(64),
      requestedOutcomeSha256: "2".repeat(64),
      interactionMode: "orchestrate",
      executionMode: "live",
      autonomy: agent.autonomy,
      approvalPolicy: agent.approvalPolicy,
      budget: {
        maxModelTurns: 4,
        maxToolCalls: 6,
        maxOutputTokens: 1_000,
        maxToolResultBytes: 50_000,
        maxExternalEffects: 2,
      },
    });

    expect(initial.envelope.agentPrincipal).toMatchObject({
      executingPrincipalId: "agent:agent-one:g2",
      agentDefinitionId: "definition:custom:agent-one",
      agentDefinitionVersionId: "definition:custom:agent-one:v4",
    });
    expect(initial.envelope.harnessManifest).toMatchObject({
      manifestState: "partially_pinned",
      agentDefinitionVersionId: "definition:custom:agent-one:v4",
      promptContractVersionId: "agent-instructions:1",
      skills: [{
        id: "skill-one",
        pinState: "pinned",
        versionId: "skill:skill-one:v3",
      }],
    });
    expect(initial.envelope.harnessManifest.policies).toHaveLength(4);

    const resolved = resolveShadowRunContract({
      active: initial,
      querySha256: "3".repeat(64),
      scopeDecision: "skipped",
      selectedContext: [],
      userInclusionIds: [],
      userExclusionIds: [],
      providerDisclosureBoundary: "none",
      modelProvider: "openai",
      modelId: "gpt-test",
      modelTier: "fast",
      toolIds: [],
      skillIds: ["skill-one"],
      policyIds: [],
      instructionsSha256: "4".repeat(64),
      toolboxSha256: "5".repeat(64),
    });
    expect(resolved.envelope.harnessManifest.skills[0]).toMatchObject({
      pinState: "pinned",
      versionId: "skill:skill-one:v3",
    });
    expect(resolved.envelope.harnessManifest.promptContractVersionId)
      .toBe("agent-instructions:1");
    expect(resolved.envelope.harnessManifest.policies).toHaveLength(4);
  });
});

const agent: CustomAgentDefinition = {
  id: "agent-one",
  tenantId: "tenant-one",
  actorId: "actor-one",
  slug: "researcher",
  name: "Researcher",
  role: "Research specialist",
  description: "Finds exact evidence.",
  instructions: "Use exact evidence.",
  persona: DEFAULT_CUSTOM_AGENT_PERSONA,
  status: "ready",
  accent: "blue",
  modelPolicy: "openai_fast",
  autonomy: "governed",
  approvalPolicy: "risk_based",
  memoryScope: "all",
  skillIds: ["skill-one"],
  toolIds: ["runs.list"],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T01:00:00.000Z",
};

const skill: AgentSkill = {
  id: "skill-one",
  tenantId: "tenant-one",
  actorId: "actor-one",
  slug: "evidence",
  name: "Evidence",
  description: "Find evidence.",
  instructions: "Use exact sources.",
  category: "research",
  status: "active",
  version: 3,
  toolIds: ["runs.list"],
  tags: [],
  knowledgeTags: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

const executionScope = createExecutionScope({
  tenantId: agent.tenantId,
  initiatingActorId: agent.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: agent.id,
  correlationId: "request-one",
  purpose: "agent.run",
});
