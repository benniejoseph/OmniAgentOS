import { describe, expect, it, vi } from "vitest";

import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import {
  compileAgentAdaptationProposalEvidence,
  proposeAgentAdaptation,
  type AdaptationProposalDependencies,
} from "@/lib/agents/adaptation-proposals";
import type { AgentAdaptationProposalEvidenceObservation } from "@/lib/agents/adaptation-proposal-store";
import type { ModelGenerationResult, ModelTextRequest } from "@/lib/models/types";
import type { RuntimeModelResolution } from "@/lib/settings/runtime-models";

const owner = Object.freeze({
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
});
const scout = buildBuiltInAgentIdentityV1({
  agentId: "scout",
  tenantId: owner.tenantId,
  controllerActorId: owner.canonicalActorId,
});
const sentinel = buildBuiltInAgentIdentityV1({
  agentId: "sentinel",
  tenantId: owner.tenantId,
  controllerActorId: owner.canonicalActorId,
});

describe("proactive Sentinel-reviewed Agent adaptations", () => {
  it("keeps only exact-scope, exact-definition bounded evidence across all sources", () => {
    const exact = [
      observation("run_feedback", "run-one", "needs_work", 4),
      observation("project_artifact", "artifact-one", "needs_work", 3),
      observation("delegated_task", "task-one", "useful", 2),
      observation("scheduled_trigger", "schedule-one", "needs_work", 1),
    ];
    const compiled = compileAgentAdaptationProposalEvidence({
      owner,
      agentId: "scout",
      definitionVersion: scout.definition.definitionVersion,
      observations: [
        ...exact,
        { ...observation("run_feedback", "wrong-actor", "needs_work", 5), ownerActorId: "actor:other" },
        { ...observation("run_feedback", "wrong-version", "needs_work", 5), definitionVersion: 999 },
        { ...observation("run_feedback", "wrong-agent", "needs_work", 5), agentId: "forge" },
      ],
    });

    expect(compiled?.evidence).toHaveLength(4);
    expect(compiled?.evidence.map((item) => item.kind).sort()).toEqual([
      "delegated_task",
      "project_artifact",
      "run_feedback",
      "scheduled_trigger",
    ]);
    expect(compiled?.evidence.map((item) => item.sourceId)).not.toContain("wrong-actor");
    expect(compiled?.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates only an observed owner-review candidate with exact Sentinel pins", async () => {
    const dependencies = proposalDependencies();

    const result = await proposeAgentAdaptation({
      owner,
      agentId: "scout",
    }, dependencies);

    expect(result.status).toBe("proposed");
    expect(dependencies.persistProposal).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(dependencies.persistProposal).mock.calls[0]![0].adaptation;
    expect(persisted).toMatchObject({
      state: "observed",
      lifecycleRevision: 0,
      evaluation: null,
      activationVersion: null,
      effect: {
        authorityImpact: "none",
        proposalReview: {
          targetIdentity: {
            agentId: "scout",
            definitionVersion: scout.definition.definitionVersion,
          },
          sentinelRuntime: {
            agentId: "sentinel",
            provider: "openai",
            model: "gpt-5.5",
            tier: "reasoning",
            assignmentId: "assignment-verifier",
            assignmentRevision: 7,
          },
          authorityImpact: "none",
        },
      },
    });
    expect(dependencies.recordOutcome).not.toHaveBeenCalled();
  });

  it("fails closed when the exact target identity drifts before persistence", async () => {
    const dependencies = proposalDependencies();
    const changedScout = {
      ...scout,
      definition: {
        ...scout.definition,
        definitionVersion: scout.definition.definitionVersion + 1,
        definitionSha256: "f".repeat(64),
      },
    };
    vi.mocked(dependencies.resolveIdentity)
      .mockReset()
      .mockResolvedValueOnce(scout)
      .mockResolvedValueOnce(sentinel)
      .mockResolvedValueOnce(changedScout)
      .mockResolvedValueOnce(sentinel);

    const result = await proposeAgentAdaptation({
      owner,
      agentId: "scout",
    }, dependencies);

    expect(result.status).toBe("identity_drifted");
    expect(dependencies.persistProposal).not.toHaveBeenCalled();
    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "identity_drifted" }),
    );
  });

  it("fails closed when the configured Sentinel runtime drifts before persistence", async () => {
    const dependencies = proposalDependencies();
    vi.mocked(dependencies.resolveRuntimeModel)
      .mockReset()
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce({ ...runtime(), model: "gpt-5.6-sol" });

    const result = await proposeAgentAdaptation({
      owner,
      agentId: "scout",
    }, dependencies);

    expect(result.status).toBe("runtime_drifted");
    expect(dependencies.persistProposal).not.toHaveBeenCalled();
    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "runtime_drifted" }),
    );
  });

  it("records a content-free failure and creates no proposal when the model fails", async () => {
    const dependencies = proposalDependencies();
    vi.mocked(dependencies.generateStructured).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    const result = await proposeAgentAdaptation({
      owner,
      agentId: "scout",
    }, dependencies);

    expect(result.status).toBe("model_failed");
    expect(dependencies.persistProposal).not.toHaveBeenCalled();
    expect(dependencies.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "model_failed",
        detailSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(vi.mocked(dependencies.recordOutcome).mock.calls))
      .not.toContain("provider unavailable");
  });

  it("does not call a model again for an evidence set already under owner review", async () => {
    const dependencies = proposalDependencies();
    vi.mocked(dependencies.hasEvidenceSet).mockResolvedValueOnce(true);

    const result = await proposeAgentAdaptation({ owner, agentId: "scout" }, dependencies);

    expect(result.status).toBe("duplicate");
    expect(dependencies.generateStructured).not.toHaveBeenCalled();
    expect(dependencies.persistProposal).not.toHaveBeenCalled();
  });
});

function proposalDependencies(): AdaptationProposalDependencies {
  const generated = [
    modelResult(JSON.stringify({
      guidance: "Before finalizing, state which evidence supports each material claim.",
      confidence: 0.92,
      evidenceIds: ["run-feedback:run-one"],
      authorityImpact: "none",
    })),
    modelResult(JSON.stringify({
      verdict: "passed",
      score: 0.9,
      findings: [
        "evidence_bound",
        "definition_bound",
        "non_authority",
        "measurable",
      ],
    })),
  ];
  const identities = [scout, sentinel, scout, sentinel];
  return {
    resolveIdentity: vi.fn(async () => identities.shift() || sentinel),
    resolveRuntimeModel: vi.fn(async () => runtime()),
    generateStructured: vi.fn(async () => generated.shift() || modelResult("{}")),
    loadEvidence: vi.fn(async () => [
      observation("run_feedback", "run-one", "needs_work", 1),
    ]),
    readActiveGuidance: vi.fn(async () => []),
    hasEvidenceSet: vi.fn(async () => false),
    persistProposal: vi.fn(async () => "inserted" as const),
    recordOutcome: vi.fn(async () => ({ id: "event" }) as never),
    now: vi.fn(() => "2026-09-22T10:00:00.000Z"),
  };
}

function observation(
  kind: AgentAdaptationProposalEvidenceObservation["evidence"]["kind"],
  sourceId: string,
  verdict: "useful" | "needs_work",
  minute: number,
): AgentAdaptationProposalEvidenceObservation {
  return Object.freeze({
    tenantId: owner.tenantId,
    ownerActorId: owner.canonicalActorId,
    agentId: "scout",
    definitionVersion: scout.definition.definitionVersion,
    evidence: Object.freeze({
      evidenceId: `${kind.replaceAll("_", "-")}:${sourceId}`,
      kind,
      sourceId,
      sourceSha256: "a".repeat(64),
      verdict,
      groundingStatus: verdict === "useful" ? "verified" : "not_required",
      observedAt: `2026-09-22T09:${String(minute).padStart(2, "0")}:00.000Z`,
    }),
    summary: verdict === "useful"
      ? "This governed outcome was accepted."
      : "This governed outcome needs a narrower evidence-bound response.",
  });
}

function runtime(): RuntimeModelResolution {
  return {
    scope: "verifier",
    source: "tenant_assignment",
    configured: true,
    assignmentId: "assignment-verifier",
    assignmentRevision: 7,
    assignmentConfigurationSha256: "c".repeat(64),
    provider: "openai",
    model: "gpt-5.5",
    allowCrossProviderFallback: false,
    warnings: [],
    reason: "Configured verifier route.",
    usageReceipt: {
      assignmentScope: "verifier",
      assignmentId: "assignment-verifier",
      assignmentRevision: 7,
      assignmentConfigurationSha256: "c".repeat(64),
      credentialSource: "tenant_vault",
    },
    bind<TRequest extends ModelTextRequest>(request: TRequest) {
      return request;
    },
    withProviderApiKey: async (_provider, operation) => operation(undefined),
  };
}

function modelResult(text: string): ModelGenerationResult {
  return {
    text,
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      totalTokens: 20,
    },
    latencyMs: 10,
    costKnown: false,
    attempts: [],
  };
}
