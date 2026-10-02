import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildLedgerReplayCorpus,
  ledgerReplayCase,
  ledgerReplayRunSkip,
  summarizeLedgerReplayRun,
  type LedgerReplayRunSummary,
} from "@/lib/evals2/ledger-replay";
import type { AgentRunEventRecord, AgentRunRecord } from "@/lib/runs/types";

const TENANT = "tenant-replay";
const NOW = new Date("2026-10-01T12:00:00.000Z");

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-replay-1",
    tenantId: TENANT,
    ownerActorId: "owner-replay",
    mode: "research",
    status: "completed",
    prompt: "Summarize this week's project notes.",
    messages: [{ role: "user", content: "  Summarize this week's project notes.  " }],
    memoryContextCount: 0,
    response: "x".repeat(300),
    startedAt: "2026-09-30T10:00:00.000Z",
    completedAt: "2026-09-30T10:00:20.000Z",
    ...overrides,
  };
}

function event(type: string, payload: unknown): AgentRunEventRecord {
  return {
    id: `event-${type}`,
    runId: "run-replay-1",
    type,
    payload,
    createdAt: "2026-09-30T10:00:01.000Z",
  };
}

function summary(overrides: Partial<LedgerReplayRunSummary> = {}): LedgerReplayRunSummary {
  return {
    toolIds: [],
    providers: ["openai"],
    modelCalls: 1,
    estimatedCostUsd: 0.01,
    approvalNeeded: false,
    blocked: false,
    effect: false,
    eventsComplete: true,
    ...overrides,
  };
}

describe("summarizing a recorded run", () => {
  it("collects the tools it used, its providers, and its cost", () => {
    expect(summarizeLedgerReplayRun([
      event("tool", { type: "tool", toolId: "web.search", status: "running", riskLevel: 0 }),
      event("tool", { type: "tool", toolId: "web.search", status: "executed", riskLevel: 0 }),
      event("tool", { type: "tool", toolId: "memory.search", status: "dry_run", riskLevel: 0 }),
      event("tool", { type: "tool", toolId: "knowledge.search", status: "failed", riskLevel: 0 }),
      event("tool", { type: "tool", toolId: "drafts.list", status: "running" }),
      event("model", { type: "model", provider: "openai", estimatedCostUsd: 0.25 }),
      event("model", { type: "model", provider: "anthropic", estimatedCostUsd: 0.5 }),
      event("model", { type: "model", provider: "openai", estimatedCostUsd: 0.125 }),
      event("done", { type: "done", response: "ok" }),
    ])).toEqual({
      toolIds: ["knowledge.search", "memory.search", "web.search"],
      providers: ["anthropic", "openai"],
      modelCalls: 3,
      estimatedCostUsd: 0.875,
      approvalNeeded: false,
      blocked: false,
      effect: false,
      eventsComplete: true,
    });
  });

  it("leaves the cost unknown when any model call's cost is unknown", () => {
    const known = event("model", { provider: "openai", estimatedCostUsd: 0.25 });
    for (const unknown of [
      event("model", { provider: "openai" }),
      event("model", { provider: "openai", estimatedCostUsd: 0.1, costKnown: false }),
      event("model", { provider: "openai", estimatedCostUsd: Number.POSITIVE_INFINITY }),
    ]) {
      expect(summarizeLedgerReplayRun([unknown, known]).estimatedCostUsd).toBeUndefined();
      expect(summarizeLedgerReplayRun([known, unknown]).estimatedCostUsd).toBeUndefined();
    }
    expect(summarizeLedgerReplayRun([
      event("model", { estimatedCostUsd: 0.1, costKnown: true }),
    ])).toMatchObject({ estimatedCostUsd: 0.1, providers: [], modelCalls: 1 });
    const none = summarizeLedgerReplayRun([event("run", null), event("done", "text")]);
    expect(none).toMatchObject({ modelCalls: 0, toolIds: [], providers: [] });
    expect(none).not.toHaveProperty("estimatedCostUsd");
    const bare = summarizeLedgerReplayRun([event("tool", null), event("model", "text")]);
    expect(bare).toMatchObject({ modelCalls: 1, toolIds: [], providers: [], effect: false });
    expect(bare).not.toHaveProperty("estimatedCostUsd");
  });

  it("notes an approval, a risky tool, or a blocked call", () => {
    const flags = (...events: AgentRunEventRecord[]) => {
      const { approvalNeeded, blocked } = summarizeLedgerReplayRun(events);
      return { approvalNeeded, blocked };
    };

    expect(flags(event("waiting_approval", { executionId: "e1", toolId: "mail.send" })))
      .toEqual({ approvalNeeded: true, blocked: false });
    expect(flags(event("tool", { toolId: "mail.send", status: "approval_required" })))
      .toEqual({ approvalNeeded: true, blocked: false });
    expect(flags(event("tool", { toolId: "drive.share", status: "dry_run", riskLevel: 2 })))
      .toEqual({ approvalNeeded: true, blocked: false });
    expect(flags(event("tool", { toolId: "memory.write", status: "executed", riskLevel: 1 })))
      .toEqual({ approvalNeeded: false, blocked: false });
    expect(flags(event("tool", { toolId: "memory.write", status: "blocked", riskLevel: 1 })))
      .toEqual({ approvalNeeded: false, blocked: true });
    // A blocked status on any other event is not a blocked call.
    expect(flags(event("council_verdict", { status: "blocked" })))
      .toEqual({ approvalNeeded: false, blocked: false });
  });

  it("excludes tool baselines that could write, including dry runs", () => {
    const effect = (payload: Record<string, unknown>) =>
      summarizeLedgerReplayRun([event("tool", { toolId: "memory.write", ...payload })]).effect;

    expect(effect({ status: "executed", riskLevel: 1 })).toBe(true);
    expect(effect({ status: "failed", riskLevel: 1 })).toBe(true);
    expect(effect({ status: "executed" })).toBe(true);
    expect(effect({ status: "executed", riskLevel: 0 })).toBe(false);
    expect(effect({ status: "failed", riskLevel: 0 })).toBe(false);
    expect(effect({ status: "dry_run", riskLevel: 1 })).toBe(true);
    expect(effect({ status: "dry_run" })).toBe(true);
    expect(effect({ status: "dry_run", riskLevel: 0 })).toBe(false);
    expect(effect({ status: "running", riskLevel: 1 })).toBe(false);
    expect(effect({ status: "blocked", riskLevel: 1 })).toBe(false);
    expect(summarizeLedgerReplayRun([
      event("council_member", { status: "executed", riskLevel: 1 }),
    ]).effect).toBe(false);
  });

  it("marks a run whose events fill a whole page as possibly cut short", () => {
    const page = (count: number) => Array.from({ length: count }, (_, index) =>
      event("tool", { toolId: `tool.${index}`, status: "running" })
    );

    expect(summarizeLedgerReplayRun(page(499)).eventsComplete).toBe(true);
    expect(summarizeLedgerReplayRun(page(500)).eventsComplete).toBe(false);
  });
});

describe("judging a run for replay", () => {
  it("replays only a single user message", () => {
    expect(ledgerReplayRunSkip(run())).toBeUndefined();
    expect(ledgerReplayRunSkip(run({ messages: [] }))).toBe("conversation");
    expect(ledgerReplayRunSkip(run({
      messages: [{ role: "assistant", content: "Summarize this." }],
    }))).toBe("conversation");
    expect(ledgerReplayRunSkip(run({
      messages: [
        { role: "user", content: "Summarize this." },
        { role: "user", content: "And that." },
      ],
    }))).toBe("conversation");
  });

  it("leaves out a run the owner marked as needing work", () => {
    expect(ledgerReplayRunSkip(run({
      feedback: { verdict: "needs_work", updatedAt: "2026-09-30T11:00:00.000Z" },
    }))).toBe("needs_work");
    expect(ledgerReplayRunSkip(run({
      feedback: { verdict: "useful", updatedAt: "2026-09-30T11:00:00.000Z" },
    }))).toBeUndefined();
  });

  it("leaves out an empty or very long goal", () => {
    const withGoal = (content: string) => run({ messages: [{ role: "user", content }] });

    expect(ledgerReplayRunSkip(withGoal("   "))).toBe("goal_length");
    // 2,000 characters once trimmed is the longest goal kept.
    expect(ledgerReplayRunSkip(withGoal(` ${"a ".repeat(999)}ab `))).toBeUndefined();
    expect(ledgerReplayRunSkip(withGoal(`${"a ".repeat(999)}abc`))).toBe("goal_length");
  });

  it.each([
    "Email the notes to sam@example.test",
    "Read https://example.test/notes",
    "Read http://example.test/notes",
    "Open www.example.test",
    "Open WWW.Example.test",
    "Call +1 (555) 012-3456 tomorrow",
    "Call 555.012.3456",
    "Pay account 123 456 789",
    `Use opaque token ${"x".repeat(40)}`,
    `Use token ${Array(7).fill("ABCD").join("-")}`,
    "My Password is in the vault",
    "Reset the OTP for my account",
    "Use the passcode",
    "Use the passphrase",
    "Use [redacted] for the login",
  ])("leaves out a goal with a private detail: %s", (content) => {
    expect(ledgerReplayRunSkip(run({ messages: [{ role: "user", content }] })))
      .toBe("private_detail");
  });

  it.each([
    "Summarize the 12345678 invoices from 2026-09-30",
    "Name a token like abcdefghijklmnopqrstuvwxyz01234",
    "Compare email at example dot test with the passwords policy",
    "Explain why the memo was redacted",
  ])("keeps a goal with no private detail: %s", (content) => {
    expect(ledgerReplayRunSkip(run({ messages: [{ role: "user", content }] })))
      .toBeUndefined();
  });
});

describe("building a replay task", () => {
  it("holds the candidate to the recorded run", () => {
    expect(ledgerReplayCase(
      run({
        grounding: { status: "verified", citedIds: ["m1", "m2"], invalidIds: [], sources: [] },
        feedback: { verdict: "useful", updatedAt: "2026-09-30T11:00:00.000Z" },
      }),
      summary({
        toolIds: ["memory.search", "web.search"],
        providers: ["anthropic", "openai"],
        estimatedCostUsd: 0.0123451,
      }),
    )).toEqual({
      task: {
        id: "replay-run-replay-1",
        goal: "Summarize this week's project notes.",
        mode: "research",
        assert: {
          maxLatencyMs: 60_000,
          minLength: 80,
          requiredToolIds: ["memory.search", "web.search"],
          minCitations: 1,
          maxEstimatedCostUsd: 0.024691,
        },
        rationale: expect.stringContaining("three times its latency"),
        baseline: {
          recordedOn: "2026-09-30",
          toolIds: ["memory.search", "web.search"],
          providers: ["anthropic", "openai"],
          latencyMs: 20_000,
          responseChars: 300,
          citations: 2,
          estimatedCostUsd: 0.0123451,
          feedback: "useful",
        },
      },
    });
  });

  it("keeps the latency budget at thirty seconds or more", () => {
    const latency = (completedAt: string) => {
      const outcome = ledgerReplayCase(run({ completedAt }), summary());
      return "task" in outcome
        ? [outcome.task.baseline.latencyMs, outcome.task.assert.maxLatencyMs]
        : undefined;
    };

    expect(latency("2026-09-30T10:00:02.000Z")).toEqual([2_000, 30_000]);
    expect(latency("2026-09-30T10:00:10.001Z")).toEqual([10_001, 30_003]);
    // A clock that ran backwards records no latency.
    expect(latency("2026-09-30T09:59:00.000Z")).toEqual([0, 30_000]);
    expect(latency("not a date")).toEqual([0, 30_000]);
  });

  it("asks for half the recorded answer, up to eighty characters", () => {
    const minLength = (response: string | undefined) => {
      const outcome = ledgerReplayCase(run({ response }), summary());
      return "task" in outcome ? outcome.task.assert.minLength : "skipped";
    };

    expect(minLength("x".repeat(161))).toBe(80);
    expect(minLength(`  ${"x".repeat(11)}  `)).toBe(5);
    expect(minLength("xy")).toBe(1);
    expect(minLength(" x ")).toBeUndefined();
    expect(minLength(undefined)).toBeUndefined();
  });

  it("drops the tool, citation, and cost checks the run gives no basis for", () => {
    const outcome = ledgerReplayCase(
      run({ grounding: { status: "not_required", citedIds: [], invalidIds: [], sources: [] } }),
      summary({ estimatedCostUsd: 0 }),
    );

    expect(outcome).toMatchObject({ task: { baseline: { estimatedCostUsd: 0, citations: 0 } } });
    const { assert, baseline } = (outcome as Extract<typeof outcome, { task: unknown }>).task;
    expect(Object.keys(assert).sort()).toEqual(["maxLatencyMs", "minLength"]);
    expect(baseline).not.toHaveProperty("feedback");
    const unknownCost = ledgerReplayCase(run(), summary({ estimatedCostUsd: undefined }));
    expect(unknownCost).toMatchObject({ task: { assert: expect.not.objectContaining({
      maxEstimatedCostUsd: expect.anything(),
    }) } });
    expect((unknownCost as Extract<typeof unknownCost, { task: unknown }>).task.baseline)
      .not.toHaveProperty("estimatedCostUsd");
    // A run with no grounding record cited nothing.
    expect(unknownCost).toMatchObject({ task: { baseline: { citations: 0 } } });
  });

  it("leaves out a run that needed an approval, was blocked, wrote, ran long, or had no model", () => {
    expect(ledgerReplayCase(run({ messages: [] }), summary())).toEqual({ skipped: "conversation" });
    expect(ledgerReplayCase(run(), summary({ approvalNeeded: true, blocked: true })))
      .toEqual({ skipped: "approval" });
    expect(ledgerReplayCase(run(), summary({ blocked: true, effect: true })))
      .toEqual({ skipped: "blocked" });
    expect(ledgerReplayCase(run(), summary({ effect: true, eventsComplete: false })))
      .toEqual({ skipped: "effect" });
    expect(ledgerReplayCase(run(), summary({ eventsComplete: false, modelCalls: 0 })))
      .toEqual({ skipped: "too_long" });
    expect(ledgerReplayCase(run(), summary({ modelCalls: 0 }))).toEqual({ skipped: "no_model" });
  });
});

describe("building a replay corpus", () => {
  const order = (id: string) =>
    createHash("sha256").update(`${TENANT}\u0000${id}`).digest("hex");

  it("samples recent completed runs in a fixed order and counts what it left out", async () => {
    const replayable = ["run-a", "run-b", "run-c", "run-d", "run-e"].map((id) => run({ id }));
    const runs = [
      ...replayable,
      run({ id: "run-running", status: "running", completedAt: undefined }),
      run({ id: "run-failed", status: "failed" }),
      run({ id: "run-unfinished", completedAt: undefined }),
      run({ id: "run-old", startedAt: "2026-09-24T11:59:59.999Z" }),
      run({ id: "run-edge", startedAt: "2026-09-24T12:00:00.000Z" }),
      run({ id: "run-chat", messages: [] }),
      run({ id: "run-chat-2", messages: [{ role: "assistant", content: "Hello." }] }),
      run({ id: "run-approval" }),
    ];
    const loadEvents = vi.fn(async (runId: string) => runId === "run-approval"
      ? [event("waiting_approval", { toolId: "mail.send" })]
      : [event("model", { provider: "openai", estimatedCostUsd: 0.01 })]);

    const corpus = await buildLedgerReplayCorpus({
      tenantId: TENANT,
      runs,
      days: 7,
      limit: 50,
      now: NOW,
      loadEvents,
    });

    const expected = [...replayable.map((item) => item.id), "run-edge"]
      .sort((left, right) => order(left).localeCompare(order(right)));
    expect(corpus).toMatchObject({
      version: 2,
      kind: "ledger_replay",
      schemaVersion: 1,
      description: expect.stringContaining("not production"),
      generatedAt: "2026-10-01T12:00:00.000Z",
      since: "2026-09-24T12:00:00.000Z",
      examined: 9,
      skipped: { conversation: 2, approval: 1 },
    });
    expect(corpus.tasks.map((task) => task.id)).toEqual(expected.map((id) => `replay-${id}`));
    // A run the row already rules out costs no event read.
    expect(loadEvents.mock.calls.map(([runId]) => runId)).not.toContain("run-chat");
    expect(loadEvents).toHaveBeenCalledTimes(7);
  });

  it("stops once it has enough tasks", async () => {
    const runs = ["run-a", "run-b", "run-c", "run-d", "run-e"].map((id) => run({ id }));
    const loadEvents = vi.fn(async () => [event("model", { provider: "openai" })]);

    const corpus = await buildLedgerReplayCorpus({
      tenantId: TENANT,
      runs,
      days: 7,
      limit: 2,
      now: NOW,
      loadEvents,
    });

    const first = runs.map((item) => item.id)
      .sort((left, right) => order(left).localeCompare(order(right)))
      .slice(0, 2);
    expect(corpus.tasks.map((task) => task.id)).toEqual(first.map((id) => `replay-${id}`));
    expect(corpus.examined).toBe(2);
    expect(corpus.skipped).toEqual({});
    expect(loadEvents).toHaveBeenCalledTimes(2);
  });

  it("orders runs by tenant, so another tenant samples differently", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `run-${index}`);
    const sample = async (tenantId: string) => (await buildLedgerReplayCorpus({
      tenantId,
      runs: ids.map((id) => run({ id })),
      days: 7,
      limit: 12,
      now: NOW,
      loadEvents: async () => [event("model", { provider: "openai" })],
    })).tasks.map((task) => task.id);

    expect(await sample(TENANT)).not.toEqual(await sample("tenant-replay-other"));
  });
});
