import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentRunContinuation } from "@/lib/runs/types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-runs-"));
  delete process.env.DATABASE_URL;
});

function continuationFor(executionId: string): AgentRunContinuation {
  return {
    previousResponseId: "resp_1",
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_1",
      toolId: "http.request",
      toolName: "HTTP Request",
      riskLevel: 2,
      executionId,
    },
    context: { tenantId: "default", actorId: "tester", role: "operator" },
    createdAt: new Date().toISOString(),
  };
}

describe("agent run approval continuations (file mode)", () => {
  it("pauses, finds by execution id, and resumes exactly once", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "do the thing",
      messages: [{ role: "user", content: "do the thing" }],
    });

    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor("exec-123"),
    });

    const found = await store.findAgentRunWaitingForToolApproval("exec-123");
    expect(found?.id).toBe(run.id);
    expect(found?.status).toBe("waiting_approval");
    expect(found?.continuation?.pendingToolCall.executionId).toBe("exec-123");

    // Only the first claim transitions; a concurrent second approval loses.
    expect(await store.markAgentRunResuming(run.id)).toBe(true);
    expect(await store.markAgentRunResuming(run.id)).toBe(false);
  });

  it("clears the continuation when the run reaches a terminal state", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "another",
      messages: [{ role: "user", content: "another" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor("exec-456"),
    });
    await store.completeAgentRun(run.id, "final answer");

    const after = await store.getAgentRun(run.id);
    expect(after?.status).toBe("completed");
    expect(after?.continuation).toBeUndefined();
    expect(await store.findAgentRunWaitingForToolApproval("exec-456")).toBeUndefined();
  });
});
