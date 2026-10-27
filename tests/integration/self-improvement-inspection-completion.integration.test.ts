/**
 * Opt-in receipt-bound inspection proof. Real PostgreSQL/RLS, runAgent,
 * governed executor, Builder service, run/audit stores and scope events.
 * Only model transport/readiness and the Sandbox transport are synthetic.
 * No live credentials, provider calls, cycle admission or application server.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationItem, streamResponseTurn } from "@/lib/openai/client";

const transport = vi.hoisted(() => ({ model: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/config", async original => ({
  ...await original<typeof import("@/lib/config")>(),
  // Test-provider readiness, never a dummy credential or application change.
  hasOpenAIKey: () => true, hasGeminiKey: () => false, hasAnthropicKey: () => false,
}));
vi.mock("@/lib/openai/client", async original => ({
  ...await original<typeof import("@/lib/openai/client")>(),
  streamResponseTurn: transport.model,
}));
vi.mock("@vercel/sandbox", () => ({
  APIError: class APIError extends Error {},
  Sandbox: { get: transport.sandbox, create: () => { throw new Error("Sandbox provisioning is outside this receipt fixture."); } },
}));

import { APP_BUILDER_ROOT, builderFileSha256 } from "@/lib/app-builder/contracts";
import { createBuilderSessionRecord, getBuilderSession, transitionBuilderSession } from "@/lib/app-builder/store";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService } from "@/lib/app-services/projects";
import { capabilityFunctionName } from "@/lib/capabilities/toolbox";
import { closeDatabaseClient, getDatabasePoolMax, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { getAgentRun, getAgentRunExecutionScope } from "@/lib/runs/store";
import * as runBudgets from "@/lib/runs/budgets";
import type { SecurityContext } from "@/lib/security/types";
import { runImprovementAgent } from "@/lib/self-improvement/agent";
import type { SelfImprovementExecutionAuthority } from "@/lib/self-improvement/authority";
import { inspectionCompletionReceiptSchema } from "@/lib/self-improvement/inspection-completion";
import { selfImprovementSha256 } from "@/lib/self-improvement/contracts";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { assertToolExecutionBindingMatchesRequest, getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";

const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `inspection-receipts-${randomUUID()}`;
const userId = randomUUID(), actorId = `actor:${userId}`, email = `${userId}@example.test`;
const role = `inspection_receipts_${randomBytes(6).toString("hex")}`;
const toolId = "app.projects.builder.file.read";
const sourcePath = "src/inspection-example.ts", adjacentPath = "src/inspection-example.test.ts";
const plan = {
  decision: "repair", plan: {
    summary: "Synthetic source inspection; no implementation or provider invocation.",
    sourcePaths: [sourcePath], newSourcePaths: [],
    focusedTestPaths: ["src/inspection-example-regression.test.ts"], adjacentTestPaths: [adjacentPath],
    acceptanceCriteria: ["Reject the synthetic capacity overflow before mutating history."],
  },
};
const files: Record<string, string> = {
  "AGENTS.md": "Read the selected source and adjacent test before proposing a repair.\n",
  [sourcePath]: "export const addCopies = (size: number, copies: number) => size + copies;\n",
  [adjacentPath]: "// Existing synthetic adjacent behavior: selection and history are preserved.\n",
};
const scoped = <T>(work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actorId, email], work);
const context: SecurityContext = { tenantId, actorId: email, source: "session", role: "admin",
  auth: { userId, email, sessionId: "synthetic-no-login", tenantName: "Inspection receipt fixture" } };
const execute = promisify(execFile);
type ModelRequest = Parameters<typeof streamResponseTurn>[0];
type ModelTurn = Awaited<ReturnType<typeof streamResponseTurn>>;

function modelTurn(request: ModelRequest, sequence: number, paths: string[] = [], text = ""): ModelTurn {
  const functionCalls = paths.map((file, index) => ({ callId: `fixture-${sequence}-${index}`, name: capabilityFunctionName(toolId),
    argumentsJson: JSON.stringify({ path: file, startLine: 1, lineCount: 20 }) }));
  const outputItems: ConversationItem[] = functionCalls.map(call => ({ type: "function_call", id: `item-${call.callId}`,
    call_id: call.callId, name: call.name, arguments: call.argumentsJson }));
  if (text) outputItems.push({ type: "message", role: "assistant", content: text });
  const usage = { inputTokens: 30, outputTokens: 20, cachedInputTokens: 0, totalTokens: 50 };
  return { responseId: `synthetic-inspection-${sequence}`, functionCalls, outputItems, text,
    model: request.model, fallbackUsed: false, latencyMs: 1, usage, estimatedCostUsd: 0.001,
    attempts: [{ provider: "openai", model: request.model, status: "completed", latencyMs: 1, usage, estimatedCostUsd: 0.001 }],
    usageReceiptRecorded: false };
}

candidate("self-improvement inspection completion with real governed receipts", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let roleCreated = false, directory: string, projectId: string, sessionId: string, sandboxName: string;
  let unavailablePath: string | undefined;
  const evidence: Record<string, unknown> = { scenario: "in-run inspection completion", providerTransport: "deterministic fixture",
    sandboxTransport: "local regular files", actualProviderCalls: 0, cycleAdmitted: false, deployed: false };

  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the existing isolated candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") {
      throw new Error("Only the isolated loopback candidate database is allowed.");
    }
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OMNIAGENT_SANDBOX_ACCESS_TOKEN",
      "OMNIAGENT_OPENAI_GATEWAY_TOKEN", "OMNIAGENT_INTERNAL_AUTH_SECRET", "OMNIAGENT_EXECUTION_PAYLOAD_SECRET"]) {
      if (process.env[key]?.trim()) throw new Error(`Live credential ${key} is forbidden in the deterministic fixture.`);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network transport in deterministic inspection."); }));
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(265);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Inspection receipt fixture',${tenantId})`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4"); vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    expect(getDatabasePoolMax()).toBe(1);
    directory = await mkdtemp(path.join(tmpdir(), "asael-inspection-receipts-"));
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), content, { mode: 0o600 });
    }
    transport.sandbox.mockImplementation(async (input: { name: string }) => {
      expect(input.name).toBe(sandboxName);
      return {
        runCommand: async (command: { cmd: string; args: string[] }) => {
          if (command.cmd !== "node" || command.args[0] !== "-e") throw new Error("Only Builder's fixed read inspectors are allowed.");
          try {
            const result = await execute(process.execPath, ["-e", command.args[1].replace(JSON.stringify(APP_BUILDER_ROOT), JSON.stringify(directory)), ...command.args.slice(2)],
              { maxBuffer: 1_000_000, timeout: 10_000 });
            return { exitCode: 0, durationMs: 1, stdout: async () => result.stdout, stderr: async () => result.stderr };
          } catch (error) {
            const failed = error as { stdout?: string; stderr?: string };
            return { exitCode: 1, durationMs: 1, stdout: async () => failed.stdout || "", stderr: async () => failed.stderr || "" };
          }
        },
        readFileToBuffer: async ({ path: requested }: { path: string }) => {
          if (!requested.startsWith(`${APP_BUILDER_ROOT}/`)) throw new Error("Unexpected file transport path.");
          if (requested === `${APP_BUILDER_ROOT}/${unavailablePath}`) return null;
          return readFile(path.join(directory, requested.slice(APP_BUILDER_ROOT.length + 1)));
        },
      };
    });
    await scoped(async () => {
      evidence.rls = (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_projects') AS projects,
        row_security_active('omni_tool_executions') AS tools FROM pg_roles WHERE rolname=current_user`)[0];
      expect(evidence.rls).toMatchObject({ rolsuper: false, rolbypassrls: false, projects: true, tools: true });
      await getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${email})`;
      const caller = createRequestMutationAppServiceCaller(new Request("https://fixture.invalid/api/projects", {
        method: "POST", headers: { "Idempotency-Key": `inspection-project-${randomUUID()}` },
      }), context, { purpose: "app.projects.create" });
      projectId = (await createProjectService(caller, { title: "Synthetic inspection receipt contract", objective: "Inspect the source and existing adjacent test before proposing a bounded repair." })).data.project.id;
      const created = await createBuilderSessionRecord({ tenantId, actorId, projectId, workspaceMode: "source_only", idempotencyKey: "inspection-source-fixture" });
      const ready = await transitionBuilderSession({ tenantId, actorId, session: created.session, status: "ready",
        eventType: "app_builder.session.ready", eventKey: "local-files-ready" });
      sessionId = ready.id; sandboxName = ready.sandboxName;
    });
  });

  afterAll(async () => {
    try {
      await closeDatabaseClient();
      if (admin && roleCreated) {
        await admin.unsafe(`DROP OWNED BY ${role}`);
        await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      }
      if (process.env.ASAEL_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_CANDIDATE_EVIDENCE_FILE,
        JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally {
      await admin?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });

  function authority(): SelfImprovementExecutionAuthority {
    return { tenantId, ownerActorId: actorId, projectId, sessionId, repositoryId: "synthetic-read-only", cycleId: `self_cycle_${"a".repeat(64)}`,
      policySha256: "b".repeat(64), expiresAt: new Date(Date.now() + 240_000).toISOString(), readOnly: true, allowedToolIds: [toolId],
      assertCurrent: async () => {
        expect(await getBuilderSession(sessionId, projectId, { tenantId, actorId })).toMatchObject({ id: sessionId, status: "ready", ownerActorId: actorId });
      } };
  }

  async function readRunReceipts(runId: string) {
    return scoped(async () => {
      const events = await listStreamEvents(`run:${runId}`, { tenantId, limit: 1_000, order: "asc" });
      const ids = [...new Set(events.filter(event => event.type === "run.tool" && typeof event.payload.executionId === "string")
        .map(event => String(event.payload.executionId)))];
      return { events, records: await getToolExecutionsByIds(ids, { tenantId }) };
    });
  }

  it("finishes unread adjacent-test evidence in the same real run before accepting its strict plan", async () => {
    const requests: Array<{ input: unknown; instructions: string | undefined; maxOutputTokens: number | undefined; toolChoice: string | undefined }> = [];
    let sequence = 0, runId = "";
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1;
      requests.push({ input: request.input, instructions: request.instructions, maxOutputTokens: request.maxOutputTokens, toolChoice: request.toolChoice });
      expect(sequence).toBeLessThanOrEqual(4);
      expect(request.tools?.some(tool => tool.name === capabilityFunctionName(toolId))).toBe(true);
      if (sequence === 1) return modelTurn(request, sequence, ["AGENTS.md", sourcePath]);
      if (sequence === 3) return modelTurn(request, sequence, [adjacentPath]);
      const text = JSON.stringify(plan);
      await request.onDelta(text);
      return modelTurn(request, sequence, [], text);
    });
    const result = await scoped(() => runImprovementAgent({ authority: authority(), agentId: "atlas",
      prompt: "Inspect the nominated source and its adjacent behavior. Read AGENTS.md and src/inspection-example.ts, then propose the bounded repair as strict JSON.",
      costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
    evidence.result = result; evidence.modelRequests = requests;
    const stored = await scoped(() => getAgentRun(runId, { tenantId }));
    const { events, records } = await readRunReceipts(runId);
    evidence.run = stored; evidence.events = events; evidence.receipts = records;
    expect(result.completion).toBe("complete");
    expect(sequence).toBe(4);
    expect(result.inspectedPaths).toEqual(expect.arrayContaining(["AGENTS.md", sourcePath, adjacentPath]));
    expect(result.measuredCostUsd).toBeCloseTo(0.004);
    // The visible transcript may retain an earlier rejected proposal. Only the
    // exact accepted typed result and its hash authorize the next app phase.
    expect(result.inspectionResult).toEqual(plan);
    const completion = inspectionCompletionReceiptSchema.parse(result.inspectionReceipt);
    expect(completion).toMatchObject({ outcome: "accepted", reason: "complete", runId, sessionId, correctionUsed: true,
      result: plan, resultSha256: selfImprovementSha256("inspection_result", plan) });
    expect(completion.reads.map(read => read.executionId).sort()).toEqual(records.map(record => record.id).sort());
    const feedback = events.filter(event => event.type === "run.status" && event.payload.inspectionCompletion)
      .map(event => event.payload.inspectionCompletion as { outcome: string; adjacentCandidates: string[]; runId: string });
    expect(feedback.map(item => item.outcome)).toEqual(["reminder", "needs_reads", "accepted"]);
    expect(feedback.find(item => item.outcome === "needs_reads")).toMatchObject({ runId, adjacentCandidates: [adjacentPath] });
    expect(requests[2].instructions).toContain("required governed reads are missing");
    expect(requests.every(request => request.maxOutputTokens === 4_000 && request.toolChoice !== "none")).toBe(true);
    expect(events.find(event => event.type === "run.harness")?.payload).toMatchObject({ maxToolSteps: 16, maxToolCallsPerTurn: 5,
      budgetLimitsSha256: canonicalJsonSha256({ modelTurns: 20, tokens: 100_000, costMicrousd: 1_000_000, wallTimeMs: 210_000,
        toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 }) });
    expect(stored).toMatchObject({ id: runId, status: "completed" });
    expect(await scoped(() => getAgentRunExecutionScope(runId, { tenantId }))).toMatchObject({ projectId, initiatingActorId: actorId, correlationId: runId });
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({ status: "executed", actorId, tenantId, dryRun: false });
      const binding = await scoped(() => getToolExecutionScopeBinding(record.id, { tenantId }));
      expect(binding?.executionScope).toMatchObject({ projectId, initiatingActorId: actorId, correlationId: runId });
      expect(record.input).toMatchObject({ projectId, sessionId, startLine: 1, lineCount: 20 });
      assertToolExecutionBindingMatchesRequest({ binding: binding!, record, toolInput: record.input });
      expect(JSON.stringify(record.output)).toContain(builderFileSha256(files[String(record.input.path)]));
    }
    const budgetRows = await admin!`SELECT COUNT(*) AS count FROM omni_self_improvement_cycles WHERE tenant_id=${tenantId}`;
    expect(Number(budgetRows[0].count)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["foreign_scope", "missing_receipt", "failed_read"] as const)("never admits %s evidence from otherwise valid model output", async fault => {
    let sequence = 0, runId = "", changed = false;
    unavailablePath = fault === "failed_read" ? adjacentPath : undefined;
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1;
      expect(sequence).toBeLessThanOrEqual(3);
      if (sequence === 1) return modelTurn(request, sequence, ["AGENTS.md", sourcePath, adjacentPath]);
      if (!changed && fault !== "failed_read") {
        const { records } = await readRunReceipts(runId);
        const target = records.find(record => record.input.path === adjacentPath);
        expect(target?.status).toBe("executed");
        // Deliberate damage to this synthetic test's own durable row only.
        // The real scope event remains unchanged; the adapter must reject it.
        if (fault === "foreign_scope") {
          await admin!`UPDATE omni_tool_executions SET input=jsonb_set(input,'{projectId}','"foreign-project"'::jsonb)
            WHERE id=${target!.id} AND tenant_id=${tenantId}`;
        } else {
          await admin!`DELETE FROM omni_tool_executions WHERE id=${target!.id} AND tenant_id=${tenantId}`;
        }
        changed = true;
      }
      const text = JSON.stringify(plan);
      await request.onDelta(text);
      return modelTurn(request, sequence, [], text);
    });
    let result: Awaited<ReturnType<typeof runImprovementAgent>> | undefined;
    try {
      result = await scoped(() => runImprovementAgent({ authority: authority(), agentId: "atlas",
        prompt: "Inspect AGENTS.md, src/inspection-example.ts and its existing adjacent test, then return the bounded repair plan.",
        costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
    } catch (error) {
      if (fault !== "foreign_scope") throw error;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Self-improvement atlas run failed; inspect its retained receipt.");
      const stored = await scoped(() => getAgentRun(runId, { tenantId }));
      const readback = await readRunReceipts(runId);
      evidence[fault] = { stored, ...readback, modelTurns: sequence, stimulus: "Own-fixture identity mutation refused by PostgreSQL" };
      expect(stored).toMatchObject({ status: "failed", error: "Governed tool execution identity is immutable" });
      expect(readback.records.find(record => record.input.path === adjacentPath)?.input.projectId).toBe(projectId);
      expect(readback.events.some(event => event.type === "run.status" &&
        (event.payload.inspectionCompletion as { outcome?: string } | undefined)?.outcome === "accepted")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    const readback = await readRunReceipts(runId);
    if (!result) throw new Error("The ordinary receipt scenario returned no completion.");
    evidence[fault] = { result, ...readback, modelTurns: sequence };
    expect(result.completion).not.toBe("complete");
    expect(result.inspectionResult).toBeUndefined();
    expect(result.inspectionReceipt).toBeUndefined();
    const last = readback.events.filter(event => event.type === "run.status" && event.payload.inspectionCompletion).at(-1);
    expect(inspectionCompletionReceiptSchema.parse(last?.payload.inspectionCompletion)).toMatchObject({ outcome: "rejected", runId, sessionId,
      reason: fault === "failed_read" ? "missing_plan_reads" : "evidence_unavailable" });
    expect(result.measuredCostUsd).toBeCloseTo(sequence * 0.001);
    if (fault === "failed_read") expect(readback.records.find(record => record.input.path === adjacentPath)?.status).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
    unavailablePath = undefined;
  });

  it("stops before another reservation when owner authority is revoked after the durable reminder", async () => {
    const planner = vi.spyOn(runBudgets, "planModelTurnBudget");
    let sequence = 0, runId = "", revoked = false;
    const boundAuthority = authority();
    const checkedAuthority: SelfImprovementExecutionAuthority = { ...boundAuthority, assertCurrent: async () => {
      await boundAuthority.assertCurrent();
      if (runId && !revoked) {
        const { events } = await readRunReceipts(runId);
        const outcomes = events.filter(event => event.type === "run.status" && event.payload.inspectionCompletion)
          .map(event => inspectionCompletionReceiptSchema.parse(event.payload.inspectionCompletion).outcome);
        if (outcomes.includes("needs_reads")) {
          expect(outcomes).toEqual(["reminder", "needs_reads"]);
          expect(sequence).toBe(2);
          // Revoke only this synthetic owner's membership, after the real
          // reminder/correction receipts and before the next turn admission.
          await admin!`UPDATE omni_auth_memberships SET role='viewer' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
          revoked = true;
        }
      }
      const membership = await getSql()`SELECT role FROM omni_auth_memberships WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      if (membership[0]?.role !== "admin") throw new Error("Synthetic owner execution authority was revoked.");
    } };
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1;
      expect(sequence).toBeLessThanOrEqual(2);
      if (sequence === 1) return modelTurn(request, sequence, ["AGENTS.md", sourcePath]);
      expect(request.instructions).toContain("no existing adjacent test file has been read");
      const text = JSON.stringify(plan);
      await request.onDelta(text);
      return modelTurn(request, sequence, [], text);
    });
    try {
      const result = await scoped(() => runImprovementAgent({ authority: checkedAuthority, agentId: "atlas",
        prompt: "Inspect the synthetic source and its adjacent test before returning a bounded repair plan.",
        costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
      const readback = await readRunReceipts(runId);
      const receipts = readback.events.filter(event => event.type === "run.status" && event.payload.inspectionCompletion)
        .map(event => inspectionCompletionReceiptSchema.parse(event.payload.inspectionCompletion));
      const membership = await admin!`SELECT role FROM omni_auth_memberships WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      evidence.authority_revoked = { result, ...readback, membershipRole: membership[0]?.role,
        modelTurns: sequence, plannerCalls: planner.mock.calls.length, actualProviderSpendUsd: 0 };
      expect(revoked).toBe(true); expect(membership[0]?.role).toBe("viewer");
      expect(sequence).toBe(2); expect(planner).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ completion: "inspection_evidence_unavailable", measuredCostUsd: 0.002 });
      expect(result.inspectionResult).toBeUndefined(); expect(result.inspectionReceipt).toBeUndefined();
      expect(receipts.map(receipt => receipt.outcome)).toEqual(["reminder", "needs_reads", "rejected"]);
      expect(receipts.at(-1)).toMatchObject({ reason: "evidence_unavailable", correctionUsed: true, runId, sessionId });
      expect(readback.events.filter(event => event.type === "run.model")).toHaveLength(2);
      expect(readback.records).toHaveLength(2);
      expect(readback.records.every(record => record.status === "executed")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await admin!`UPDATE omni_auth_memberships SET role='admin' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      planner.mockRestore();
    }
  });

  it.each([{ spentTokens: 85_000, boundary: "final-only" }, { spentTokens: 97_000, boundary: "reservation-exhausted" }])(
    "refuses completion before spending when the real planner is $boundary", async ({ spentTokens, boundary }) => {
      // Call-through instrumentation: the ordinary planner and its real state
      // transitions execute unchanged. No simulated reservationRefused result.
      const planner = vi.spyOn(runBudgets, "planModelTurnBudget");
      let sequence = 0, runId = "";
      transport.model.mockImplementation(async (request: ModelRequest) => {
        sequence += 1;
        expect(sequence).toBeLessThanOrEqual(2);
        expect(request.toolChoice).not.toBe("none");
        const text = sequence === 2 ? JSON.stringify(plan) : "";
        if (text) await request.onDelta(text);
        const turn = modelTurn(request, sequence, sequence === 1 ? ["AGENTS.md", sourcePath] : [], text);
        const totalTokens = sequence === 1 ? 35_000 : spentTokens - 35_000;
        const usage = { inputTokens: totalTokens - 20, outputTokens: 20, cachedInputTokens: 0, totalTokens };
        return { ...turn, usage, attempts: turn.attempts.map(attempt => ({ ...attempt, usage })) };
      });
      try {
        const result = await scoped(() => runImprovementAgent({ authority: authority(), agentId: "atlas",
          prompt: "Inspect AGENTS.md and src/inspection-example.ts, then return the bounded repair plan after reading its adjacent test.",
          costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
        const readback = await readRunReceipts(runId);
        const receipts = readback.events.filter(event => event.type === "run.status" && event.payload.inspectionCompletion)
          .map(event => inspectionCompletionReceiptSchema.parse(event.payload.inspectionCompletion));
        const planning = planner.mock.calls.map(([state, input], index) => ({ state, input,
          result: planner.mock.results[index].type === "return" ? planner.mock.results[index].value : undefined,
          error: planner.mock.results[index].type === "throw" ? String(planner.mock.results[index].value) : undefined }));
        evidence[`budget_${boundary}`] = { result, ...readback, planning, modelTurns: sequence, actualProviderSpendUsd: 0 };
        expect(sequence).toBe(2);
        expect(result).toMatchObject({ completion: "inspection_incomplete", measuredCostUsd: 0.002 });
        expect(result.inspectionResult).toBeUndefined(); expect(result.inspectionReceipt).toBeUndefined();
        expect(receipts.map(receipt => receipt.outcome)).toEqual(["reminder", "needs_reads", "rejected"]);
        expect(receipts.at(-1)).toMatchObject({ reason: "completion_budget_unavailable", correctionUsed: true, runId, sessionId });
        expect(planner).toHaveBeenCalledTimes(3);
        const [state, input] = planner.mock.calls[2];
        expect(state.used).toMatchObject({ modelTurns: 2, tokens: spentTokens, costMicrousd: 2_000, toolCalls: 2, retries: 0 });
        expect(state.limits).toMatchObject({ modelTurns: 20, tokens: 100_000, costMicrousd: 1_000_000, toolCalls: 48 });
        expect(input.toolsEnabled).toBe(true);
        const finalPlan = planner.mock.results[2];
        if (boundary === "final-only") {
          expect(finalPlan.type).toBe("return");
          expect(finalPlan.value).toMatchObject({ finalTurn: true, state: { used: { modelTurns: 3 } } });
        } else {
          expect(finalPlan.type).toBe("throw");
          expect(finalPlan.value).toBeInstanceOf(runBudgets.RunBudgetExceededError);
        }
        expect(readback.events.filter(event => event.type === "run.model")).toHaveLength(2);
        expect(readback.records).toHaveLength(2);
        expect(readback.records.every(record => record.status === "executed")).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally { planner.mockRestore(); }
    },
  );
});
