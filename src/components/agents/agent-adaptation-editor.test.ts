import { describe, expect, it } from "vitest";

import { agentAdaptationAction } from "@/components/agents/agent-adaptation-editor";
import {
  activateAgentAdaptationV1,
  buildObservedAgentAdaptationV1,
  evaluateAgentAdaptationV1,
  rollbackAgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";

describe("P7.6 Agent adaptation editor", () => {
  it("offers evaluation only on the observed release", () => {
    expect(agentAdaptationAction(observed(), 4)).toEqual({
      kind: "evaluate",
      label: "Evaluate",
    });
    expect(agentAdaptationAction(observed(), 5)).toMatchObject({
      kind: "blocked",
    });
  });

  it("offers activation only after a passed exact-release evaluation", () => {
    const evaluated = evaluateAgentAdaptationV1(observed(), 4);
    expect(agentAdaptationAction(evaluated, 4)).toEqual({
      kind: "activate",
      label: "Activate",
    });
    expect(agentAdaptationAction(evaluated, 5)).toMatchObject({
      kind: "blocked",
    });
  });

  it("holds low-confidence evidence without an activation action", () => {
    const held = evaluateAgentAdaptationV1(observed(0.5), 4);
    expect(agentAdaptationAction(held, 4)).toEqual({
      kind: "blocked",
      reason: "Held because the measurable confidence threshold was not met.",
    });
  });

  it("keeps rollback available and makes it terminal", () => {
    const active = activateAgentAdaptationV1(
      evaluateAgentAdaptationV1(observed(), 4),
      2,
    );
    expect(agentAdaptationAction(active, 5)).toEqual({
      kind: "rollback",
      label: "Roll back",
    });
    expect(agentAdaptationAction(rollbackAgentAdaptationV1(active), 5))
      .toMatchObject({ kind: "blocked" });
  });
});

function observed(confidence = 0.9) {
  return buildObservedAgentAdaptationV1({
    tenantId: "tenant-one",
    ownerActorId: "owner@example.test",
    agentId: "scout",
    definitionVersion: 4,
    evidence: [{
      evidenceId: "run-feedback:run-one",
      kind: "run_feedback",
      sourceId: "run-one",
      sourceSha256: "a".repeat(64),
      verdict: "needs_work",
      groundingStatus: "verified",
      observedAt: "2026-09-07T05:00:00.000Z",
    }],
    guidance: "Cite the exact source for material claims.",
    confidence,
    observedAt: "2026-09-07T05:00:00.000Z",
  });
}
