import { describe, expect, it } from "vitest";

import { promptQueueCreateRequestSchema } from "@/lib/command/prompt-queue-contracts";

const valid = {
  clientCorrelationId: "offline-correlation-one",
  prompt: "Review the exact queued work.",
  mode: "orchestrate",
  strategy: "direct",
  agentId: "agent.moltbook:1",
  target: {
    threadId: "00000000-0000-4000-8000-000000000001",
    missionId: "00000000-0000-4000-8000-000000000002",
    projectId: "project.launch:1",
    executionTarget: "asael",
  },
};

describe("prompt queue governed target contract", () => {
  it("accepts exactly the identifiers admitted by the governed Agent route", () => {
    expect(promptQueueCreateRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects targets that could be queued but not dispatched", () => {
    expect(promptQueueCreateRequestSchema.safeParse({
      ...valid,
      target: { ...valid.target, threadId: "thread/not-a-uuid" },
    }).success).toBe(false);
    expect(promptQueueCreateRequestSchema.safeParse({
      ...valid,
      target: { ...valid.target, missionId: "mission@cross-route" },
    }).success).toBe(false);
    expect(promptQueueCreateRequestSchema.safeParse({
      ...valid,
      target: { ...valid.target, projectId: "project/invalid" },
    }).success).toBe(false);
    expect(promptQueueCreateRequestSchema.safeParse({
      ...valid,
      agentId: "agent/invalid",
    }).success).toBe(false);
  });
});
