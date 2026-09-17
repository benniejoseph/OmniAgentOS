import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import {
  createRunBudgetState,
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
} from "@/lib/runs/budgets";
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
  it("parses the persisted tool-step cap and accepts legacy continuations without it", async () => {
    const store = await import("@/lib/runs/store");
    const capped = store.parseAgentRunContinuation({
      ...continuationFor("exec-capped"),
      maxToolSteps: 12,
    });
    const legacy = store.parseAgentRunContinuation(
      continuationFor("exec-legacy-cap"),
    );

    expect(capped?.maxToolSteps).toBe(12);
    expect(legacy?.maxToolSteps).toBeUndefined();
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-invalid-cap"),
      maxToolSteps: 0,
    })).toBeUndefined();

    const budgetState = createRunBudgetState(DEFAULT_AGENT_RUN_BUDGET_LIMITS, {
      used: { modelTurns: 2, tokens: 18_284 },
    });
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-string-token-budget"),
      budgetState: {
        ...budgetState,
        limits: {
          ...budgetState.limits,
          tokens: String(budgetState.limits.tokens),
        },
        used: {
          ...budgetState.used,
          tokens: String(budgetState.used.tokens),
        },
      },
    })?.budgetState).toMatchObject({
      limits: { tokens: DEFAULT_AGENT_RUN_BUDGET_LIMITS.tokens },
      used: { tokens: 18_284 },
    });
  });

  it("retains only a closed Computer Use target across approval pauses", async () => {
    const store = await import("@/lib/runs/store");
    const local = store.parseAgentRunContinuation({
      ...continuationFor("exec-local-target"),
      computerUseTarget: "local_macos",
    });
    const legacy = store.parseAgentRunContinuation(
      continuationFor("exec-no-target"),
    );

    expect(local?.computerUseTarget).toBe("local_macos");
    expect(legacy?.computerUseTarget).toBeUndefined();
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-invalid-target"),
      computerUseTarget: "prompt_selected_local",
    })).toBeUndefined();
  });

  it("keeps validated continuation token budgets numeric when reading a parked run", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "preserve resume budget",
      messages: [{ role: "user", content: "preserve resume budget" }],
    });
    const budgetState = createRunBudgetState(DEFAULT_AGENT_RUN_BUDGET_LIMITS, {
      used: { modelTurns: 2, tokens: 18_284 },
    });

    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: {
        ...continuationFor("exec-budget-roundtrip"),
        budgetState,
      },
    });

    const found = await store.findAgentRunWaitingForToolApproval(
      "exec-budget-roundtrip",
    );
    expect(found?.continuation?.budgetState).toEqual(budgetState);
    expect(typeof found?.continuation?.budgetState?.limits.tokens).toBe(
      "number",
    );
    expect(typeof found?.continuation?.budgetState?.used.tokens).toBe(
      "number",
    );
  });

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
  }, 30_000);

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
      payload: {
        agentRunId: run.id,
        executionId,
        actorId: run.ownerActorId,
      },
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

  it("binds exactly one immutable agent identity to a run", async () => {
    const store = await import("@/lib/runs/store");
    const {
      buildAgentRunIdentityPinV1,
      buildBuiltInAgentIdentityV1,
      parseAgentRunIdentityPinV1,
    } =
      await import("@/lib/agents/identity-contracts");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const { sourceContractSha256 } = await import("@/lib/sources/contracts");
    const tenantId = "identity-binding";
    const actorId = "actor-1";
    const run = await store.createAgentRun({
      tenantId,
      actorId,
      mode: "orchestrate",
      prompt: "bind identity",
      messages: [{ role: "user", content: "bind identity" }],
      agentId: "atlas",
    });
    const original = buildAgentRunIdentityPinV1({
      runId: run.id,
      identity: buildBuiltInAgentIdentityV1({
        agentId: "atlas",
        tenantId,
        controllerActorId: actorId,
      }),
    });
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: original.principalId,
      correlationId: `run:${run.id}`,
      purpose: "agent.run",
    });
    await store.bindAgentRunExecutionScope(run.id, scope, {
      tenantId,
    });

    await store.appendAgentRunIdentityPin(run.id, original, {
      tenantId,
      executionScope: scope,
    });
    await store.appendAgentRunIdentityPin(run.id, original, {
      tenantId,
      executionScope: scope,
    });
    await expect(
      store.getAgentRunIdentityPin(run.id, { tenantId }),
    ).resolves.toEqual(original);

    const { pinSha256: _pinSha256, ...conflictingBody } = {
      ...original,
      policyPins: original.policyPins.map((policy, index) =>
        index === 0
          ? { ...policy, policySha256: "a".repeat(64) }
          : policy
      ),
    };
    const conflicting = parseAgentRunIdentityPinV1({
      ...conflictingBody,
      pinSha256: sourceContractSha256(conflictingBody),
    });
    await expect(
      store.appendAgentRunIdentityPin(run.id, conflicting, {
        tenantId,
        executionScope: scope,
      }),
    ).rejects.toThrow("already bound to a different event");
  });

  it("binds one metadata-only Loop v2 context authority to a run", async () => {
    const store = await import("@/lib/runs/store");
    const { buildLoopV2ContextBindingV1 } = await import(
      "@/lib/orchestration/loop-v2-context-contract"
    );
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const { sourceContractSha256 } = await import("@/lib/sources/contracts");
    const tenantId = "loop-context-binding";
    const actorId = "actor-1";
    const run = await store.createAgentRun({
      tenantId,
      actorId,
      mode: "orchestrate",
      prompt: "summarize",
      messages: [{ role: "user", content: "summarize" }],
      agentId: "atlas",
    });
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: `run:${run.id}`,
      purpose: "agent.loop.v2.context_text_canary",
    });
    await store.bindAgentRunExecutionScope(run.id, scope, { tenantId });
    const binding = buildLoopV2ContextBindingV1({
      tenantId,
      runId: run.id,
      ownerActorId: actorId,
      agentPrincipalId: "atlas",
      contextScope: "session",
      authoritySha256: sourceContractSha256("session"),
      executionScope: scope,
      querySha256: sourceContractSha256("query"),
      conversationSha256: sourceContractSha256("conversation"),
      contextManifestSha256: sourceContractSha256("manifest"),
      compiledContextSha256: sourceContractSha256("compiled"),
      selectedEvidenceIds: [],
      boundAt: "2026-09-08T00:00:00.000Z",
    });

    await store.appendLoopV2ContextBinding(run.id, binding, {
      tenantId,
      executionScope: scope,
    });
    await store.appendLoopV2ContextBinding(run.id, binding, {
      tenantId,
      executionScope: scope,
    });
    const events = await listStreamEvents(`run:${run.id}`, { tenantId });
    const contextEvents = events.filter((event) =>
      event.type === "run.loop_v2.context_bound"
    );
    expect(contextEvents).toHaveLength(1);
    expect(contextEvents[0].payload).toMatchObject({
      contextScope: "session",
      authorityKind: "conversation",
      selectedItemCount: 0,
    });
    expect(contextEvents[0].payload).not.toHaveProperty("selectedEvidenceIds");

    const {
      bindingSha256: _bindingSha256,
      authorityKind: _authorityKind,
      contextBudgetReceiptSha256: _contextBudgetReceiptSha256,
      selectionSha256: _selectionSha256,
      selectedEvidenceSetSha256: _selectedEvidenceSetSha256,
      selectedItemCount: _selectedItemCount,
      executionScopeSha256: _executionScopeSha256,
      schemaVersion: _schemaVersion,
      policyVersion: _policyVersion,
      ...bindingInput
    } = binding;
    void _bindingSha256;
    void _authorityKind;
    void _contextBudgetReceiptSha256;
    void _selectionSha256;
    void _selectedEvidenceSetSha256;
    void _selectedItemCount;
    void _executionScopeSha256;
    void _schemaVersion;
    void _policyVersion;
    const conflicting = buildLoopV2ContextBindingV1({
      ...bindingInput,
      executionScope: scope,
      selectedEvidenceIds: [],
      boundAt: "2026-09-08T00:01:00.000Z",
    });
    await expect(store.appendLoopV2ContextBinding(run.id, conflicting, {
      tenantId,
      executionScope: scope,
    })).rejects.toThrow("already bound to a different event");
  });

  it("keeps non-terminal run prose out of the long-lived domain event log", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      tenantId: "run-event-privacy",
      mode: "orchestrate",
      prompt: "private prompt",
      messages: [{ role: "user", content: "private prompt" }],
    });
    await store.appendRunEvent(run.id, {
      type: "status",
      label: "Private status label",
      detail: "Private status detail",
    }, { tenantId: "run-event-privacy" });
    await store.appendRunEvent(run.id, {
      type: "tool",
      toolId: "memory.search",
      toolName: "Private tool display name",
      status: "executed",
      summary: "Private tool result summary",
      executionId: "execution-private-prose",
    }, { tenantId: "run-event-privacy" });
    await store.appendRunEvent(run.id, {
      type: "error",
      message: "Private provider failure detail",
    }, { tenantId: "run-event-privacy" });

    const events = await listStreamEvents(`run:${run.id}`, {
      tenantId: "run-event-privacy",
    });
    expect(events).toHaveLength(3);
    expect(events.every((item) => item.payload.schemaVersion === 1)).toBe(true);
    expect(events[0].payload).toMatchObject({
      type: "status",
      labelLength: 20,
      labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      detailSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(events[1].payload).toMatchObject({
      type: "tool",
      toolId: "memory.search",
      status: "executed",
      executionId: "execution-private-prose",
      summarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(events[2].payload).toMatchObject({
      type: "error",
      messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Private status");
    expect(serialized).not.toContain("Private tool");
    expect(serialized).not.toContain("Private provider");
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
