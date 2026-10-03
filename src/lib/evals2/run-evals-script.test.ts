import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentRequestInit,
  applyAssertion,
  evalConfig,
  evalSuiteConfig,
  readAgentStream,
} from "../../../scripts/run-evals.mjs";
import { buildLedgerReplayCorpus } from "@/lib/evals2/ledger-replay";
import { scoreTask } from "@/lib/evals2/scorer";

const SELECTION = {
  schemaVersion: 1,
  assignmentId: "assignment-candidate",
  route: "reasoning",
  provider: "anthropic",
  modelId: "claude-candidate",
};

describe("eval runner configuration", () => {
  it("defaults to the golden tasks on a local server", () => {
    expect(evalConfig({})).toEqual({
      baseUrl: "http://localhost:3000",
      origin: "http://localhost:3000",
      minPassRate: 0.8,
      requestTimeoutMs: 60_000,
      tasksFile: path.resolve("evals/golden-tasks.json"),
      tenantId: undefined,
      actorId: undefined,
      agentId: undefined,
      modelSelection: undefined,
    });
  });

  it("reads a replay corpus with expected owner assertions and a pinned model", () => {
    expect(evalConfig({
      BASE_URL: "https://omniagent-candidate-benniejosephs-projects.vercel.app",
      MIN_PASS_RATE: "0.9",
      EVAL_REQUEST_TIMEOUT_MS: "900000",
      EVAL_TASKS_FILE: "artifacts/ledger-replay.json",
      SMOKE_INTERNAL_AUTH_SECRET: "internal-secret",
      EVAL_TENANT_ID: " tenant-a ",
      EVAL_ACTOR_ID: " owner-a ",
      EVAL_AGENT_ID: " replay-reader ",
      EVAL_MODEL_SELECTION: JSON.stringify(SELECTION),
    })).toEqual({
      baseUrl: "https://omniagent-candidate-benniejosephs-projects.vercel.app",
      origin: "https://asael.bennierichard.com",
      minPassRate: 0.9,
      requestTimeoutMs: 300_000,
      tasksFile: path.resolve("artifacts/ledger-replay.json"),
      tenantId: "tenant-a",
      actorId: "owner-a",
      agentId: "replay-reader",
      modelSelection: SELECTION,
    });
  });

  it.each([
    [{ MIN_PASS_RATE: "1.5" }, /MIN_PASS_RATE/],
    [{ MIN_PASS_RATE: "-0.1" }, /MIN_PASS_RATE/],
    [{ MIN_PASS_RATE: "most" }, /MIN_PASS_RATE/],
    [{ BASE_URL: "https://example.com" }, /approved Asael operator target/],
    [{ EVAL_AGENT_ID: "bad agent id" }, /EVAL_AGENT_ID/],
    [{ EVAL_MODEL_SELECTION: "{not json" }, /JSON object/],
    [{ EVAL_MODEL_SELECTION: "null" }, /JSON object/],
    [{ EVAL_MODEL_SELECTION: "[1]" }, /JSON object/],
    [{ EVAL_MODEL_SELECTION: "\"claude\"" }, /JSON object/],
  ])("refuses %j", (env, message) => {
    expect(() => evalConfig(env)).toThrow(message);
  });
});

describe("eval runner requests", () => {
  const task = { id: "t1", goal: "Summarize my notes.", mode: "research", assert: {} };

  it("requires the server's read-only Agent constraint for every ledger replay task", () => {
    const suite = { kind: "ledger_replay" };
    expect(() => evalSuiteConfig(suite, evalConfig({}))).toThrow(/EVAL_AGENT_ID/);
    const config = evalSuiteConfig(suite, evalConfig({ EVAL_AGENT_ID: "replay-reader" }));

    expect(JSON.parse(agentRequestInit(task, config).body)).toEqual({
      mode: "research",
      messages: [{ role: "user", content: "Summarize my notes." }],
      agentId: "replay-reader",
      requireReadOnlyAgent: true,
    });
    expect(JSON.parse(agentRequestInit(task, evalSuiteConfig({ version: 2 }, evalConfig({}))).body))
      .toEqual({ mode: "research", messages: [{ role: "user", content: "Summarize my notes." }] });
  });

  it("never constructs internal identity headers from expected owner assertions", () => {
    const init = agentRequestInit(task, evalConfig({
      SMOKE_INTERNAL_AUTH_SECRET: "internal-secret",
      EVAL_TENANT_ID: "tenant-a",
      EVAL_ACTOR_ID: "owner-a",
      EVAL_MODEL_SELECTION: JSON.stringify(SELECTION),
    }));

    expect(init).toEqual({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "research",
        messages: [{ role: "user", content: "Summarize my notes." }],
        modelSelection: SELECTION,
      }),
    });
    expect(agentRequestInit(task, evalConfig({ SMOKE_INTERNAL_AUTH_SECRET: "internal-secret" })).headers)
      .toEqual({
        "content-type": "application/json",
      });
    expect(agentRequestInit({ ...task, mode: undefined }, evalConfig({}))).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "orchestrate",
        messages: [{ role: "user", content: "Summarize my notes." }],
      }),
    });
  });

  it("reads the answer and trajectory from the event stream", () => {
    const stream = [
      ": keepalive",
      `data: ${JSON.stringify({ type: "delta", text: "Draft " })}`,
      `data: ${JSON.stringify({ type: "tool", toolId: "web.search", status: "running" })}`,
      `data: ${JSON.stringify({ type: "tool", toolId: "memory.search", status: "executed" })}`,
      `data: ${JSON.stringify({ type: "model", provider: "openai", estimatedCostUsd: 0.25, fallbackUsed: true })}`,
      `data: ${JSON.stringify({ type: "model", provider: "anthropic", estimatedCostUsd: 0.5 })}`,
      `data: ${JSON.stringify({ type: "model", provider: "openai" })}`,
      "data: {not json",
      `data: ${JSON.stringify({ type: "done", response: "Final answer.", grounding: { citedIds: ["m1"] } })}`,
    ].join("\n");

    const { response, trajectory } = readAgentStream(stream);

    expect(response).toBe("Final answer.");
    expect(trajectory).toEqual({
      toolIds: new Set(["memory.search"]),
      citationIds: new Set(["m1"]),
      providers: new Set(["openai", "anthropic"]),
      estimatedCostUsd: undefined,
      latencyMs: 0,
      fallbackCount: 1,
    });
  });

  it("totals the candidate cost when every model call has a known price", () => {
    const stream = [0, 0.25, 0.5].map((estimatedCostUsd) =>
      `data: ${JSON.stringify({ type: "model", estimatedCostUsd, costKnown: true })}`
    ).join("\n");

    expect(readAgentStream(stream).trajectory.estimatedCostUsd).toBe(0.75);
  });

  it.each([
    {},
    { estimatedCostUsd: 0.01, costKnown: false },
    { estimatedCostUsd: null },
    { estimatedCostUsd: -0.01 },
  ])("cannot pass a replay cost budget with an unpriced call: %j", (unpriced) => {
    const known = { type: "model", estimatedCostUsd: 0.25, costKnown: true };
    const unknown = { type: "model", ...unpriced };
    for (const events of [[known, unknown], [unknown, known]]) {
      const stream = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n");
      const { trajectory } = readAgentStream(stream);

      expect(trajectory.estimatedCostUsd).toBeUndefined();
      expect(applyAssertion({ maxEstimatedCostUsd: 1 }, "Answer.", trajectory))
        .toEqual(["cost undefined exceeded 1"]);
    }
  });

  it("retains partial text for diagnosis but fails a stream without a done event", () => {
    const stream = [
      `data: ${JSON.stringify({ type: "delta", text: "Draft " })}`,
      `data: ${JSON.stringify({ type: "delta", text: "answer." })}`,
    ].join("\n");

    expect(readAgentStream(stream)).toEqual({
      response: "Draft answer.",
      error: "Agent stream did not complete successfully.",
      trajectory: {
        toolIds: new Set(),
        citationIds: new Set(),
        providers: new Set(),
        estimatedCostUsd: undefined,
        latencyMs: 0,
        fallbackCount: 0,
      },
    });
  });

  it.each(["error", "canceled", "waiting_approval", "clarification", "delegated", "budget_exhausted"])(
    "cannot score partial output followed by %s as a completed task", (type) => {
      const stream = [
        { type: "delta", text: "A long enough draft response." },
        { type },
      ].map((event) => `data: ${JSON.stringify(event)}`).join("\n");

      expect(readAgentStream(stream)).toMatchObject({
        response: "A long enough draft response.", error: `Agent stream ended with ${type}.`,
      });
    },
  );
});

describe("scoring a replay corpus", () => {
  it("passes a candidate that repeats the run and fails one that skips its tool", async () => {
    const corpus = await buildLedgerReplayCorpus({
      tenantId: "tenant-a",
      runs: [{
        id: "run-a",
        tenantId: "tenant-a",
        ownerActorId: "owner-a",
        mode: "research",
        status: "completed",
        prompt: "What did I note about the launch?",
        messages: [{ role: "user", content: "What did I note about the launch?" }],
        memoryContextCount: 0,
        response: "You noted the launch moved to Friday, pending the venue.",
        grounding: { status: "verified", citedIds: ["m1"], invalidIds: [], sources: [] },
        startedAt: "2026-09-30T10:00:00.000Z",
        completedAt: "2026-09-30T10:00:12.000Z",
      }],
      days: 7,
      limit: 5,
      now: new Date("2026-10-01T12:00:00.000Z"),
      loadEvents: async () => [
        {
          id: "e1",
          runId: "run-a",
          type: "tool",
          payload: { type: "tool", toolId: "memory.search", status: "executed", riskLevel: 0 },
          createdAt: "2026-09-30T10:00:01.000Z",
        },
        {
          id: "e2",
          runId: "run-a",
          type: "model",
          payload: { type: "model", provider: "openai", estimatedCostUsd: 0.01 },
          createdAt: "2026-09-30T10:00:02.000Z",
        },
      ],
    });
    const [task] = JSON.parse(JSON.stringify(corpus)).tasks;
    const answer = "The launch moved to Friday; the venue is still pending.";
    const repeated = {
      toolIds: new Set(["memory.search"]),
      citationIds: new Set(["m1"]),
      providers: new Set(["anthropic"]),
      estimatedCostUsd: 0.015,
      latencyMs: 20_000,
      fallbackCount: 0,
    };

    expect(applyAssertion(task.assert, answer, repeated)).toEqual([]);
    expect(scoreTask(task, answer, {
      ...repeated,
      toolIds: [...repeated.toolIds],
      citationIds: [...repeated.citationIds],
      providers: [...repeated.providers],
    }).passed).toBe(true);
    expect(applyAssertion(task.assert, answer, {
      ...repeated,
      toolIds: new Set(),
      citationIds: new Set(),
      estimatedCostUsd: 0.03,
      latencyMs: 40_000,
    })).toEqual([
      "expected 1 citations, received 0",
      "required tools not used: memory.search",
      "cost 0.03 exceeded 0.02",
      "latency 40000ms exceeded 36000ms",
    ]);
    // A candidate that reports no cost cannot show it stayed within budget.
    expect(applyAssertion(task.assert, answer, { ...repeated, estimatedCostUsd: undefined }))
      .toEqual(["cost undefined exceeded 0.02"]);
  });
});
