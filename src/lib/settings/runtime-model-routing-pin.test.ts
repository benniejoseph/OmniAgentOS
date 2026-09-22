import { describe, expect, it } from "vitest";

import { runtimeModelRoutingPolicySha256 } from "@/lib/settings/runtime-model-routing-pin";

const base = {
  scope: "agent:atlas:standard",
  source: "tenant_assignment" as const,
  providerId: "openai" as const,
  modelId: "gpt-test",
  tier: "reasoning" as const,
  assignmentId: "assignment-atlas",
  assignmentRevision: 4,
  assignmentConfigurationSha256: "a".repeat(64),
};

describe("runtime model routing policy pin", () => {
  it("is deterministic and fences same-model assignment drift", () => {
    const pinned = runtimeModelRoutingPolicySha256(base);

    expect(runtimeModelRoutingPolicySha256({ ...base })).toBe(pinned);
    expect(runtimeModelRoutingPolicySha256({
      ...base,
      assignmentRevision: 5,
    })).not.toBe(pinned);
    expect(runtimeModelRoutingPolicySha256({
      ...base,
      assignmentConfigurationSha256: "b".repeat(64),
    })).not.toBe(pinned);
    expect(runtimeModelRoutingPolicySha256({
      ...base,
      source: "deployment_environment",
      assignmentId: null,
      assignmentRevision: null,
      assignmentConfigurationSha256: null,
    })).not.toBe(pinned);
  });
});
