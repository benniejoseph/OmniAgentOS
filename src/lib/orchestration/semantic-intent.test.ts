import { describe, expect, it } from "vitest";
import {
  applySemanticIntentPolicy,
  deterministicSemanticFallback,
  type SemanticIntentCandidate,
} from "@/lib/orchestration/semantic-intent";
import { routeAgentRequest } from "@/lib/orchestration/supervisor";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";

const readCapability: CapabilityDescriptor = {
  id: "github.issues.list",
  name: "List GitHub issues",
  description: "Read issues from a repository.",
  category: "connector",
  source: "native",
  riskLevel: 0,
  approvalRequired: false,
  reversible: true,
};

const writeCapability: CapabilityDescriptor = {
  id: "calendar.create",
  name: "Create calendar event",
  description: "Create an event in Google Calendar.",
  category: "connector",
  source: "native",
  riskLevel: 2,
  approvalRequired: true,
  reversible: true,
};

function candidate(
  overrides: Partial<SemanticIntentCandidate> = {},
): SemanticIntentCandidate {
  return {
    intent: "question",
    executionShape: "conversational",
    workKinds: [],
    consequential: false,
    needsClarification: false,
    entities: [],
    capabilityQueries: [],
    candidateCapabilityIds: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("semantic intent policy", () => {
  it("routes semantic background coordination durably and selects its team", () => {
    const baseline = routeAgentRequest(
      "Investigate this and prepare a verified report for later.",
      "orchestrate",
    );
    const resolution = applySemanticIntentPolicy({
      baseline,
      mode: "orchestrate",
      capabilityCandidates: [readCapability],
      candidate: candidate({
        intent: "research",
        executionShape: "background",
        workKinds: ["research", "verify", "coordinate"],
        candidateCapabilityIds: [readCapability.id],
        capabilityQueries: ["github issue research"],
      }),
    });

    expect(resolution.decision).toMatchObject({
      route: "durable_workflow",
      primaryAgentId: "scout",
      requiresApproval: false,
    });
    expect(resolution.decision.specialistIds).toEqual(
      expect.arrayContaining(["scout", "atlas", "sentinel"]),
    );
    expect(resolution.receipt.matchedCapabilityIds).toEqual([
      readCapability.id,
    ]);
  });

  it("never lets semantic output remove deterministic approval", () => {
    const baseline = routeAgentRequest(
      "Deploy the release to production.",
      "execute",
    );
    const resolution = applySemanticIntentPolicy({
      baseline,
      mode: "execute",
      capabilityCandidates: [],
      candidate: candidate({
        intent: "question",
        executionShape: "conversational",
        consequential: false,
      }),
    });

    expect(baseline.requiresApproval).toBe(true);
    expect(resolution.decision.requiresApproval).toBe(true);
  });

  it("uses only catalog-validated capability identifiers", () => {
    const resolution = applySemanticIntentPolicy({
      baseline: routeAgentRequest("Put lunch on my calendar."),
      mode: "orchestrate",
      capabilityCandidates: [writeCapability],
      candidate: candidate({
        intent: "create",
        executionShape: "single_action",
        workKinds: ["build"],
        candidateCapabilityIds: [writeCapability.id, "invented.admin.tool"],
        capabilityQueries: ["schedule lunch event"],
      }),
    });

    expect(resolution.receipt.matchedCapabilityIds).toEqual([
      writeCapability.id,
    ]);
    expect(resolution.receipt.matchedCapabilityIds).not.toContain(
      "invented.admin.tool",
    );
    expect(resolution.decision.requiresApproval).toBe(true);
  });

  it("keeps exact destructive ambiguity and saved procedures authoritative", () => {
    const ambiguity = applySemanticIntentPolicy({
      baseline: routeAgentRequest("Delete the old project"),
      mode: "orchestrate",
      capabilityCandidates: [],
      candidate: candidate({
        intent: "question",
        executionShape: "conversational",
      }),
    });
    expect(ambiguity.decision.route).toBe("clarify");
    expect(ambiguity.receipt.source).toBe("deterministic_invariant");

    const procedure = applySemanticIntentPolicy({
      baseline: routeAgentRequest(
        "Run my publishing routine",
        "orchestrate",
        undefined,
        [{
          id: "workflow:publish",
          aliases: ["publishing routine"],
          requiredToolIds: ["publish.post"],
        }],
      ),
      mode: "orchestrate",
      capabilityCandidates: [],
      candidate: candidate(),
    });
    expect(procedure.decision).toMatchObject({
      route: "durable_workflow",
      procedure: { workflowId: "workflow:publish" },
    });
  });

  it("records model ambiguity as advisory without adding clarification", () => {
    const resolution = applySemanticIntentPolicy({
      baseline: routeAgentRequest("Explain the deployment process."),
      mode: "orchestrate",
      capabilityCandidates: [],
      candidate: candidate({ needsClarification: true }),
    });
    expect(resolution.decision.route).toBe("direct");
    expect(resolution.receipt.clarificationAdvisory).toBe(true);
  });

  it("fails back to the deterministic decision without broadening it", () => {
    const baseline = routeAgentRequest("Run the workflow every week.");
    const resolution = deterministicSemanticFallback({
      baseline,
      reasonCode: "model_output_invalid",
    });
    expect(resolution.decision).toEqual(baseline);
    expect(resolution.receipt).toMatchObject({
      source: "deterministic_fallback",
      fallbackReasonCode: "model_output_invalid",
      route: "durable_workflow",
    });
  });
});
