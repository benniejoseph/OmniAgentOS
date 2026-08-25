import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getAgentPerformance } from "@/lib/agents/performance";
import {
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  recordAgentRunFeedback,
} from "@/lib/runs/store";

describe("agent performance", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-agent-performance-"),
    );
  });

  it("projects primary and collaborative outcomes", async () => {
    const scout = await createAgentRun({
      tenantId: "t",
      mode: "research",
      prompt: "research",
      messages: [{ role: "user", content: "research" }],
      agentId: "scout",
      specialistIds: ["sentinel"],
    });
    await completeAgentRun(scout.id, "done");
    await recordAgentRunFeedback(scout.id, { verdict: "useful" }, { tenantId: "t" });
    const forge = await createAgentRun({
      tenantId: "t",
      mode: "execute",
      prompt: "build",
      messages: [{ role: "user", content: "build" }],
      agentId: "forge",
      specialistIds: ["sentinel"],
    });
    await failAgentRun(forge.id, "failed");

    const result = await getAgentPerformance("t");
    expect(result.find((item) => item.agentId === "scout")).toMatchObject({
      primaryAssignments: 1,
      completed: 1,
      completionRate: 1,
      userApprovalRate: 1,
      usefulOutcomes: 1,
    });
    expect(result.find((item) => item.agentId === "sentinel")?.collaborations).toBe(2);
  });
});
