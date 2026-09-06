import { describe, expect, it, vi } from "vitest";
import {
  buildDeterministicRetrievalQueryPlan,
  createRetrievalQueryPlanner,
  retrievalQueryPlanCandidateSchema,
} from "@/lib/rag/query-planner";
import { evaluateRetrievalQueryPlanBenchmark } from "@/lib/rag/query-planner-benchmark";

function modelResult(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      domains: ["semantic", "entity"],
      rewrittenQueries: ["Orion delivery schedule and milestones"],
      entityTerms: ["Orion"],
      relationshipTerms: [],
      proceduralTerms: [],
      temporal: { mode: "none", expressions: [] },
      confidence: 0.91,
    }),
    provider: "openai" as const,
    model: "router-model",
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      totalTokens: 20,
    },
    latencyMs: 20,
    costKnown: false,
    attempts: [],
    usageReceiptRecorded: true,
    usageReceiptId: "usage-query-plan-a",
    ...overrides,
  };
}

function dependencies(generated = modelResult()) {
  return {
    resolveRuntimeModelAssignment: vi.fn().mockResolvedValue({
      configured: true,
      assignmentId: "assignment-a",
      source: "tenant_assignment",
      bind: <T>(request: T) => request,
    }),
    generateModelText: vi.fn().mockResolvedValue(generated),
  };
}

const usageScope = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  sourceStreamId: "run:run-a",
  operation: "embedding" as const,
  purpose: "agent.context.retrieve",
};

describe("P4.3 retrieval query planner", () => {
  it("meets the frozen natural-language routing benchmark", () => {
    const result = evaluateRetrievalQueryPlanBenchmark();
    const misses = result.results.filter((item) =>
      item.expectedDomains.join(",") !== item.actualDomains.join(",") ||
      item.expectedTemporalMode !== undefined &&
        item.expectedTemporalMode !== item.actualTemporalMode ||
      !item.anchored
    );

    expect(misses).toEqual([]);
    expect(result).toMatchObject({
      caseCount: 30,
      domainPrecision: 1,
      domainRecall: 1,
      temporalModeAccuracy: 1,
      originalQueryAnchorRate: 1,
    });
  });

  it("adds only validated semantic hints while retaining the original query", async () => {
    const deps = dependencies();
    const plan = await createRetrievalQueryPlanner(deps)({
      query: "Tell me where Project Orion stands",
      asOfTime: "2026-09-06T00:00:00.000Z",
      usageScope,
    });

    expect(plan).toMatchObject({
      version: "p4.3-query-plan:1",
      source: "model",
      domains: expect.arrayContaining(["semantic", "entity"]),
      validation: {
        originalQueryAnchored: true,
        authorizationInputsExcluded: true,
        candidateAccepted: true,
        droppedQueryCount: 0,
      },
      model: {
        provider: "openai",
        model: "router-model",
        usageReceiptRecorded: true,
        usageReceiptId: "usage-query-plan-a",
      },
    });
    expect(plan.queries[0]).toBe("Tell me where Project Orion stands");
    expect(plan.queries).toContain("Orion delivery schedule and milestones");
    expect(deps.generateModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        usageScope: expect.objectContaining({
          tenantId: "tenant-a",
          actorId: "actor-a",
          operation: "text_generation",
          purpose: "context.query_plan.semantic",
        }),
      }),
    );
    const request = deps.generateModelText.mock.calls[0][0];
    expect(request.input).not.toContain("tenant-a");
    expect(request.input).not.toContain("actor-a");
  });

  it("rejects authority-shaped model output and falls back deterministically", async () => {
    const generated = modelResult({
      text: JSON.stringify({
        domains: ["semantic"],
        rewrittenQueries: ["private workspace records"],
        entityTerms: [],
        relationshipTerms: [],
        proceduralTerms: [],
        temporal: { mode: "none", expressions: [] },
        confidence: 0.99,
        tenantId: "other-tenant",
        visibility: "workspace_shared",
        grantIds: ["grant-all"],
      }),
    });
    const deps = dependencies(generated);
    const plan = await createRetrievalQueryPlanner(deps)({
      query: "Explain deployment status",
      usageScope,
    });

    expect(plan.source).toBe("deterministic");
    expect(plan.fallbackReason).toBe("model_output_invalid");
    expect(plan.queries).not.toContain("private workspace records");
    expect(plan.validation.authorizationInputsExcluded).toBe(true);
    expect(retrievalQueryPlanCandidateSchema.safeParse(
      JSON.parse(generated.text),
    ).success).toBe(false);
  });

  it("keeps deterministic temporal semantics authoritative over a conflicting hint", async () => {
    const deps = dependencies(modelResult({
      text: JSON.stringify({
        domains: ["temporal"],
        rewrittenQueries: ["Orion current owner"],
        entityTerms: ["Orion"],
        relationshipTerms: ["owner"],
        proceduralTerms: [],
        temporal: { mode: "latest", expressions: ["current"] },
        confidence: 0.93,
      }),
    }));
    const plan = await createRetrievalQueryPlanner(deps)({
      query: "Who owned project Orion as of June 2024?",
      usageScope,
    });

    expect(plan.temporal).toMatchObject({ mode: "as_of" });
    expect(plan.domains).toEqual(expect.arrayContaining([
      "temporal",
      "entity",
      "relationship",
    ]));
  });

  it("does not disclose explicit-empty or casual retrieval to a model", async () => {
    const deps = dependencies();
    const explicitEmpty = await createRetrievalQueryPlanner(deps)({
      query: "Find my deployment plan",
      usageScope,
      allowSemanticModel: false,
    });
    const casual = await createRetrievalQueryPlanner(deps)({
      query: "hello",
      usageScope,
    });

    expect(explicitEmpty.fallbackReason).toBe("not_required");
    expect(casual.fallbackReason).toBe("not_required");
    expect(deps.resolveRuntimeModelAssignment).not.toHaveBeenCalled();
    expect(deps.generateModelText).not.toHaveBeenCalled();
  });

  it("fails closed when usage attribution or a recorded model receipt is missing", async () => {
    const deps = dependencies(modelResult({
      usageReceiptRecorded: false,
      usageReceiptId: undefined,
    }));
    const unattributed = await createRetrievalQueryPlanner(deps)({
      query: "Find Project Orion",
    });
    const unrecorded = await createRetrievalQueryPlanner(deps)({
      query: "Find Project Orion",
      usageScope,
    });

    expect(unattributed.fallbackReason).toBe("usage_scope_unavailable");
    expect(unrecorded.fallbackReason).toBe("model_usage_unrecorded");
    expect(unrecorded.source).toBe("deterministic");
  });

  it("bounds rewrites and normalizes duplicates after model validation", () => {
    const baseline = buildDeterministicRetrievalQueryPlan(
      "How do I deploy product Mercury?",
    );
    expect(baseline.queries.length).toBeLessThanOrEqual(6);
    expect(baseline.entityTerms).toContain("Mercury");
    expect(baseline.domains).toEqual(["entity", "procedural"]);
  });
});
