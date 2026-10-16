import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import type { ModelToolCall, ModelToolTurnRequest, ModelToolTurnResult } from "@/lib/models/types";
import { runNonOpenAIProviderToolLoop } from "@/lib/orchestration/agent-runner";
import { getProject } from "@/lib/projects/store";
import type { PersonalProject } from "@/lib/projects/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";

// Exercise the real provider loop, executor, service, policy, project store and
// event ledger. The model turns are deterministic; no provider or live data is used.
vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

const context: SecurityContext = {
  tenantId: "project-length-recovery", actorId: "owner@example.test", role: "operator", source: "session",
};
const runId = "project-length-recovery-run";
const executionScope = createExecutionScope({
  tenantId: context.tenantId, initiatingActorId: context.actorId,
  executingPrincipalType: "agent", executingPrincipalId: "agent:atlas:length-recovery",
  correlationId: runId, purpose: "agent.run",
});
let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-project-recovery-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_GRADUATED_AUTONOMY", "false");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("project length recovery in the governed provider loop", () => {
  it("returns structured failure, accepts a model-proposed correction under a new identity and verifies full readback", async () => {
    const created = await executeGovernedTool({
      toolId: "app.projects.create", context, executionScope, idempotencyKey: "recovery:create", dryRun: false,
      input: { title: "Isolated recovery fixture", objective: "Original objective.", targetDate: "2026-10-17T12:00:00.000Z" },
    });
    expect(created.record.status, created.record.reason).toBe("executed");
    const project = (created.result as { project: PersonalProject }).project;
    const before = await getProject(project.id, context);
    const commitments = "Maya owns delivery on 2026-10-20. Depends on sandbox access. Accept 25 complete records and Priya's written approval. Unresolved: sandbox access.\n\n";
    const correctedObjective = commitments + "Review the recorded mapping evidence. ".repeat(60).slice(0, 1_999 - commitments.length) + ".";
    expect(correctedObjective).toHaveLength(2_000);
    const requested = { projectId: project.id, objective: `${correctedObjective} Another sentence.`, targetDate: "2026-10-20T12:00:00.000Z" };
    const corrected = { ...requested, objective: correctedObjective };
    const executeTool = vi.fn(executeGovernedTool);
    let modelTurn = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      modelTurn += 1;
      if (modelTurn === 1) return turn([{ callId: "oversized", name: "project_update", argumentsJson: JSON.stringify(requested) }]);
      const output = request.toolResults?.at(-1);
      expect(output).toBeDefined();
      const envelope = JSON.parse(output!.output);
      expect(envelope).toMatchObject({ provenance: "tool_result", trust: "untrusted_data" });
      if (modelTurn === 2) {
        expect(output?.isError).toBe(true);
        expect(envelope.data).toMatchObject({ status: "failed", result: null, recovery: {
          version: 1, kind: "text_length", operation: "app.projects.update", field: "objective",
          actual: 2_018, limit: 2_000, overBy: 18, mutationApplied: false, retry: "revise_input",
        } });
        expect(envelope.data.recovery.nextStep).toContain("new idempotency identity");
        expect(envelope.data.recovery.nextStep).toContain("read back");
        expect(envelope.data.recovery.nextStep).toContain("acceptance criteria, owners, dates, dependencies");
        expect(output!.output).not.toContain("Maya");
        expect(await getProject(project.id, context)).toEqual(before);
        expect((await listStreamEvents(`project:${project.id}`, context)).map((event) => event.type)).toEqual(["project.created"]);
        return turn([{ callId: "corrected", name: "project_update", argumentsJson: JSON.stringify(corrected) }]);
      }
      if (modelTurn === 3) {
        expect(output?.isError).not.toBe(true);
        expect(envelope.data.status).toBe("executed");
        expect(envelope.data.recovery).toBeUndefined();
        return turn([{ callId: "readback", name: "project_show", argumentsJson: JSON.stringify({ projectId: project.id, includeFullObjective: true }) }]);
      }
      expect(modelTurn).toBe(4);
      expect(output?.isError).not.toBe(true);
      expect(envelope.data).toMatchObject({ status: "executed", result: {
        project: { id: project.id, objective: correctedObjective, targetDate: corrected.targetDate },
        omissions: { objective: false },
      } });
      return turn([], "The revised objective is saved and its full content and target date were read back.");
    });
    const tools = [["project_update", "app.projects.update"], ["project_show", "app.projects.show"]].map(([functionName, id]) => ({
      functionName, definition: getGovernedTool(id)!,
    }));
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Preserve every material commitment when saving a brief and verify the saved fields.",
      prompt: "Update this owned project with the supplied objective and target date, then read it back.",
      tools: tools.map(({ functionName, definition }) => ({ type: "function", name: functionName, description: definition.description, parameters: definition.inputSchema })),
      toolbox: { byFunctionName: new Map(tools.map((entry) => [entry.functionName, entry])) },
      securityContext: context, executionScope, runId, maxToolSteps: 4,
      generateTurn, executeTool,
    });
    const events = [];
    let result;
    while (true) {
      const next = await loop.next();
      if (next.done) { result = next.value; break; }
      events.push(next.value);
    }
    expect(result).toMatchObject({ toolSteps: 3, turns: 4, deferredToolCallHashes: [] });
    expect(executeTool).toHaveBeenCalledTimes(3);
    const attempts = await Promise.all(executeTool.mock.results.map((result) => result.value));
    expect(attempts.map(({ record }) => record.status)).toEqual(["failed", "executed", "executed"]);
    expect(new Set(attempts.map(({ record }) => record.id)).size).toBe(3);
    expect(executeTool.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      `${runId}:google:oversized`, `${runId}:google:corrected`, `${runId}:google:readback`,
    ]);
    const failedRequest = executeTool.mock.calls[0][0];
    expect(await executeGovernedTool(failedRequest)).toEqual(attempts[0]);
    await expect(executeGovernedTool({ ...failedRequest, input: corrected })).rejects.toThrow();
    expect(await getProject(project.id, context)).toMatchObject({ objective: correctedObjective, targetDate: corrected.targetDate });
    const ledger = await listStreamEvents(`project:${project.id}`, context);
    expect(ledger.map((event) => event.type)).toEqual(["project.created", "project.updated"]);
    expect(ledger.every((event) => event.actorId === context.actorId && event.executionScope?.executingPrincipalId === executionScope.executingPrincipalId)).toBe(true);
    expect(events.filter((event) => event.type === "tool" && event.status === "failed")).toHaveLength(1);
  });
});

function turn(toolCalls: ModelToolCall[], text = ""): ModelToolTurnResult {
  return {
    text, toolCalls, continuation: { provider: "google", state: [] }, provider: "google", model: "deterministic-test",
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }, latencyMs: 0,
    costKnown: true, estimatedCostUsd: 0, attempts: [{ provider: "google", model: "deterministic-test", status: "completed", latencyMs: 0 }],
  };
}
