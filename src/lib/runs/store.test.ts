import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import { publicAgentRun } from "@/lib/runs/public";
import type { AgentRunContinuation } from "@/lib/runs/types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-runs-"));
  delete process.env.DATABASE_URL;
});

function continuationFor(executionId: string): AgentRunContinuation {
  return {
    conversationItems: [{ role: "user", content: "test" }],
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
    await store.completeAgentRun(run.id, "resumed safely");
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

  it("fails an interrupted resume without replaying approved side effects", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "resume safely",
      messages: [{ role: "user", content: "resume safely" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor("exec-interrupted"),
    });
    expect(await store.markAgentRunResuming(run.id)).toBe(true);
    expect(
      await store.repairStuckAgentRuns({
        tenantId: "default",
        staleAfterMs: -1,
      }),
    ).toBe(1);

    await expect(store.getAgentRun(run.id)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/side effects were not replayed/i),
      continuation: undefined,
    });
  });

  it("fails the linked mission when a durable resume was interrupted", async () => {
    const tenantId = "resume-mission";
    const actorId = "tester";
    const store = await import("@/lib/runs/store");
    const missions = await import("@/lib/missions/store");
    const missionRuntime = await import("@/lib/missions/runtime");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    const mission = await missions.createMission({
      tenantId,
      actorId,
      title: "Resume safely",
      objective: "Finish only once after approval.",
      sourceKey: "resume-interrupted-test",
    });
    const task = await missions.ensureMissionTask(mission.id, {
      sourceKey: "resume-interrupted-task",
      title: "Resume the approved run",
    }, { tenantId, actorId });
    const run = await store.createAgentRun({
      tenantId,
      mode: "orchestrate",
      prompt: "resume safely",
      messages: [{ role: "user", content: "resume safely" }],
    });
    await missionRuntime.attachMissionExecutor({
      taskId: task.id,
      executorType: "agent_run",
      executorId: run.id,
      status: "running",
    }, { tenantId, actorId });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: {
        ...continuationFor("exec-mission-interrupted"),
        context: {
          tenantId,
          actorId,
          role: "operator",
        },
      },
    });
    expect(await store.markAgentRunResuming(run.id)).toBe(true);

    const result = await resumeQueue.processAgentResumeQueue({
      tenantId,
      limit: 1,
    });

    expect(result.completed).toBe(1);
    await expect(store.getAgentRun(run.id, { tenantId })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/side effects were not replayed/i),
    });
    await expect(
      missions.getMissionDetail(mission.id, { tenantId, actorId }),
    ).resolves.toMatchObject({
      mission: { status: "failed" },
      tasks: [expect.objectContaining({ status: "failed" })],
      attempts: [expect.objectContaining({ status: "failed" })],
    });
  });

  it("pre-arms durable resume work and preserves old waiting runs", async () => {
    const store = await import("@/lib/runs/store");
    const queue = await import("@/lib/operations/job-queue");
    const waiting = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "wait durably",
      messages: [{ role: "user", content: "wait durably" }],
    });
    const parked = await store.markAgentRunWaitingForApproval(waiting.id, {
      response: "partial",
      continuation: continuationFor("exec-durable"),
    });
    expect(parked.parked).toBe(true);
    expect(parked.resumeJob).toMatchObject({
      type: "agent.resume",
      status: "queued",
      payload: {
        agentRunId: waiting.id,
        executionId: "exec-durable",
      },
    });

    for (let index = 0; index < 105; index += 1) {
      const newer = await store.createAgentRun({
        mode: "orchestrate",
        prompt: `newer ${index}`,
        messages: [{ role: "user", content: `newer ${index}` }],
      });
      await store.completeAgentRun(newer.id, "done");
    }

    await expect(store.getAgentRun(waiting.id)).resolves.toMatchObject({
      status: "waiting_approval",
      continuation: {
        pendingToolCall: { executionId: "exec-durable" },
      },
    });
    expect(
      (
        await queue.listOperationJobs(500, {
          tenantId: "default",
        })
      ).some(
        (job) =>
          job.type === "agent.resume" &&
          job.payload.executionId === "exec-durable",
      ),
    ).toBe(true);
  });

  it("defers unresolved approval jobs without consuming retry attempts", async () => {
    const store = await import("@/lib/runs/store");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    const queue = await import("@/lib/operations/job-queue");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "wait for approval",
      messages: [{ role: "user", content: "wait for approval" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor("exec-unresolved"),
    });

    const result = await resumeQueue.processAgentResumeQueue({
      tenantId: "default",
      limit: 10,
    });
    expect(result.deferred).toBeGreaterThanOrEqual(1);
    const job = (
      await queue.listOperationJobs(500, { tenantId: "default" })
    ).find((item) => item.payload.executionId === "exec-unresolved");
    expect(job).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("defers a pre-armed resume job until its continuation write is visible", async () => {
    const store = await import("@/lib/runs/store");
    const queue = await import("@/lib/operations/job-queue");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "pre-arm crash window",
      messages: [{ role: "user", content: "pre-arm crash window" }],
    });
    const executionId = "exec-prearm-window";
    const job = await queue.enqueueOperationJob({
      tenantId: "default",
      type: "agent.resume",
      dedupeKey: queue.getAgentResumeJobDedupeKey(executionId),
      payload: { agentRunId: run.id, executionId },
    });

    const result = await resumeQueue.processAgentResumeQueue({
      tenantId: "default",
      limit: 10,
    });

    expect(result.deferred).toBeGreaterThanOrEqual(1);
    await expect(
      queue.listOperationJobs(500, { tenantId: "default" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: job.id,
          status: "queued",
          attempt: 0,
        }),
      ]),
    );
  });

  it("keeps operator cancellation terminal when late work tries to complete", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "cancel authoritatively",
      messages: [{ role: "user", content: "cancel authoritatively" }],
    });

    await expect(store.cancelAgentRun(run.id)).resolves.toBe(true);
    await expect(
      store.completeAgentRun(run.id, "late completion"),
    ).resolves.toBe(false);
    await expect(store.failAgentRun(run.id, "late failure")).resolves.toBe(
      false,
    );
    await expect(store.getAgentRun(run.id)).resolves.toMatchObject({
      status: "canceled",
      error: "Canceled by the operator.",
    });
  });

  it("keeps completed response text out of the long-lived domain event log", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "privacy check",
      messages: [{ role: "user", content: "privacy check" }],
    });
    await store.appendRunEvent(run.id, {
      type: "done",
      response: "sensitive completed response",
    });

    const [event] = await listStreamEvents(`run:${run.id}`);
    expect(event.payload).toMatchObject({
      type: "done",
      responseLength: 28,
    });
    expect(event.payload).not.toHaveProperty("response");
    expect(event.payload.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists reversible outcome feedback and returns recent correction guidance", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      tenantId: "feedback",
      mode: "research",
      prompt: "compare options",
      messages: [{ role: "user", content: "compare options" }],
      agentId: "scout",
    });
    await store.completeAgentRun(run.id, "comparison");
    await expect(
      store.recordAgentRunFeedback(
        run.id,
        {
          verdict: "needs_work",
          correction: "  Lead with the recommendation and verify every source.  ",
        },
        { tenantId: "feedback" },
      ),
    ).resolves.toMatchObject({
      feedback: {
        verdict: "needs_work",
        correction: "Lead with the recommendation and verify every source.",
      },
    });
    await expect(
      store.getAgentFeedbackGuidance("scout", { tenantId: "feedback" }),
    ).resolves.toEqual([
      "Lead with the recommendation and verify every source.",
    ]);
    await expect(
      store.recordAgentRunFeedback(
        run.id,
        { verdict: "useful" },
        { tenantId: "feedback" },
      ),
    ).resolves.toMatchObject({ feedback: { verdict: "useful" } });
  });

  it("redacts persisted run text and hides resume internals from API records", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      messages: [
        { role: "user", content: "password=super-secret-value" },
      ],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "Authorization: Bearer anothersecretvalue123",
      continuation: continuationFor("exec-private"),
    });

    const stored = await store.getAgentRun(run.id);
    expect(stored?.prompt).toContain("Bearer [redacted]");
    expect(stored?.messages[0]?.content).toBe("password=[redacted]");
    expect(stored?.response).toContain("Bearer [redacted]");
    expect(publicAgentRun(stored!)).not.toHaveProperty("continuation");
    expect(publicAgentRun(stored!)).not.toHaveProperty("messages");
    expect(publicAgentRun(stored!).waitingApproval).toMatchObject({
      executionId: "exec-private",
      toolId: "http.request",
    });
  });
});
