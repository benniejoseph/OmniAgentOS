import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentRequestInit,
  applyAssertion,
  evalConfig,
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
      minPassRate: 0.8,
      requestTimeoutMs: 60_000,
      tasksFile: path.resolve("evals/golden-tasks.json"),
      internalAuth: undefined,
      tenantId: undefined,
      actorId: undefined,
      modelSelection: undefined,
    });
  });

  it("reads a replay corpus as a workspace owner on a pinned model", () => {
    expect(evalConfig({
      BASE_URL: "https://candidate.asael.test",
      MIN_PASS_RATE: "0.9",
      EVAL_REQUEST_TIMEOUT_MS: "900000",
      EVAL_TASKS_FILE: "artifacts/ledger-replay.json",
      SMOKE_INTERNAL_AUTH_SECRET: "internal-secret",
      EVAL_TENANT_ID: " tenant-a ",
      EVAL_ACTOR_ID: " owner-a ",
      EVAL_MODEL_SELECTION: JSON.stringify(SELECTION),
    })).toEqual({
      baseUrl: "https://candidate.asael.test",
      minPassRate: 0.9,
      requestTimeoutMs: 300_000,
      tasksFile: path.resolve("artifacts/ledger-replay.json"),
      internalAuth: "internal-secret",
      tenantId: "tenant-a",
      actorId: "owner-a",
      modelSelection: SELECTION,
    });
  });

  it.each([
    [{ MIN_PASS_RATE: "1.5" }, /MIN_PASS_RATE/],
    [{ MIN_PASS_RATE: "-0.1" }, /MIN_PASS_RATE/],
    [{ MIN_PASS_RATE: "most" }, /MIN_PASS_RATE/],
    [{ EVAL_TENANT_ID: "tenant-a" }, /SMOKE_INTERNAL_AUTH_SECRET/],
    [{ EVAL_ACTOR_ID: "owner-a" }, /SMOKE_INTERNAL_AUTH_SECRET/],
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

  it("sends the workspace headers only with internal auth", () => {
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
        "x-omni-internal-auth": "internal-secret",
        "x-omni-user-role": "operator",
        "x-omni-tenant-id": "tenant-a",
        "x-omni-user-id": "owner-a",
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
        "x-omni-internal-auth": "internal-secret",
        "x-omni-user-role": "operator",
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
      estimatedCostUsd: 0.75,
      latencyMs: 0,
      fallbackCount: 1,
    });
  });

  it("joins the deltas when the stream ends without a final answer", () => {
    const stream = [
      `data: ${JSON.stringify({ type: "delta", text: "Draft " })}`,
      `data: ${JSON.stringify({ type: "delta", text: "answer." })}`,
    ].join("\n");

    expect(readAgentStream(stream)).toEqual({
      response: "Draft answer.",
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
