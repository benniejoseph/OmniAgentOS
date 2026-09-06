import { describe, expect, it } from "vitest";
import { workflowDynamicPlanJsonSchema } from "@/lib/workflows/planner";

describe("workflow planner JSON contract", () => {
  it("matches the strict non-empty binding constraints enforced after generation", () => {
    const properties = workflowDynamicPlanJsonSchema.properties;
    const nodes = properties.nodes;
    const nodeProperties = nodes.items.properties;
    const bindingProperties = nodeProperties.inputBindings.items.properties;

    expect(nodes).toMatchObject({ minItems: 3, maxItems: 18 });
    expect(nodeProperties.id).toMatchObject({ minLength: 1 });
    expect(nodeProperties.label).toMatchObject({ minLength: 1 });
    expect(bindingProperties.dependencyNodeId).toMatchObject({
      minLength: 1,
      maxLength: 120,
    });
    expect(bindingProperties.targetToolId).toMatchObject({
      minLength: 1,
      maxLength: 240,
    });
    expect(bindingProperties.targetPath).toMatchObject({
      minLength: 1,
      maxLength: 500,
    });
    expect(bindingProperties.artifactName).toMatchObject({ maxLength: 160 });
    expect(properties.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });
});
