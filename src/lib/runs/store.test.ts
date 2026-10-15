import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import type { AgentEvent, AgentHarnessEvent } from "@/lib/orchestration/types";
import {
  createRunBudgetState,
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
} from "@/lib/runs/budgets";
import { publicAgentRun } from "@/lib/runs/public";
import { MAX_DEFERRED_TOOL_CALL_HASHES, type AgentRunContinuation } from "@/lib/runs/types";
import { createRunToolRecovery } from "@/lib/orchestration/tool-recovery";
import { localComputerFailureMetadata } from "@/lib/local-computer/command-failure";

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
  it("parks bounded refusal state with its exact owner and rejects corrupt recovery metadata", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({ mode: "orchestrate", prompt: "Recover the refused action",
      messages: [{ role: "user", content: "Recover the refused action" }] });
    const tracker = createRunToolRecovery({ tenantId: "default", actorId: "tester", runId: run.id });
    tracker.observe({ record: {
      id: "exec-real-refusal", tenantId: "default", actorId: "tester", toolId: "local.macos.click",
      toolName: "Click", status: "failed", dryRun: false, riskLevel: 1, approvalRequired: false,
      input: { snapshotRevision: "a".repeat(64), x: 10, y: 20 },
      output: { localComputerFailure: localComputerFailureMetadata("stale_observation") },
      createdAt: new Date().toISOString(),
    }, result: null });
    const toolRecovery = tracker.snapshot();
    const continuation = { ...continuationFor("exec-recovery-approval"), toolRecovery };
    await store.markAgentRunWaitingForApproval(run.id, { response: "Waiting", continuation });
    const saved = await store.findAgentRunWaitingForToolApproval("exec-recovery-approval");
    expect(saved?.continuation?.toolRecovery).toEqual(toolRecovery);
    expect(store.parseAgentRunContinuation(continuationFor("legacy-recovery"))?.toolRecovery).toBeUndefined();
    expect(store.parseAgentRunContinuation({ ...continuation, toolRecovery: {
      ...toolRecovery, mac: { ...toolRecovery.mac, rawScreenshot: "untrusted image" },
    } })).toBeUndefined();
    expect(store.parseAgentRunContinuation({ ...continuation,
      context: { ...continuation.context, actorId: "different-owner" },
    })).toBeUndefined();
    expect(() => createRunToolRecovery({ tenantId: "default", actorId: "tester", runId: "other-run" },
      saved?.continuation?.toolRecovery)).toThrow(/match/);
  });

  it("preserves the exact voice input and strict policy through approval parking", async () => {
    const store = await import("@/lib/runs/store");
    const voiceTaskBinding = {
      schemaVersion: 1 as const, tenantId: "default", actorId: "tester",
      sessionId: "33333333-3333-4333-8333-333333333333", conversationId: "22222222-2222-4222-8222-222222222222",
      userInputItemId: "input-1", userTurnId: "44444444-4444-4444-8444-444444444444", requestId: "voice-request",
      objective: "Open YouTube", transcriptSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const toolPolicy = { allowedToolIds: ["local.macos.open_url"], readOnly: false, forceApproval: false,
      forceApprovalAboveRisk: 0, voiceRiskThreshold: 1 as const, voiceTaskBinding };
    const run = await store.createAgentRun({ mode: "orchestrate", prompt: "Model rewrite", messages: [{ role: "user", content: "Model rewrite" }] });
    await store.markAgentRunWaitingForApproval(run.id, { response: "Waiting", continuation: {
      ...continuationFor("exec-voice-input"), toolPolicy,
    } });
    const saved = await store.findAgentRunWaitingForToolApproval("exec-voice-input");
    expect(saved?.continuation?.toolPolicy).toEqual(toolPolicy);
    expect(store.parseAgentRunContinuation({ ...continuationFor("malformed-voice"), toolPolicy: {
      ...toolPolicy, voiceTaskBinding: { ...voiceTaskBinding, objective: "" },
    } })?.toolPolicy).toMatchObject({ voiceRiskThreshold: 1, voiceTaskBinding: undefined, forceApprovalAboveRisk: 0 });
  });

  it("retains deferred call digests across approval parking without changing tool authority", async () => {
    const store = await import("@/lib/runs/store");
    const deferredToolCallHashes = ["a".repeat(64), "b".repeat(64)];
    const toolPolicy = { allowedToolIds: ["app.library.show"], readOnly: true, forceApproval: false };
    const run = await store.createAgentRun({
      mode: "orchestrate", prompt: "Continue reading", messages: [{ role: "user", content: "Continue reading" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "Waiting",
      continuation: {
        ...continuationFor("exec-deferred-calls"), deferredToolCallHashes, toolPolicy,
      },
    });
    const saved = await store.findAgentRunWaitingForToolApproval("exec-deferred-calls");
    expect(saved?.continuation?.deferredToolCallHashes).toEqual(deferredToolCallHashes);
    expect(saved?.continuation?.toolPolicy).toEqual(toolPolicy);
    expect(store.parseAgentRunContinuation(continuationFor("legacy-deferred-calls"))?.deferredToolCallHashes).toBeUndefined();
    expect(store.parseAgentRunContinuation({
      ...continuationFor("empty-deferred-calls"), deferredToolCallHashes: [],
    })?.deferredToolCallHashes).toEqual([]);
    const atLimit = Array.from({ length: MAX_DEFERRED_TOOL_CALL_HASHES }, (_, index) => index.toString(16).padStart(64, "0"));
    expect(store.parseAgentRunContinuation({
      ...continuationFor("bounded-deferred-calls"), deferredToolCallHashes: atLimit,
    })?.deferredToolCallHashes).toEqual(atLimit);
  });

  it.each([
    null,
    "a".repeat(64),
    {},
    ["a".repeat(64), "a".repeat(64)],
    ["A".repeat(64)],
    ["g".repeat(64)],
    ["a".repeat(63)],
    ["a".repeat(65)],
    ["a".repeat(64), null],
    Array(1),
    [{ toolName: "app.library.show", arguments: { privateText: "not a digest" } }],
    Array.from({ length: MAX_DEFERRED_TOOL_CALL_HASHES + 1 }, (_, index) => index.toString(16).padStart(64, "0")),
  ].map(deferredToolCallHashes => ({ deferredToolCallHashes })))("rejects malformed or unbounded deferred call digests (%#)", async ({ deferredToolCallHashes }) => {
    const store = await import("@/lib/runs/store");
    expect(store.parseAgentRunContinuation({
      ...continuationFor("invalid-deferred-calls"), deferredToolCallHashes,
    })).toBeUndefined();
  });

  it("retains only the closed set of source-reader hints through approval parking", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({ mode: "orchestrate", prompt: "Read the attached brief", messages: [{ role: "user", content: "Read the attached brief" }] });
    await store.markAgentRunWaitingForApproval(run.id, { response: "Waiting", continuation: {
      ...continuationFor("exec-file-reader"), contextReaderToolIds: ["app.library.show"],
      toolPolicy: { allowedToolIds: ["app.library.show"], readOnly: true, forceApproval: false },
    } });
    const saved = await store.findAgentRunWaitingForToolApproval("exec-file-reader");
    expect(saved?.continuation?.contextReaderToolIds).toEqual(["app.library.show"]);
    expect(saved?.continuation?.toolPolicy).toMatchObject({ allowedToolIds: ["app.library.show"], readOnly: true });
    expect(store.parseAgentRunContinuation(continuationFor("legacy"))?.contextReaderToolIds).toBeUndefined();
    for (const contextReaderToolIds of [["app.work_items.update"], ["app.library.show", "app.library.show"], "app.library.show", null]) {
      expect(store.parseAgentRunContinuation({ ...continuationFor("invalid-reader"), contextReaderToolIds })).toBeUndefined();
    }
  });

  it.each([1, 6_000, 65_536])("retains the validated report output cap %s", async (maxOutputTokens) => {
    const store = await import("@/lib/runs/store");
    expect(store.parseAgentRunContinuation({
      ...continuationFor(`exec-report-cap-${maxOutputTokens}`),
      maxOutputTokens,
    })?.maxOutputTokens).toBe(maxOutputTokens);
  });

  it.each([0, -1, 1.5, 65_537, "6000", null, Number.NaN, Number.POSITIVE_INFINITY, {}, []])("rejects a malformed report output cap %s", async (maxOutputTokens) => {
    const store = await import("@/lib/runs/store");
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-invalid-report-cap"),
      maxOutputTokens,
    })).toBeUndefined();
  });

  it.each([
    { name: "report", maxOutputTokens: 6_000 },
    { name: "legacy", maxOutputTokens: undefined },
  ])("preserves the $name output-cap decision when parking and reading Research", async ({ name, maxOutputTokens }) => {
    const store = await import("@/lib/runs/store");
    const executionId = `exec-research-output-cap-${name}`;
    const run = await store.createAgentRun({
      mode: "research",
      prompt: "preserve the report output budget",
      messages: [{ role: "user", content: "preserve the report output budget" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "Collected the first source.",
      continuation: {
        ...continuationFor(executionId),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      },
    });

    const found = await store.findAgentRunWaitingForToolApproval(executionId);
    expect(found?.mode).toBe("research");
    expect(found?.continuation).toBeDefined();
    expect(found?.continuation?.maxOutputTokens).toBe(maxOutputTokens);
  });

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

  it("carries only a recognized durable-memory decision across approval pauses", async () => {
    const store = await import("@/lib/runs/store");

    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-memory-durable"),
      memoryFormation: "durable",
    })?.memoryFormation).toBe("durable");
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-memory-withheld"),
      memoryFormation: "withheld",
    })?.memoryFormation).toBe("withheld");
    expect(store.parseAgentRunContinuation(
      continuationFor("exec-memory-legacy"),
    )?.memoryFormation).toBeUndefined();
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-memory-unknown"),
      memoryFormation: "all",
    })?.memoryFormation).toBeUndefined();
  });

  it("retains only a closed Computer Use target across approval pauses", async () => {
    const store = await import("@/lib/runs/store");
    const local = store.parseAgentRunContinuation({
      ...continuationFor("exec-local-target"),
      computerUseTarget: "local_macos",
    });
    const retired = store.parseAgentRunContinuation({
      ...continuationFor("exec-retired-target"),
      computerUseTarget: "isolated_browser",
    });
    const legacy = store.parseAgentRunContinuation(
      continuationFor("exec-no-target"),
    );

    expect(local?.computerUseTarget).toBe("local_macos");
    expect(retired?.computerUseTarget).toBe("isolated_browser");
    expect(legacy?.computerUseTarget).toBeUndefined();
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-invalid-target"),
      computerUseTarget: "prompt_selected_local",
    })).toBeUndefined();
  });

  it("retains only the reduced authenticated owner binding across approval pauses", async () => {
    const store = await import("@/lib/runs/store");
    const authUserBinding = {
      version: 1 as const,
      source: "mobile" as const,
      authUserId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.test",
      canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
    };
    const parsed = store.parseAgentRunContinuation({
      ...continuationFor("exec-auth-owner"),
      context: {
        tenantId: "tenant-one",
        actorId: "owner@example.test",
        role: "operator",
        authUserBinding,
      },
    });
    expect(parsed?.context.authUserBinding).toEqual(authUserBinding);
    expect(JSON.stringify(parsed)).not.toContain("sessionId");
    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-auth-tampered"),
      context: {
        tenantId: "tenant-one",
        actorId: "owner@example.test",
        role: "operator",
        authUserBinding: {
          ...authUserBinding,
          source: "default",
          sessionId: "must-not-survive",
        },
      },
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

  it("carries the run's delegation receipts across an approval pause", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "carry delegation receipts",
      messages: [{ role: "user", content: "carry delegation receipts" }],
    });
    // An agent ID can look like an API key to the generic redactor.
    const receipts = [
      {
        executionId: "dar_scout",
        childRunId: "run_scout",
        delegateAgentId: "sk-research-assistant-01",
        state: "queued",
      },
      {
        executionId: "dar_memory",
        childRunId: "run_memory",
        delegateAgentId: "mnemosyne",
        state: "running",
      },
    ] as const;

    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: {
        ...continuationFor("exec-receipts-roundtrip"),
        delegationReceipts: receipts,
      },
    });

    const found = await store.findAgentRunWaitingForToolApproval(
      "exec-receipts-roundtrip",
    );
    expect(found?.continuation?.delegationReceipts).toEqual(receipts);
    expect(store.parseAgentRunContinuation(
      continuationFor("exec-receipts-absent"),
    )?.delegationReceipts).toBeUndefined();
  });

  it.each([
    ["not a list", { executionId: "dar_scout" }],
    ["a missing field", [{ executionId: "dar_scout", childRunId: "run_scout", state: "queued" }]],
    ["an unknown state", [{
      executionId: "dar_scout",
      childRunId: "run_scout",
      delegateAgentId: "scout",
      state: "done",
    }]],
  ])("rejects a continuation whose delegation receipts are %s", async (_label, delegationReceipts) => {
    const store = await import("@/lib/runs/store");

    expect(store.parseAgentRunContinuation({
      ...continuationFor("exec-receipts-damaged"),
      delegationReceipts,
    })).toBeUndefined();
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

  it("links each paused execution to the newest run in the tenant still waiting on it", async () => {
    const store = await import("@/lib/runs/store");
    const tenantId = "tenant-approval-origins";
    const park = async (executionId: string, threadId?: string, runTenantId = tenantId) => {
      const run = await store.createAgentRun({
        mode: "orchestrate",
        prompt: `wait on ${executionId}`,
        messages: [{ role: "user", content: `wait on ${executionId}` }],
        tenantId: runTenantId,
        actorId: "origin-owner",
        threadId,
      });
      await store.markAgentRunWaitingForApproval(run.id, {
        response: "partial",
        continuation: {
          ...continuationFor(executionId),
          context: { tenantId: runTenantId, actorId: "origin-owner", role: "operator" },
        },
      });
      return run;
    };
    await park("exec-origin-shared", "thread-older");
    const newer = await park("exec-origin-shared", "thread-newer");
    const resuming = await park("exec-origin-resuming");
    expect(await store.markAgentRunResuming(resuming.id, { tenantId })).toBe(true);
    const completed = await park("exec-origin-completed", "thread-completed");
    await store.completeAgentRun(completed.id, "done", undefined, { tenantId });
    await park("exec-origin-elsewhere", "thread-elsewhere", `${tenantId}-other`);
    await park("exec-origin-unasked", "thread-unasked");

    const origins = await store.findAgentRunsWaitingForToolApprovals(
      [
        " exec-origin-shared ",
        "exec-origin-resuming",
        "exec-origin-completed",
        "exec-origin-elsewhere",
        "   ",
      ],
      { tenantId },
    );

    expect(Object.fromEntries(origins)).toEqual({
      "exec-origin-shared": {
        runId: newer.id,
        threadId: "thread-newer",
        ownerActorId: "origin-owner",
      },
      "exec-origin-resuming": { runId: resuming.id, ownerActorId: "origin-owner" },
    });
    await expect(
      store.findAgentRunsWaitingForToolApprovals(["   "], { tenantId }),
    ).resolves.toEqual(new Map());
  });

  it("looks up at most 200 execution ids", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      mode: "orchestrate",
      prompt: "wait on the last id",
      messages: [{ role: "user", content: "wait on the last id" }],
    });
    await store.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor("exec-bound-last"),
    });
    const others = (count: number) =>
      Array.from({ length: count }, (_, index) => `exec-bound-${index}`);

    const within = await store.findAgentRunsWaitingForToolApprovals([
      ...others(199),
      "exec-bound-last",
    ]);
    expect([...within.keys()]).toEqual(["exec-bound-last"]);
    const beyond = await store.findAgentRunsWaitingForToolApprovals([
      ...others(200),
      "exec-bound-last",
    ]);
    expect(beyond.size).toBe(0);
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

  it("records the run's durable-memory decision on its harness event", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      tenantId: "run-memory-decision",
      mode: "orchestrate",
      prompt: "record the memory decision",
      messages: [{ role: "user", content: "record the memory decision" }],
    });
    const harness: AgentHarnessEvent = {
      type: "harness",
      version: 1,
      mode: "orchestrate",
      provider: "openai",
      model: "test-model",
      tier: "fast",
      memoryScope: "all",
      memoryFormation: "withheld",
      contextScope: "session",
      contextDecision: "disabled_session",
      contextMode: "session",
      contextCount: 0,
      contextEvidenceIds: [],
      contextRationale: [],
      liveWeb: false,
      toolCount: 0,
      toolIds: [],
      approvalToolCount: 0,
      skillIds: [],
      toolboxSha256: "a".repeat(64),
      instructionsSha256: "b".repeat(64),
      maxToolSteps: 6,
      maxToolCallsPerTurn: 4,
      maxToolResultChars: 4_000,
      maxOutputTokens: 1_024,
      budgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      approvalPolicy: "read_only",
      autonomy: "assist",
    };
    await store.appendRunEvent(run.id, harness, {
      tenantId: "run-memory-decision",
    });

    const [event] = await listStreamEvents(`run:${run.id}`, {
      tenantId: "run-memory-decision",
    });
    expect(event).toMatchObject({
      type: "run.harness",
      payload: { memoryScope: "all", memoryFormation: "withheld" },
    });
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

  it("keeps a trusted root run id and requires an exact legacy-to-canonical owner bridge", async () => {
    const store = await import("@/lib/runs/store");
    const {
      buildAgentRunIdentityPinV1,
      buildBuiltInAgentIdentityV1,
    } = await import("@/lib/agents/identity-contracts");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const tenantId = "canonical-owner-binding";
    const legacyActorId = "owner@example.test";
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const canonicalActorId = `actor:${authUserId}`;
    const runId = "22222222-2222-4222-8222-222222222222";
    const run = await store.createAgentRun({
      id: runId,
      tenantId,
      actorId: legacyActorId,
      mode: "orchestrate",
      prompt: "bind canonical identity",
      messages: [{ role: "user", content: "bind canonical identity" }],
      agentId: "atlas",
    });
    expect(run.id).toBe(runId);
    await expect(store.getAgentRun(runId, { tenantId })).resolves.toMatchObject({
      id: runId,
      ownerActorId: legacyActorId,
    });
    await expect(store.createAgentRun({
      id: " unsafe/run ",
      tenantId,
      actorId: legacyActorId,
      mode: "orchestrate",
      prompt: "reject unsafe identity",
      messages: [{ role: "user", content: "reject unsafe identity" }],
      agentId: "atlas",
    })).rejects.toThrow(/safe opaque id/i);
    const pin = buildAgentRunIdentityPinV1({
      runId,
      identity: buildBuiltInAgentIdentityV1({
        agentId: "atlas",
        tenantId,
        controllerActorId: canonicalActorId,
      }),
    });
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: legacyActorId,
      executingPrincipalType: "agent",
      executingPrincipalId: pin.principalId,
      correlationId: runId,
      purpose: "agent.run",
    });
    await store.bindAgentRunExecutionScope(runId, scope, { tenantId });
    const requestActorBinding = {
      version: 1 as const,
      kind: "auth_user" as const,
      authUserId,
      canonicalActorId,
      legacyOwnerActorIds: [legacyActorId],
      readableOwnerActorIds: [canonicalActorId, legacyActorId],
    };

    await expect(store.appendAgentRunIdentityPin(runId, pin, {
      tenantId,
      executionScope: scope,
      requestActorBinding,
    })).resolves.toBeDefined();
    await expect(store.appendAgentRunIdentityPin(runId, pin, {
      tenantId,
      executionScope: scope,
      requestActorBinding: {
        ...requestActorBinding,
        readableOwnerActorIds: [legacyActorId, canonicalActorId],
      },
    })).rejects.toThrow(/authenticated owner binding/i);
  });

  it("never lets a second request-derived create overwrite the run it names", async () => {
    const store = await import("@/lib/runs/store");
    const tenantId = "request-derived-run";
    const runId = "3b241101-e2bb-8255-8caf-4136c566a962";
    await store.createAgentRun({
      id: runId,
      tenantId,
      actorId: "owner@example.test",
      mode: "orchestrate",
      prompt: "send the weekly update",
      messages: [{ role: "user", content: "send the weekly update" }],
      agentId: "atlas",
    });
    await store.completeAgentRun(runId, "Sent.", undefined, { tenantId });

    await expect(store.createAgentRun({
      id: runId,
      tenantId,
      actorId: "owner@example.test",
      mode: "orchestrate",
      prompt: "send the weekly update",
      messages: [{ role: "user", content: "send the weekly update" }],
      agentId: "atlas",
    })).rejects.toBeInstanceOf(store.AgentRunAlreadyExistsError);
    await expect(store.getAgentRun(runId, { tenantId })).resolves.toMatchObject({
      id: runId,
      status: "completed",
      response: "Sent.",
    });
    const runs = await store.listAgentRuns(50, { tenantId });
    expect(runs.filter((run) => run.id === runId)).toHaveLength(1);
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

  it("persists closed tool-limit metadata without status prose or private extra fields", async () => {
    const store = await import("@/lib/runs/store");
    const tenantId = "run-tool-limit-metadata";
    const run = await store.createAgentRun({
      tenantId, mode: "orchestrate", prompt: "Private prompt", messages: [{ role: "user", content: "Private prompt" }],
    });
    const toolLimit = {
      version: 1 as const,
      reason: "per_turn_calls" as const,
      proposedCalls: 6,
      admittedCalls: 5,
      skippedCalls: 1,
      remainingToolCalls: 25,
      remainingToolRounds: 7,
      unresolvedCalls: 1,
    };
    const event = {
      type: "status" as const,
      label: "Private limit label",
      detail: "Private limit detail",
      toolLimit: {
        ...toolLimit,
        arguments: { privateSourceText: "Private source text" },
        privateReasoning: "Private reasoning",
      },
      privateExtra: "Private outer field",
    };
    await store.appendRunEvent(run.id, event, { tenantId });
    for (const reason of ["run_tool_calls", "run_tool_rounds"] as const) {
      await store.appendRunEvent(run.id, {
        type: "status", label: "Private limit label",
        toolLimit: { version: 1, reason, remainingToolRounds: 0 },
      }, { tenantId });
    }
    const events = await listStreamEvents(`run:${run.id}`, { tenantId });
    expect(events).toHaveLength(3);
    expect(events[0].payload.toolLimit).toEqual(toolLimit);
    expect(events.slice(1).map(item => item.payload.toolLimit)).toEqual([
      { version: 1, reason: "run_tool_calls", remainingToolRounds: 0 },
      { version: 1, reason: "run_tool_rounds", remainingToolRounds: 0 },
    ]);
    expect(events[0].payload).toMatchObject({
      labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      detailSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("privateReasoning");
  });

  it("omits malformed tool-limit metadata from the domain event projection", async () => {
    const store = await import("@/lib/runs/store");
    const tenantId = "run-tool-limit-invalid";
    const run = await store.createAgentRun({
      tenantId, mode: "orchestrate", prompt: "Limit validation", messages: [{ role: "user", content: "Limit validation" }],
    });
    const valid = { version: 1, reason: "per_turn_calls", remainingToolRounds: 7 };
    const invalid = [
      null, [], "Private metadata", {},
      { ...valid, version: 2 },
      { ...valid, reason: "Private reason" },
      { version: 1, reason: "per_turn_calls" },
      ...["proposedCalls", "admittedCalls", "skippedCalls", "remainingToolCalls", "remainingToolRounds", "unresolvedCalls"].flatMap(key =>
        [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...valid, [key]: value })),
      ),
    ];
    for (const toolLimit of invalid) {
      await store.appendRunEvent(run.id, {
        type: "status", label: "Private invalid limit", toolLimit,
      } as AgentEvent, { tenantId });
    }
    const events = await listStreamEvents(`run:${run.id}`, { tenantId });
    expect(events).toHaveLength(invalid.length);
    for (const event of events) {
      expect(event.payload).not.toHaveProperty("toolLimit");
      expect(event.payload).toMatchObject({ labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }
    expect(JSON.stringify(events)).not.toContain("Private");
  });

  it("preserves validated council failure metadata without private provider details", async () => {
    const store = await import("@/lib/runs/store");
    const tenantId = "run-council-failure-metadata";
    const run = await store.createAgentRun({
      tenantId, mode: "orchestrate", prompt: "Private council prompt", messages: [{ role: "user", content: "Private council prompt" }],
    });
    const event = {
      type: "council_member" as const,
      agentId: "scout" as const,
      agentName: "Private specialist name",
      role: "Private specialist role",
      status: "failed" as const,
      summary: "Private provider response",
      failureStage: "contribution_parse" as const,
      failureCode: "invalid_evidence_ids" as const,
      usageReceiptId: "123e4567-e89b-42d3-a456-426614174000",
      providerResponse: "Private raw provider body",
      privateReasoning: "Private reasoning",
    };
    await store.appendRunEvent(run.id, event, { tenantId });
    await store.appendRunEvent(run.id, {
      ...event,
      failureStage: "Private forged stage",
      failureCode: "Private forged code",
      usageReceiptId: "Private forged receipt",
    } as unknown as AgentEvent, { tenantId });
    const events = await listStreamEvents(`run:${run.id}`, { tenantId });
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({
      failureStage: "contribution_parse",
      failureCode: "invalid_evidence_ids",
      usageReceiptId: "123e4567-e89b-42d3-a456-426614174000",
      summarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const key of ["failureStage", "failureCode", "usageReceiptId"]) {
      expect(events[1].payload).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("providerResponse");
    expect(serialized).not.toContain("privateReasoning");
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

  it("keeps why a model route could not be used, without its prose", async () => {
    const store = await import("@/lib/runs/store");
    const run = await store.createAgentRun({
      tenantId: "run-route-degraded",
      mode: "orchestrate",
      prompt: "private prompt",
      messages: [{ role: "user", content: "private prompt" }],
    });
    await store.appendRunEvent(run.id, {
      type: "model_route_degraded",
      outcome: "blocked",
      code: "credential_unavailable",
      message: "Private route failure detail",
    }, { tenantId: "run-route-degraded" });

    const [event] = await listStreamEvents(`run:${run.id}`, {
      tenantId: "run-route-degraded",
    });
    expect(event).toMatchObject({
      type: "run.model_route_degraded",
      payload: {
        schemaVersion: 1,
        type: "model_route_degraded",
        outcome: "blocked",
        code: "credential_unavailable",
        messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(event)).not.toContain("Private route");
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

describe("agent run event positions (file mode)", () => {
  it("gives each persisted event its run stream position and lists a run's events after one", async () => {
    const store = await import("@/lib/runs/store");
    const { runEventCursor } = await import("@/lib/runs/event-cursor");
    const create = (prompt: string) => store.createAgentRun({
      mode: "orchestrate",
      prompt,
      messages: [{ role: "user", content: prompt }],
    });
    const run = await create("follow this run");
    const other = await create("a different run");
    const planning = { type: "status", label: "Planning" } as const;
    const delta = { type: "delta", text: "partial" } as const;

    const first = await store.appendRunEvent(run.id, planning);
    await store.appendRunEvent(other.id, { type: "status", label: "Elsewhere" });
    const transient = await store.appendRunEvent(run.id, delta);
    const second = await store.appendRunEvent(run.id, {
      type: "status",
      label: "Acting",
    });
    const third = await store.appendRunEvent(run.id, {
      type: "status",
      label: "Checking",
    });

    // The record and its domain event are one event at one position.
    const stream = await listStreamEvents(`run:${run.id}`);
    expect(stream.map((event) => [event.id, event.seq])).toEqual(
      [first, second, third].map((record) => [record.id, record.seq]),
    );
    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq!);
    expect(runEventCursor(planning)).toBe(first.seq);
    expect(transient.seq).toBeUndefined();
    expect(runEventCursor(delta)).toBeUndefined();

    await expect(
      store.listAgentRunEventsAfter(run.id, { tenantId: "default" }),
    ).resolves.toEqual([first, second, third]);
    await expect(
      store.listAgentRunEventsAfter(run.id, {
        tenantId: "default",
        afterSeq: first.seq,
      }),
    ).resolves.toEqual([second, third]);
    await expect(
      store.listAgentRunEventsAfter(run.id, {
        tenantId: "default",
        afterSeq: first.seq,
        limit: 1,
      }),
    ).resolves.toEqual([second]);
    await expect(
      store.listAgentRunEventsAfter(run.id, {
        tenantId: "default",
        afterSeq: third.seq,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.listAgentRunEventsAfter(run.id, { tenantId: "tenant-elsewhere" }),
    ).resolves.toEqual([]);
  });
});
