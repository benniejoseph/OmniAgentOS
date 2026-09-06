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

const memoryWriteCapability: CapabilityDescriptor = {
  id: "memory.write",
  name: "Write memory",
  description: "Persist a durable memory.",
  category: "memory",
  source: "native",
  riskLevel: 1,
  approvalRequired: false,
  reversible: true,
};

const memorySearchCapability: CapabilityDescriptor = {
  id: "memory.search",
  name: "Search memory",
  description: "Find durable memories.",
  category: "memory",
  source: "native",
  riskLevel: 0,
  approvalRequired: false,
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
      "In the background, investigate this and prepare a verified report.",
      "orchestrate",
    );
    const resolution = applySemanticIntentPolicy({
      message: "In the background, investigate this and prepare a verified report.",
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
      message: "Deploy the release to production.",
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
      message: "Put lunch on my calendar.",
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
      message: "Delete the old project",
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
      message: "Run my publishing routine",
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
      message: "Explain the deployment process.",
      baseline: routeAgentRequest("Explain the deployment process."),
      mode: "orchestrate",
      capabilityCandidates: [],
      candidate: candidate({ needsClarification: true }),
    });
    expect(resolution.decision.route).toBe("direct");
    expect(resolution.receipt.clarificationAdvisory).toBe(true);
  });

  it("maps semantic memory creation to an active catalog capability", () => {
    const resolution = applySemanticIntentPolicy({
      message: "Remember that release notes need a risk section.",
      baseline: routeAgentRequest(
        "Remember that release notes need a risk section.",
        "learn",
      ),
      mode: "learn",
      capabilityCandidates: [memoryWriteCapability],
      candidate: candidate({
        intent: "create",
        executionShape: "multi_step",
        workKinds: ["memory"],
        capabilityQueries: ["remember preference memory write"],
      }),
    });
    expect(resolution.decision.route).toBe("direct");
    expect(resolution.receipt.matchedCapabilityIds).toEqual([
      "memory.write",
    ]);
  });

  it("keeps learn-mode retrieval bound to memory when the model omits its work kind", () => {
    const resolution = applySemanticIntentPolicy({
      message: "What did I decide about the September launch?",
      baseline: routeAgentRequest(
        "What did I decide about the September launch?",
        "learn",
      ),
      mode: "learn",
      capabilityCandidates: [memorySearchCapability],
      candidate: candidate({
        intent: "question",
        executionShape: "conversational",
        workKinds: [],
        capabilityQueries: ["September launch decision"],
      }),
    });

    expect(resolution.decision.route).toBe("direct");
    expect(resolution.receipt.matchedCapabilityIds).toEqual([
      "memory.search",
    ]);
  });

  it("persists multi-step work even when coordination was omitted", () => {
    const resolution = applySemanticIntentPolicy({
      message: "Research, implement, verify, and report.",
      baseline: routeAgentRequest("Research, implement, verify, and report."),
      mode: "orchestrate",
      capabilityCandidates: [],
      candidate: candidate({
        intent: "execute",
        executionShape: "multi_step",
        workKinds: ["research", "build", "verify"],
      }),
    });
    expect(resolution.decision.route).toBe("durable_workflow");
  });

  it("rejects unsupported background and multi-step claims", () => {
    const background = applySemanticIntentPolicy({
      message: "Remember my release-note preference.",
      baseline: routeAgentRequest("Remember my release-note preference."),
      mode: "learn",
      capabilityCandidates: [memoryWriteCapability],
      candidate: candidate({
        intent: "unknown",
        executionShape: "background",
        workKinds: [],
      }),
    });
    expect(background.decision.route).toBe("direct");
    expect(background.receipt.matchedCapabilityIds).toEqual([
      "memory.write",
    ]);

    const comparison = applySemanticIntentPolicy({
      message: "Compare these two deployment options.",
      baseline: routeAgentRequest("Compare these two deployment options."),
      mode: "research",
      capabilityCandidates: [],
      candidate: candidate({
        intent: "research",
        executionShape: "multi_step",
        workKinds: ["research"],
      }),
    });
    expect(comparison.decision.route).toBe("direct");
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
