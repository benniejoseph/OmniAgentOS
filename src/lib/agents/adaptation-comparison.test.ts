import { describe, expect, it, vi } from "vitest";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildObservedAgentAdaptationV1, evaluateAgentAdaptationV1, activateAgentAdaptationV1, rollbackAgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";
import { adaptationComparisonSuiteSchema, assertAdaptationComparisonActivation, buildAdaptationComparison, parseAdaptationComparison, scoreAdaptationOutput, type AdaptationComparisonObservation } from "@/lib/agents/adaptation-comparison-contracts";
import { compileAdaptationComparison, runAdaptationComparison } from "@/lib/agents/adaptation-comparison";
import type { RuntimeModelResolution } from "@/lib/settings/runtime-models";
import type { ModelGenerationResult, ModelTextRequest } from "@/lib/models/types";

const owner = { tenantId: "tenant-one", actorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const clock = "2026-10-12T12:00:00.000Z";
const identity = buildBuiltInAgentIdentityV1({ agentId: "scout", tenantId: owner.tenantId, controllerActorId: owner.canonicalActorId });
const adaptation = evaluateAgentAdaptationV1(buildObservedAgentAdaptationV1({ tenantId: owner.tenantId, ownerActorId: owner.canonicalActorId, agentId: "scout", definitionVersion: identity.definition.definitionVersion,
  evidence: [{ evidenceId: "feedback:one", kind: "run_feedback", sourceId: "run:one", sourceSha256: "a".repeat(64), verdict: "needs_work", groundingStatus: "verified", observedAt: clock }], guidance: "Always finish with a next step.", confidence: .95, observedAt: clock }), identity.definition.definitionVersion, clock);
const suite = adaptationComparisonSuiteSchema.parse({ cases: ["Summarize project Alpha.", "Explain project Beta.", "Outline project Gamma."].map((task, i) => ({ id: `case-${i}`, task, assertions: { allOf: ["Next step:"], noneOf: ["secret"], minLength: 5, maxLength: 100 } })) });
const runtimePin = { provider: "openai" as const, model: "test-model", tier: "fast" as const, source: "deployment_environment" as const, assignmentId: null, assignmentRevision: null, assignmentConfigurationSha256: null };
const compiled = compileAdaptationComparison({ identity, adaptation, suite, active: [], runtimePin, clock });
const observation = (output: string, costUsd: number | null = .001): AdaptationComparisonObservation => ({ status: "completed", output, costUsd, failure: null });
function result(baseline = ["Old", "Old", "Old"], candidate = ["Next step: go", "Next step: go", "Next step: go"]) {
  return buildAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", adaptationId: adaptation.adaptationId, suite, pins: compiled.pins, observations: suite.cases.map((row, i) => ({ caseId: row.id, baseline: observation(baseline[i]), candidate: observation(candidate[i]) })), completedAt: clock });
}
function runtime(): RuntimeModelResolution {
  return { scope: "main_agent", source: "deployment_environment", configured: true, provider: "openai", model: "test-model", allowCrossProviderFallback: false, warnings: [], reason: "fixture", usageReceipt: {}, bind: <T extends ModelTextRequest>(request: T) => request, withProviderApiKey: async (_provider, operation) => operation(undefined) };
}
function generated(output: string): ModelGenerationResult {
  return { text: output, provider: "openai", model: "test-model", costKnown: false, latencyMs: 1, attempts: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 } };
}
describe("measured text adaptation", () => {
  it("requires independent bounded owner tasks and consistent assertions", () => {
    expect(adaptationComparisonSuiteSchema.safeParse({ cases: [suite.cases[0], suite.cases[0], suite.cases[2]] }).success).toBe(false);
    expect(adaptationComparisonSuiteSchema.safeParse({ cases: suite.cases.slice(1) }).success).toBe(false);
    expect(adaptationComparisonSuiteSchema.safeParse({ cases: suite.cases.map((row) => ({ ...row, assertions: { ...row.assertions, noneOf: ["next"] } })) }).success).toBe(false);
    expect(scoreAdaptationOutput(suite.cases[0], observation("NEXT STEP: go"))).toBe(true);
    expect(scoreAdaptationOutput(suite.cases[0], observation("Next step: secret"))).toBe(false);
  });
  it("ties never pass; any regression prevents activation even with more passing tasks", () => {
    expect(result(["Old", "Old", "Old"], ["Old", "Old", "Old"]).verdict).toBe("no_change");
    const regression = result(["Next step: go", "Old", "Old"], ["Old", "Next step: go", "Next step: go"]);
    expect(regression.verdict).toBe("regressed");
    expect(() => assertAdaptationComparisonActivation(regression, compiled.pins, Date.parse(clock))).toThrow(/added passing/);
  });
  it("rejects forged scores, stale pins, expired results, and legacy new activation", () => {
    const improved = result();
    expect(() => parseAdaptationComparison({ ...improved, candidatePassed: 0 })).toThrow();
    expect(() => assertAdaptationComparisonActivation(improved, { ...compiled.pins, baselineGuidanceSha256: "f".repeat(64) }, Date.parse(clock))).toThrow(/changed/);
    expect(() => assertAdaptationComparisonActivation(improved, compiled.pins, Date.parse(clock) + 86400001)).toThrow(/expired/);
    expect(() => activateAgentAdaptationV1(adaptation, 1, clock)).toThrow(/comparison/);
    const active = activateAgentAdaptationV1({ ...adaptation, comparison: improved }, 1, clock);
    const { comparison: _comparison, ...legacyActive } = active;
    expect(rollbackAgentAdaptationV1(legacyActive, clock).state).toBe("rolled_back");
  });
  it("executes both actual compiled variants on the same tasks, clock, model and token budget without any tool path", async () => {
    const generate = vi.fn(async (request: ModelTextRequest) => generated(request.instructions === compiled.candidate ? "Next step: go" : "Old"));
    const measured = await runAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", owner, adaptationId: adaptation.adaptationId, compiled, runtime: runtime() }, { generate, now: () => clock });
    expect(generate).toHaveBeenCalledTimes(6);
    expect(measured.verdict).toBe("improved");
    expect(measured.costUsd).toBeNull();
    for (const task of suite.cases) {
      const requests = generate.mock.calls.map(([request]) => request).filter((request) => request.input === task.task);
      expect(requests).toHaveLength(2);
      expect(new Set(requests.map((request) => request.instructions))).toEqual(new Set([compiled.baseline, compiled.candidate]));
      for (const request of requests) {
        expect(request).toMatchObject({ maxAttempts: 1, maxOutputTokens: 1000, allowCrossProviderFallback: false, allowedProviders: ["openai"] });
        expect(request).not.toHaveProperty("tools");
        expect(request.input).not.toContain("allOf");
      }
    }
    expect(compiled.baseline).toContain(identity.definition.name);
    expect(compiled.candidate).toContain(adaptation.effect.guidance);
    expect(compiled.baseline).not.toContain(adaptation.effect.guidance);
    expect(compiled.pins.environment).toBe("text_only_no_tools_memory_or_retrieval");
  });
  it("aborts after the first provider failure and retains an incomplete, unknown-cost result", async () => {
    const generate = vi.fn().mockResolvedValueOnce(generated("Next step: go")).mockRejectedValue(new Error("private provider detail"));
    const measured = await runAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", owner, adaptationId: adaptation.adaptationId, compiled, runtime: runtime() }, { generate, now: () => clock });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(measured.verdict).toBe("incomplete");
    expect(measured.results[1].baseline.status).toBe("not_run");
    expect(JSON.stringify(measured)).not.toContain("private provider detail");
    expect(measured.costUsd).toBeNull();
  });
  it("refuses provider/model drift and pre-aborted requests", async () => {
    const generate = vi.fn(async () => ({ ...generated("Next step: go"), model: "other-model" }));
    const measured = await runAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", owner, adaptationId: adaptation.adaptationId, compiled, runtime: runtime() }, { generate, now: () => clock });
    expect(measured.verdict).toBe("incomplete"); expect(generate).toHaveBeenCalledTimes(1);
    const stopped = await runAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", owner, adaptationId: adaptation.adaptationId, compiled, runtime: runtime(), abortSignal: AbortSignal.abort() }, { generate, now: () => clock });
    expect(stopped.verdict).toBe("incomplete"); expect(generate).toHaveBeenCalledTimes(1);
  });
});
