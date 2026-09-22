import { describe, expect, it } from "vitest";

import {
  AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION,
  activateAgentAdaptationV1,
  buildObservedAgentAdaptationV1,
  evaluateAgentAdaptationV1,
  parseAgentAdaptationV1,
  rollbackAgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const evidence = {
  evidenceId: "run-feedback:run-one",
  kind: "run_feedback" as const,
  sourceId: "run-one",
  sourceSha256: "a".repeat(64),
  verdict: "needs_work" as const,
  groundingStatus: "verified" as const,
  observedAt: "2026-09-07T05:00:00.000Z",
};

describe("P7.6 Agent adaptation contract", () => {
  it("binds observed guidance to exact evidence and owner without granting authority", () => {
    const adaptation = observed();

    expect(adaptation).toMatchObject({
      state: "observed",
      lifecycleRevision: 0,
      confidence: 0.9,
      effect: {
        kind: "instruction_guidance",
        guidance: "Cite the exact source for material claims.",
        authorityImpact: "none",
      },
    });
    expect(adaptation.ownerBindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(adaptation)).not.toContain("owner@example.test");
  });

  it("requires a passed exact-version evaluation before activation", () => {
    const evaluated = evaluateAgentAdaptationV1(
      observed(3),
      3,
      "2026-09-07T05:01:00.000Z",
    );
    const active = activateAgentAdaptationV1(
      evaluated,
      7,
      "2026-09-07T05:02:00.000Z",
    );

    expect(active).toMatchObject({
      state: "active",
      lifecycleRevision: 2,
      activationVersion: 7,
      evaluation: {
        definitionVersion: 3,
        verdict: "passed",
      },
    });
    expect(() => activateAgentAdaptationV1(observed(), 1)).toThrow(
      /passed Agent adaptation evaluation/,
    );
  });

  it("holds low-confidence evidence and preserves rollback identity", () => {
    const lowConfidence = buildObservedAgentAdaptationV1({
      tenantId: "tenant-one",
      ownerActorId: "owner@example.test",
      agentId: "scout",
      definitionVersion: 1,
      evidence: [evidence],
      guidance: "Prefer primary sources.",
      confidence: 0.5,
      observedAt: "2026-09-07T05:00:00.000Z",
    });
    const held = evaluateAgentAdaptationV1(lowConfidence, 1);
    expect(held.evaluation?.verdict).toBe("held");
    expect(() => activateAgentAdaptationV1(held, 1)).toThrow();

    const active = activateAgentAdaptationV1(
      evaluateAgentAdaptationV1(observed(), 1),
      1,
    );
    const rolledBack = rollbackAgentAdaptationV1(
      active,
      "2026-09-07T05:03:00.000Z",
    );
    expect(rolledBack).toMatchObject({
      adaptationId: active.adaptationId,
      state: "rolled_back",
      lifecycleRevision: 3,
      activationVersion: 1,
    });
    expect(() => rollbackAgentAdaptationV1(rolledBack)).toThrow();
  });

  it("rejects tampered evidence or guidance digests", () => {
    const adaptation = observed();
    expect(() => parseAgentAdaptationV1({
      ...adaptation,
      effect: { ...adaptation.effect, guidance: "Tampered guidance." },
    })).toThrow(/integrity/i);
  });

  it("binds proactive Sentinel provenance without granting activation authority", () => {
    const reviewBody = {
      verdict: "passed" as const,
      score: 0.9,
      findings: [
        "evidence_bound" as const,
        "definition_bound" as const,
        "non_authority" as const,
        "measurable" as const,
      ],
    };
    const adaptation = buildObservedAgentAdaptationV1({
      tenantId: "tenant-one",
      ownerActorId: "owner@example.test",
      agentId: "scout",
      definitionVersion: 1,
      evidence: [evidence],
      guidance: "Cite material claims before returning the result.",
      confidence: 0.9,
      proposalReview: {
        version: AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION,
        targetIdentity: identityPin("scout", "a"),
        sentinelRuntime: {
          ...identityPin("sentinel", "b"),
          agentId: "sentinel",
          provider: "openai",
          model: "gpt-5.5",
          tier: "reasoning",
          routeSource: "tenant_assignment",
          assignmentId: "assignment-verifier",
          assignmentRevision: 2,
          assignmentConfigurationSha256: "c".repeat(64),
        },
        evidenceSetSha256: "d".repeat(64),
        baselineEffectSha256: null,
        proposalSha256: "e".repeat(64),
        shadowComparisonSha256: "f".repeat(64),
        review: {
          ...reviewBody,
          reviewSha256: sourceContractSha256(reviewBody),
        },
        generatedAt: "2026-09-22T10:00:00.000Z",
        reviewedAt: "2026-09-22T10:00:01.000Z",
        authorityImpact: "none",
      },
      observedAt: "2026-09-22T10:00:01.000Z",
    });

    expect(adaptation).toMatchObject({
      state: "observed",
      evaluation: null,
      activationVersion: null,
      effect: {
        proposalReview: {
          authorityImpact: "none",
          sentinelRuntime: { provider: "openai", model: "gpt-5.5" },
        },
      },
    });
    expect(() => parseAgentAdaptationV1({
      ...adaptation,
      effect: {
        ...adaptation.effect,
        proposalReview: {
          ...adaptation.effect.proposalReview,
          sentinelRuntime: {
            ...adaptation.effect.proposalReview!.sentinelRuntime,
            model: "tampered-model",
          },
        },
      },
    })).toThrow(/integrity/i);
  });
});

function observed(definitionVersion = 1) {
  return buildObservedAgentAdaptationV1({
    tenantId: "tenant-one",
    ownerActorId: "owner@example.test",
    agentId: "scout",
    definitionVersion,
    evidence: [evidence],
    guidance: "Cite the exact source for material claims.",
    confidence: 0.9,
    observedAt: "2026-09-07T05:00:00.000Z",
  });
}

function identityPin(agentId: string, digestPrefix: string) {
  return {
    agentId,
    definitionVersion: 1,
    definitionSha256: digestPrefix.repeat(64),
    principalId: `principal:${agentId}`,
    principalGeneration: 1,
    principalSha256: digestPrefix.repeat(64),
  };
}
