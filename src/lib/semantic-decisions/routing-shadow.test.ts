import { describe, expect, it, vi } from "vitest";

import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SemanticDecisionRuntime } from "@/lib/semantic-decisions/runtime";
import { runRoutingSemanticDecisionShadow } from "@/lib/semantic-decisions/routing-shadow";
import type {
  RoutingShadowChoice,
  SemanticDecisionProvider,
  SemanticDecisionRequest,
} from "@/lib/semantic-decisions/types";
import type { ModelAssignment } from "@/lib/settings/types";
import { recordAiUsageSafely } from "@/lib/usage/ledger";

const assignment: ModelAssignment = {
  id: "assignment-semantic",
  tenantId: "tenant-a",
  actorId: "actor-a",
  scope: "semantic_decision",
  provider: "typesafe",
  modelId: "jev-settings-model",
  allowCrossProviderFallback: false,
  runtimeReadiness: "active",
  runtimeNote: "active",
  contractVersion: "p11.8-model-assignment:1",
  revision: 2,
  configurationSha256: "c".repeat(64),
  validatedAt: "2026-09-18T08:00:00.000Z",
  createdAt: "2026-09-18T07:00:00.000Z",
  updatedAt: "2026-09-18T08:00:00.000Z",
};
const executionScope = createExecutionScope({
  tenantId: "tenant-a",
  initiatingActorId: "actor-a",
  executingPrincipalType: "agent",
  executingPrincipalId: "atlas",
  correlationId: "request-a",
  purpose: "agent.intent.semantic_decision_shadow",
});

function providerWithChoice(choice: RoutingShadowChoice): SemanticDecisionProvider {
  return {
    id: "typesafe",
    async decide<TChoice extends string>(
      _input: SemanticDecisionRequest<TChoice>,
    ) {
      return {
        model: "jev-provider-release-2026-09-18",
        answer: {
          choice: choice as TChoice,
          confidence: 0.8,
          probabilities: {
            direct: choice === "direct" ? 0.8 : 0.1,
            durable_workflow: choice === "durable_workflow" ? 0.8 : 0.1,
            clarify: choice === "clarify" ? 0.8 : 0.1,
          } as Record<TChoice, number>,
        },
        usage: { inputTokens: 30, outputTokens: 5 },
        providerRequestId: "typesafe-request-a",
      };
    },
  };
}

function runtime(provider: SemanticDecisionProvider): SemanticDecisionRuntime {
  return {
    state: "ready",
    providerId: "typesafe",
    model: "jev-settings-model",
    assignment,
    assignmentReceipt: {
      assignmentScope: "semantic_decision",
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentConfigurationSha256: assignment.configurationSha256!,
      credentialSource: "tenant_vault",
    },
    provider,
  };
}

function input() {
  return {
    tenantId: "tenant-a",
    actorId: "actor-a",
    requestId: "request-a",
    message: "Deploy the complete feature and verify it.",
    deterministicFallbackRoute: "durable_workflow" as const,
    observedLiveRoute: "durable_workflow" as const,
    executionScope,
  };
}

function dependencies(resolvedRuntime: SemanticDecisionRuntime | undefined) {
  return {
    resolveRuntime: vi.fn(async () => resolvedRuntime),
    appendEvent: vi.fn(async () => ({
      id: "event-a",
    } as Awaited<ReturnType<typeof appendScopedDomainEvent>>)),
    recordUsage: vi.fn(async () => ({
      id: "usage-a",
    } as Awaited<ReturnType<typeof recordAiUsageSafely>>)),
    now: () => new Date("2026-09-18T09:00:00.000Z"),
    timeoutMs: 100,
  };
}

describe("Jev routing shadow", () => {
  it("records disagreement without influencing the live decision or risk", async () => {
    const deps = dependencies(runtime(providerWithChoice("direct")));

    const receipt = await runRoutingSemanticDecisionShadow(input(), deps);

    expect(receipt).toMatchObject({
      mode: "shadow",
      configuredModel: "jev-settings-model",
      responseModel: "jev-provider-release-2026-09-18",
      providerSuggestion: "direct",
      deterministicFallbackRoute: "durable_workflow",
      observedLiveRoute: "durable_workflow",
      agreesWithDeterministicBaseline: false,
      agreesWithObservedLiveRoute: false,
      liveDecisionInfluenced: false,
      mutationAuthority: "none",
      riskPolicyImpact: "none",
      effectCount: 0,
      outcome: "completed",
      usageRecorded: true,
    });
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "actor-a",
      operation: "semantic_decision",
      provider: "typesafe",
      model: "jev-provider-release-2026-09-18",
      assignmentScope: "semantic_decision",
      assignmentRevision: 2,
      credentialSource: "tenant_vault",
    }));
    expect(deps.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "intent.semantic_decision_shadowed",
      executionScope,
      payload: expect.objectContaining({ liveDecisionInfluenced: false }),
    }));
    expect(JSON.stringify(deps.appendEvent.mock.calls[0])).not.toContain(
      "Deploy the complete feature",
    );
  });

  it("times out within the bounded pilot window and keeps the fallback", async () => {
    const neverProvider: SemanticDecisionProvider = {
      id: "typesafe",
      decide: async () => new Promise(() => undefined),
    };
    const deps = dependencies(runtime(neverProvider));

    const receipt = await runRoutingSemanticDecisionShadow(input(), deps);

    expect(receipt).toMatchObject({
      outcome: "timed_out",
      failureKind: "timeout",
      retryable: true,
      providerSuggestion: null,
      deterministicFallbackRoute: "durable_workflow",
      observedLiveRoute: "durable_workflow",
      liveDecisionInfluenced: false,
    });
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      providerCallCount: 1,
      attemptCount: 1,
      failedAttemptCount: 1,
    }));
  });

  it("does nothing when Settings has not explicitly enrolled the actor", async () => {
    const deps = dependencies(undefined);

    await expect(runRoutingSemanticDecisionShadow(input(), deps))
      .resolves.toBeUndefined();
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.appendEvent).not.toHaveBeenCalled();
  });
});
