import { describe, expect, it } from "vitest";
import {
  buildHarnessRuleProposal,
  buildMinimizedReplayCase,
  classifyEvaluationFailure,
  failureClusterFingerprint,
} from "@/lib/evaluations/failure-feedback";
import type { EvalCaseDefinition } from "@/lib/evaluations/types";

const evalCase: EvalCaseDefinition = {
  id: "workflow.dynamic_planner",
  name: "Dynamic planner",
  description: "Plans a bounded workflow.",
  type: "workflow",
  input: {
    goal: "private fixture value",
    credentials: { token: "must-not-survive" },
  },
  expected: { validDag: true, persisted: true },
  governance: {
    safetyMode: "synthetic",
    riskLevel: 1,
    writesToDatabase: true,
    cleanup: "self_cleaning",
    production: {
      allowedByDefault: true,
      requiresAdmin: false,
      requiresMutationApproval: false,
    },
    notes: [],
  },
};

describe("evaluation failure feedback", () => {
  it("classifies bounded failure categories deterministically", () => {
    expect(classifyEvaluationFailure({ error: "Request timed out", output: undefined })).toBe("timeout");
    expect(classifyEvaluationFailure({ error: "Zod too_small schema validation", output: undefined })).toBe("schema_validation");
    expect(classifyEvaluationFailure({ error: "Cross-tenant isolation check failed", output: undefined })).toBe("isolation");
    expect(classifyEvaluationFailure({ error: "Exact output formatting instruction failed", output: undefined })).toBe("instruction_contract");
  });

  it("minimizes replay data to shapes, keys, and digests", () => {
    const replay = buildMinimizedReplayCase({
      suite: "release",
      evalCase,
      result: {
        error: "Zod schema validation rejected secret-value-123",
        output: { nested: { bearerToken: "also-private" } },
      },
    });
    const serialized = JSON.stringify(replay);

    expect(replay.failureCategory).toBe("schema_validation");
    expect(replay.expectedKeys).toEqual(["persisted", "validDag"]);
    expect(replay.replay.mutationAuthority).toBe("not_inherited");
    expect(serialized).not.toContain("private fixture value");
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("also-private");
    expect(serialized).not.toContain("secret-value-123");
  });

  it("creates stable review-only harness proposals", () => {
    const replay = buildMinimizedReplayCase({
      suite: "release",
      evalCase,
      result: { error: "Zod schema validation failed", output: undefined },
    });
    const proposal = buildHarnessRuleProposal(replay);

    expect(failureClusterFingerprint(replay)).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal).toMatchObject({
      schemaVersion: 1,
      kind: "tool_contract",
      reviewRequired: true,
      automaticApplication: false,
      change: { operation: "tighten_tool_contract" },
    });
  });
});
