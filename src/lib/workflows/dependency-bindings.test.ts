import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowNodeInputBindings,
  resolveWorkflowToolInputBindings,
  safeBindingTargetPath,
} from "@/lib/workflows/dependency-bindings";
import type { WorkflowNodeInputV1 } from "@/lib/workflows/node-contract";

const nodeInput: WorkflowNodeInputV1 = {
  schemaVersion: 1,
  nodeId: "search-follow-up",
  objective: "Search for the dependency conclusion.",
  task: "Use the dependency artifact as the search query.",
  executor: "tool",
  grants: {
    toolIds: ["knowledge.search"],
    connectorTargets: [],
    policy: "auto",
    riskLevel: 0,
  },
  inputBindings: [{
    dependencyNodeId: "analyze",
    targetToolId: "knowledge.search",
    targetPath: "/query",
    artifactName: "conclusion",
  }],
  dependencies: [{
    nodeId: "analyze",
    executionId: "execution-analyze",
    outputSha256: "a".repeat(64),
    artifacts: [{
      name: "conclusion",
      kind: "analysis",
      content: "Use the typed upstream conclusion.",
      evidenceIds: ["model-receipt-1"],
    }],
  }],
  acceptanceCriteria: ["The upstream conclusion is searched."],
  expectedOutputs: ["search result"],
  limits: { maxToolCalls: 1, maxModelCalls: 0, maxOutputChars: 6_000 },
};

describe("workflow dependency output bindings", () => {
  it("resolves only a declared typed dependency artifact into a safe tool field", () => {
    expect(resolveWorkflowToolInputBindings({
      input: { query: "static fallback", limit: 5 },
      nodeInput,
      toolId: "knowledge.search",
    })).toEqual({
      query: "Use the typed upstream conclusion.",
      limit: 5,
    });
  });

  it("drops undeclared, duplicate, and security-sensitive binding targets", () => {
    const bindings = normalizeWorkflowNodeInputBindings({
      dependencyNodeIds: ["analyze"],
      toolIds: ["knowledge.search"],
      bindings: [
        nodeInput.inputBindings[0],
        nodeInput.inputBindings[0],
        { ...nodeInput.inputBindings[0], targetPath: "/url" },
        { ...nodeInput.inputBindings[0], dependencyNodeId: "undeclared" },
      ],
    });
    expect(bindings).toEqual([nodeInput.inputBindings[0]]);
    expect(safeBindingTargetPath("/body/message")).toBe(true);
    expect(safeBindingTargetPath("/headers/authorization")).toBe(false);
    expect(safeBindingTargetPath("/body/__proto__/polluted")).toBe(false);
  });

  it("fails closed when the named artifact is missing", () => {
    expect(() => resolveWorkflowToolInputBindings({
      input: { query: "static fallback" },
      nodeInput: {
        ...nodeInput,
        inputBindings: [{ ...nodeInput.inputBindings[0], artifactName: "missing" }],
      },
      toolId: "knowledge.search",
    })).toThrow("no matching typed artifact");
  });
});
