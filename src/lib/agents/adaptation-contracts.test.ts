import { describe, expect, it } from "vitest";

import {
  activateAgentAdaptationV1,
  buildObservedAgentAdaptationV1,
  evaluateAgentAdaptationV1,
  parseAgentAdaptationV1,
  rollbackAgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";

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
