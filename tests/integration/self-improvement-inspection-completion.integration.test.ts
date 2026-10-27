/**
 * Opt-in receipt-bound inspection proof. Real PostgreSQL/RLS, runAgent,
 * governed executor, Builder service, run/audit stores and scope events.
 * Only model transport/readiness and the Sandbox transport are synthetic.
 * No live credentials, provider calls or application server. One explicit
 * companion admits a synthetic local cycle through the real worker lifecycle.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import * as modelCheckpoints from "@/lib/runs/boundary-checkpoint-shadow";
import { RUN_CHECKPOINT_CAPABILITY_ID, RUN_CHECKPOINT_CONTRACT_VERSION_ID, RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256 } from "@/lib/runs/approval-checkpoint-shadow";
import { parseRunCheckpointV1 } from "@/lib/runs/checkpoints";
import { parseRunContractEnvelopeV1 } from "@/lib/runs/contracts";
import { getCurrentTenantCapabilityRollout, registerTenantCapabilityRollout,
  transitionTenantCapabilityRolloutStatus } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { runImprovementAgent } from "@/lib/self-improvement/agent";
import type { SelfImprovementExecutionAuthority } from "@/lib/self-improvement/authority";
import { inspectionCompletionReceiptSchema } from "@/lib/self-improvement/inspection-completion";
import { selfImprovementSha256 } from "@/lib/self-improvement/contracts";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle,
  pauseSelfImprovement, releaseSelfImprovementExecutionLease, updateSelfImprovementCycleRuntime } from "@/lib/self-improvement/store";
import { executeSelfImprovementJob } from "@/lib/self-improvement/worker";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { assertToolExecutionBindingMatchesRequest, getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import { governedToolExecutionId } from "@/lib/tools/execution-id";

const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `inspection-receipts-${randomUUID()}`;
const userId = randomUUID(), actorId = `actor:${userId}`, email = `${userId}@example.test`;
const role = `inspection_receipts_${randomBytes(6).toString("hex")}`;
const toolId = "app.projects.builder.file.read";
const searchToolId = "app.projects.builder.search";
const sourcePath = "src/inspection-example.ts", adjacentPath = "src/inspection-example.test.ts";
const capturedSourcePath = "src/components/studio/state.ts";
const capturedAdjacentPath = "src/components/studio/state.test.ts";
// Public source from538, byte-equal to the exact captured governed file result.
// No owner identifiers, private transcript or production receipt is included.
const capturedSource = readFileSync(new URL("../fixtures/self-improvement/studio-state-538e5f72.txt", import.meta.url), "utf8");
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
  [capturedSourcePath]: capturedSource,
  [capturedAdjacentPath]: "// Synthetic adjacent test fixture, not the original production test.\n// Selection and undo behavior are the adjacent acceptance criteria.\n",
};
const scoped = <T>(work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actorId, email], work);
const context: SecurityContext = { tenantId, actorId: email, source: "session", role: "admin",
  auth: { userId, email, sessionId: "synthetic-no-login", tenantName: "Inspection receipt fixture" } };
const execute = promisify(execFile);
type ModelRequest = Parameters<typeof streamResponseTurn>[0];
type ModelTurn = Awaited<ReturnType<typeof streamResponseTurn>>;

function modelTurn(request: ModelRequest, sequence: number, paths: string[] = [], text = "", lineCount = 20): ModelTurn {
  const functionCalls = paths.map((file, index) => ({ callId: `fixture-${sequence}-${index}`, name: capabilityFunctionName(toolId),
    argumentsJson: JSON.stringify({ path: file, startLine: 1, lineCount }) }));
  const outputItems: ConversationItem[] = functionCalls.map(call => ({ type: "function_call", id: `item-${call.callId}`,
    call_id: call.callId, name: call.name, arguments: call.argumentsJson }));
  if (text) outputItems.push({ type: "message", role: "assistant", content: text });
  const usage = { inputTokens: 30, outputTokens: 20, cachedInputTokens: 0, totalTokens: 50 };
  return { responseId: `synthetic-inspection-${sequence}`, functionCalls, outputItems, text,
    model: request.model, fallbackUsed: false, latencyMs: 1, usage, estimatedCostUsd: 0.001,
    attempts: [{ provider: "openai", model: request.model, status: "completed", latencyMs: 1, usage, estimatedCostUsd: 0.001 }],
    usageReceiptRecorded: false };
}

function toolModelTurn(request: ModelRequest, sequence: number, tools: Array<{ id: string; input: Record<string, unknown> }>): ModelTurn {
  const turn = modelTurn(request, sequence);
  const functionCalls = tools.map((tool, index) => ({ callId: `workflow-${sequence}-${index}`,
    name: capabilityFunctionName(tool.id), argumentsJson: JSON.stringify(tool.input) }));
  return { ...turn, functionCalls, outputItems: functionCalls.map(call => ({ type: "function_call", id: `item-${call.callId}`,
    call_id: call.callId, name: call.name, arguments: call.argumentsJson })) };
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

  async function enrollExpandedCheckpoints() {
    return scoped(async () => {
      const executionScope = createExecutionScope({ tenantId, initiatingActorId: actorId,
        executingPrincipalType: "user", executingPrincipalId: actorId, correlationId: randomUUID(),
        purpose: "inspection_checkpoint_fixture" });
      let enrollment = await getCurrentTenantCapabilityRollout({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID });
      if (!enrollment) {
        await registerTenantCapabilityRollout({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
          rolloutGeneration: 1, engineVersion: RUN_CHECKPOINT_ENGINE_VERSION_ID,
          contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
          configurationSha256: RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256, mode: "canary", executionScope });
        await transitionTenantCapabilityRolloutStatus({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
          expectedRolloutGeneration: 1, expectedStatus: "registered", nextStatus: "active", executionScope });
        enrollment = await getCurrentTenantCapabilityRollout({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID });
      }
      expect(enrollment).toMatchObject({ status: "active", rolloutGeneration: 1, lifecycleRevision: 1,
        mode: "canary", configurationSha256: RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256 });
      return enrollment;
    });
  }

  async function readEnrolledRun(runId: string) {
    const readback = await readRunReceipts(runId);
    const workflowIds = [1, 2].map(index => governedToolExecutionId(tenantId, `${runId}:inspection-workflow-read-${index}`));
    const workflowRecords = await scoped(() => getToolExecutionsByIds(workflowIds, { tenantId }));
    const checkpointRows = await scoped(() => getSql()`SELECT checkpoint_json FROM omni_run_checkpoints
      WHERE tenant_id=${tenantId} AND actor_id=${actorId} AND run_id=${runId} ORDER BY sequence`);
    const checkpoints = checkpointRows.map(row => parseRunCheckpointV1(row.checkpoint_json));
    const bindings = await scoped(() => Promise.all(workflowIds.map(id => getToolExecutionScopeBinding(id, { tenantId }))));
    return { ...readback, workflowIds, workflowRecords, checkpoints, bindings };
  }

  function assertEnrolledCheckpointChain(readback: Awaited<ReturnType<typeof readEnrolledRun>>, capturedEnvelope: unknown) {
    // The call-through checkpoint spy captures the real runner envelope; its
    // serialized digest must match the durable manifest event. Checkpoints use
    // a separate canonical JSON digest, so do not compare those two conventions.
    const envelope = parseRunContractEnvelopeV1(capturedEnvelope);
    expect(envelope).toBeDefined();
    const resolved = readback.events.find(event => event.type === "run.manifests.resolved");
    expect(resolved?.payload).toMatchObject({ envelopeId: envelope!.envelopeId,
      envelopeSha256: createHash("sha256").update(JSON.stringify(envelope)).digest("hex"),
      harnessManifestId: envelope!.harnessManifest.harnessManifestId });
    expect(readback.checkpoints.length).toBeGreaterThan(0);
    readback.checkpoints.forEach((checkpoint, index) => {
      expect(checkpoint.enginePin).toEqual({ rolloutCapabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
        engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID, contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
        configurationSha256: RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256,
        runContractEnvelopeId: envelope!.envelopeId, runContractEnvelopeSha256: canonicalJsonSha256(envelope),
        harnessManifestId: envelope!.harnessManifest.harnessManifestId,
        harnessManifestSha256: canonicalJsonSha256(envelope!.harnessManifest),
        rolloutMode: "canary", rolloutLifecycleStatus: "active", rolloutGeneration: 1, rolloutLifecycleRevision: 1 });
      expect(checkpoint.runId).toBe(envelope!.runId);
      expect(checkpoint.executionScope).toMatchObject({ tenantId, initiatingActorId: actorId, projectId, correlationId: envelope!.runId });
      expect(checkpoint.sequence).toBe(index);
      const previous = readback.checkpoints[index - 1];
      expect(checkpoint.parent).toEqual(previous ? { checkpointId: previous.checkpointId,
        checkpointSha256: previous.checkpointSha256, sequence: previous.sequence } : null);
    });
    expect(readback.checkpoints.at(-1)?.resourceUsage.externalEffectCount).toBe(0);
    return envelope;
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

  it("delivers the captured 8834-character source with truthful model-facing whole-line coverage", async () => {
    expect(capturedSource.length).toBe(8_834);
    expect(builderFileSha256(capturedSource)).toBe("32f5f2a736aa4c37100ee04c9784161f936cc256a7b7790465bd28c89fe4bb8c");
    let sequence = 0, runId = "";
    const outputs: Array<{ raw: string; envelope: Record<string, unknown> }> = [];
    const capturedPlan = { ...plan, plan: { ...plan.plan, sourcePaths: [capturedSourcePath] } };
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1; expect(sequence).toBeLessThanOrEqual(2);
      if (sequence === 1) return modelTurn(request, sequence, ["AGENTS.md", capturedSourcePath, adjacentPath], "", 400);
      if (Array.isArray(request.input)) for (const item of request.input) {
        if (item.type === "function_call_output" && typeof item.output === "string") {
          outputs.push({ raw: item.output, envelope: JSON.parse(item.output) as Record<string, unknown> });
        }
      }
      const text = JSON.stringify(capturedPlan); await request.onDelta(text);
      return modelTurn(request, sequence, [], text);
    });
    const result = await scoped(() => runImprovementAgent({ authority: authority(), agentId: "atlas",
      prompt: "Read AGENTS.md, the captured Studio source and its adjacent test, then return the repair plan.",
      costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
    const readback = await readRunReceipts(runId);
    evidence.captured_projection = { result, ...readback, outputs, modelTurns: sequence };
    const delivered = outputs.map(item => ({ ...item, data: item.envelope.data as { executionId: string; result: {
      file?: { path: string; content: string; lineRange: { startLine: number; endLine: number; totalLines: number; truncated: boolean };
        projection?: { nextRead?: { path: string; startLine: number; lineCount: number } } } } } }))
      .find(item => item.data?.result?.file?.path === capturedSourcePath);
    expect(delivered).toBeDefined();
    const file = delivered!.data.result.file!;
    expect(delivered!.envelope).toMatchObject({ provenance: "tool_result", trust: "untrusted_data" });
    expect(delivered!.raw.length).toBeLessThanOrEqual(8_000);
    expect(file.lineRange.endLine - file.lineRange.startLine + 1).toBe(file.content.split(/\r?\n/).length);
    expect(file.content).toContain("export function duplicateGraphNodes(");
    expect(file.lineRange.totalLines).toBe(311);
    if (file.content.length < capturedSource.length) {
      expect(file.lineRange.truncated).toBe(true);
      expect(file.projection?.nextRead).toMatchObject({ path: capturedSourcePath, startLine: file.lineRange.endLine + 1 });
      expect(file.content).toBe(capturedSource.split("\n").slice(file.lineRange.startLine - 1, file.lineRange.endLine).join("\n"));
    }
    expect(result.inspectionResult).toEqual(capturedPlan);
    expect(result.measuredCostUsd).toBeCloseTo(0.002);
    expect(sequence).toBe(2); expect(readback.records).toHaveLength(3);
    const record = readback.records.find(item => item.id === delivered!.data.executionId)!;
    const binding = await scoped(() => getToolExecutionScopeBinding(record.id, { tenantId }));
    expect(record).toMatchObject({ actorId, tenantId, status: "executed", input: { projectId, sessionId, path: capturedSourcePath, startLine: 1, lineCount: 400 } });
    assertToolExecutionBindingMatchesRequest({ binding: binding!, record, toolInput: record.input });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finishes discovered inspection prerequisites through the real executor before another broad search", async () => {
    const planner = vi.spyOn(runBudgets, "planModelTurnBudget");
    let sequence = 0, runId = "";
    const inputs: unknown[] = [];
    const proposedCalls: Array<{ sequence: number; toolId: string; input: Record<string, unknown> }> = [];
    const capturedPlan = { ...plan, plan: { ...plan.plan, sourcePaths: [capturedSourcePath], adjacentTestPaths: [capturedAdjacentPath] } };
    let beforeBroadSearch: Awaited<ReturnType<typeof readRunReceipts>> | undefined;
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1; inputs.push(request.input); expect(sequence).toBeLessThanOrEqual(3);
      const calls = sequence === 1 ? [
        { id: toolId, input: { path: "AGENTS.md", startLine: 1, lineCount: 20 } },
        { id: searchToolId, input: { query: "src/components/studio/" } },
        { id: toolId, input: { path: capturedSourcePath, startLine: 1, lineCount: 400 } },
      ] : sequence === 2 ? [{ id: searchToolId, input: { query: "duplicateGraphNodes" } }] : [];
      if (sequence === 2) beforeBroadSearch = await readRunReceipts(runId);
      for (const call of calls) proposedCalls.push({ sequence, toolId: call.id, input: call.input });
      if (calls.length) return toolModelTurn(request, sequence, calls);
      const text = JSON.stringify(capturedPlan); await request.onDelta(text); return modelTurn(request, sequence, [], text);
    });
    let result: Awaited<ReturnType<typeof runImprovementAgent>>;
    let planning: Array<{ state: Parameters<typeof runBudgets.planModelTurnBudget>[0]; input: Parameters<typeof runBudgets.planModelTurnBudget>[1] }>;
    try {
      result = await scoped(() => runImprovementAgent({ authority: { ...authority(), allowedToolIds: [toolId, searchToolId] }, agentId: "atlas",
        prompt: "Discover the nominated Studio source and nearby test, inspect the source, then interpret the recorded context and return a bounded plan.",
        costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
      planning = planner.mock.calls.map(([state, input]) => ({ state, input }));
    } finally { planner.mockRestore(); }
    const readback = await readRunReceipts(runId);
    evidence.inspection_workflow = { result, ...readback, beforeBroadSearch, inputs, proposedCalls, planning, modelTurns: sequence };
    expect(beforeBroadSearch).toBeDefined();
    const supplied = beforeBroadSearch!.records.filter(record => record.toolId === toolId && record.input.path !== "AGENTS.md");
    expect(supplied.some(record => record.input.path === capturedAdjacentPath && record.status === "executed")).toBe(true);
    expect(supplied.some(record => record.input.path === capturedSourcePath && Number(record.input.startLine) > 1 && record.status === "executed")).toBe(true);
    expect(supplied).toHaveLength(3);
    expect(proposedCalls.some(call => call.input.path === capturedAdjacentPath || Number(call.input.startLine) > 1)).toBe(false);
    const sourceReceipt = supplied.find(record => record.input.path === capturedSourcePath && record.input.startLine === 1)!;
    const discoveryReceipt = beforeBroadSearch!.records.find(record => record.toolId === searchToolId)!;
    const workflow = beforeBroadSearch!.events.filter(event => event.type === "run.status")
      .map(event => (event.payload.inspectionCompletion as { workflowContext?: { origin: string; requests: unknown[]; executionIds: string[] } } | undefined)?.workflowContext)
      .find(value => value?.executionIds.length === 2);
    expect(workflow).toMatchObject({ origin: "inspection_workflow", requests: expect.arrayContaining([
      expect.objectContaining({ kind: "adjacent_test", path: capturedAdjacentPath,
        sourceExecutionId: sourceReceipt.id, discoveryExecutionId: discoveryReceipt.id }),
      expect.objectContaining({ kind: "source_continuation", path: capturedSourcePath,
        sourceExecutionId: sourceReceipt.id, discoveryExecutionId: discoveryReceipt.id }),
    ]) });
    expect(workflow!.executionIds.every(id => supplied.some(record => record.id === id))).toBe(true);
    const secondInput = inputs[1] as ConversationItem[];
    expect(Array.isArray(secondInput)).toBe(true);
    // Workflow context is an observation, not fictitious model tool calls.
    expect(secondInput.filter(item => item.type === "function_call")).toHaveLength(3);
    const deliveredSearch = secondInput.filter(item => item.type === "function_call_output" && typeof item.output === "string")
      .map(item => JSON.parse((item as { output: string }).output) as { provenance: string; trust: string; data: { result: {
        query?: string; search?: unknown; entries?: Array<{ path: string }> } } })
      .find(item => item.data?.result?.query === "src/components/studio/");
    expect(deliveredSearch).toMatchObject({ provenance: "tool_result", trust: "untrusted_data", data: { result: {
      search: { mode: "literal_substring", filenameCaseSensitive: false, contentCaseSensitive: true },
      entries: expect.arrayContaining([expect.objectContaining({ path: capturedAdjacentPath })]),
    } } });
    expect(JSON.stringify(inputs[1])).toContain("inspection_workflow");
    expect(JSON.stringify(inputs[1])).toContain("duplicateGraphNodes");
    expect(JSON.stringify(inputs[1])).toContain("Selection and undo behavior are the adjacent acceptance criteria.");
    expect(JSON.stringify(inputs[1])).toContain("maxGenerations: body.maxGenerations");
    for (const record of supplied) {
      const binding = await scoped(() => getToolExecutionScopeBinding(record.id, { tenantId }));
      expect(record).toMatchObject({ actorId, tenantId, status: "executed", input: { projectId, sessionId } });
      expect(binding?.executionScope).toMatchObject({ correlationId: runId, projectId, initiatingActorId: actorId });
      assertToolExecutionBindingMatchesRequest({ binding: binding!, record, toolInput: record.input });
    }
    expect(result.inspectionResult).toEqual(capturedPlan);
    expect(sequence).toBe(3); expect(result.measuredCostUsd).toBeCloseTo(0.003);
    expect(readback.events.filter(event => event.type === "run.model")).toHaveLength(3);
    expect(readback.records).toHaveLength(6);
    expect(planning.at(-1)?.state.used).toMatchObject({ modelTurns: 2, toolCalls: 6, costMicrousd: 2_000 });
    expect(readback.events.find(event => event.type === "run.harness")?.payload).toMatchObject({ maxToolSteps: 16, maxToolCallsPerTurn: 5,
      budgetLimitsSha256: canonicalJsonSha256({ modelTurns: 20, tokens: 100_000, costMicrousd: 1_000_000, wallTimeMs: 210_000,
        toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 }) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["authority_revoked", "authority_revoked_after_context", "budget_exhausted", "failed_adjacent"] as const)("refuses further inspection workflow effects or spending on %s", async fault => {
    if (fault === "authority_revoked_after_context") await enrollExpandedCheckpoints();
    const planner = vi.spyOn(runBudgets, "planModelTurnBudget");
    const modelCheckpoint = vi.spyOn(modelCheckpoints, "persistModelBeforeCheckpointShadow");
    const remainingBudget = vi.spyOn(runBudgets, "remainingRunBudget");
    let sequence = 0, runId = "", revoked = false;
    let plannerCallsAtRevocation: number | undefined;
    let checkpointsAtRevocation: unknown[] | undefined;
    unavailablePath = fault === "failed_adjacent" ? capturedAdjacentPath : undefined;
    const current = authority();
    const checkedAuthority: SelfImprovementExecutionAuthority = { ...current, allowedToolIds: [toolId, searchToolId], assertCurrent: async () => {
      await current.assertCurrent();
      if ((fault === "authority_revoked" || fault === "authority_revoked_after_context") && runId && !revoked) {
        const { records, events } = await readRunReceipts(runId);
        const contextCompleted = events.some(event => event.type === "run.status" &&
          (event.payload.inspectionCompletion as { outcome?: string } | undefined)?.outcome === "context_collected");
        const sourceDiscovered = records.some(record => record.toolId === searchToolId && record.status === "executed") &&
          records.some(record => record.input.path === capturedSourcePath && record.status === "executed");
        if (fault === "authority_revoked_after_context" ? contextCompleted : sourceDiscovered) {
          plannerCallsAtRevocation = planner.mock.calls.length;
          checkpointsAtRevocation = await getSql()`SELECT checkpoint_json FROM omni_run_checkpoints
            WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY sequence LIMIT 100`;
          await admin!`UPDATE omni_auth_memberships SET role='viewer' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
          revoked = true;
        }
      }
      const membership = await getSql()`SELECT role FROM omni_auth_memberships WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      if (membership[0]?.role !== "admin") throw new Error("Synthetic owner revoked inspection workflow authority.");
    } };
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1; expect(sequence).toBe(1);
      const turn = toolModelTurn(request, sequence, [
        { id: toolId, input: { path: "AGENTS.md", startLine: 1, lineCount: 20 } },
        { id: searchToolId, input: { query: "src/components/studio/" } },
        { id: toolId, input: { path: capturedSourcePath, startLine: 1, lineCount: 400 } },
      ]);
      if (fault !== "budget_exhausted") return turn;
      const usage = { inputTokens: 96_980, outputTokens: 20, cachedInputTokens: 0, totalTokens: 97_000 };
      return { ...turn, usage, attempts: turn.attempts.map(attempt => ({ ...attempt, usage })) };
    });
    try {
      const result = await scoped(() => runImprovementAgent({ authority: checkedAuthority, agentId: "atlas",
        prompt: "Discover the selected Studio source and adjacent test, inspect the source, then return a bounded plan.",
        costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
      const readback = await readRunReceipts(runId);
      const finalCheckpoints = await scoped(() => getSql()`SELECT checkpoint_json FROM omni_run_checkpoints
        WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY sequence LIMIT 100`);
      evidence[`workflow_${fault}`] = { result, ...readback, modelTurns: sequence,
        plannerCalls: planner.mock.calls.map(([state, input]) => ({ state, input })), plannerCallsAtRevocation,
        checkpointsAtRevocation, finalCheckpoints, modelCheckpointAttempts: modelCheckpoint.mock.calls.length,
        remainingBudgetStates: remainingBudget.mock.calls.map(([state]) => state), revoked, actualProviderSpendUsd: 0 };
      expect(sequence).toBe(1); expect(result.measuredCostUsd).toBeCloseTo(0.001);
      expect(result.completion).not.toBe("complete");
      expect(result.inspectionResult).toBeUndefined(); expect(result.inspectionReceipt).toBeUndefined();
      expect(readback.events.filter(event => event.type === "run.model")).toHaveLength(1);
      expect(modelCheckpoint).toHaveBeenCalledTimes(1);
      const completedContext = fault === "authority_revoked_after_context";
      if (completedContext) {
        const enrolled = await readEnrolledRun(runId);
        const envelope = assertEnrolledCheckpointChain(enrolled, modelCheckpoint.mock.calls[0][0].runContractEnvelope);
        expect(enrolled.checkpoints).toHaveLength(12);
        evidence.enrolled_pause = { ...enrolled, envelope, result, plannerCallsAtRevocation,
          plannerCallsAfterRevocation: planner.mock.calls.length, modelTurns: sequence };
      }
      expect(readback.records).toHaveLength(completedContext ? 5 : fault === "failed_adjacent" ? 4 : 3);
      expect(readback.records.filter(record => record.status === "executed")).toHaveLength(completedContext ? 5 : 3);
      expect(readback.records.some(record => Number(record.input.startLine) > 1)).toBe(completedContext);
      if (fault === "failed_adjacent") {
        const failedReads = readback.records.filter(record => record.input.path === capturedAdjacentPath);
        expect(failedReads).toHaveLength(1); expect(failedReads[0].status).toBe("failed");
      } else expect(readback.records.some(record => record.input.path === capturedAdjacentPath)).toBe(completedContext);
      if (fault === "authority_revoked" || completedContext) {
        expect(revoked).toBe(true);
        expect(planner.mock.calls).toHaveLength(plannerCallsAtRevocation!);
        expect(finalCheckpoints).toEqual(checkpointsAtRevocation);
        if (!completedContext) expect(planner).toHaveBeenCalledTimes(1);
        expect(result.completion).toBe("inspection_evidence_unavailable");
      } else if (fault === "budget_exhausted") {
        const context = readback.events.filter(event => event.type === "run.status")
          .map(event => (event.payload.inspectionCompletion as { workflowContext?: { executionIds: string[]; refusal?: string } } | undefined)?.workflowContext)
          .find(value => value?.refusal);
        expect(context).toMatchObject({ executionIds: [], refusal: expect.stringMatching(/budget|headroom/) });
        // The workflow checks remaining headroom without reserving another
        // model turn. Observe that real budget state, not a second planner call.
        expect(planner).toHaveBeenCalledTimes(1);
        expect(remainingBudget.mock.calls.some(([state]) => state.used.tokens === 97_000 &&
          state.used.modelTurns === 1 && state.used.toolCalls === 3 && state.limits.tokens === 100_000)).toBe(true);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      unavailablePath = undefined;
      await admin!`UPDATE omni_auth_memberships SET role='admin' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      modelCheckpoint.mockRestore();
      remainingBudget.mockRestore();
      planner.mockRestore();
    }
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
  it("persists expanded-canary workflow checkpoints through real governed reads", async () => {
    const modelCheckpoint = vi.spyOn(modelCheckpoints, "persistModelBeforeCheckpointShadow");
    try {
    const enrollment = await enrollExpandedCheckpoints();
    let sequence = 0, runId = "";
    const capturedPlan = { ...plan, plan: { ...plan.plan, sourcePaths: [capturedSourcePath], adjacentTestPaths: [capturedAdjacentPath] } };
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence += 1;
      expect(sequence).toBeLessThanOrEqual(3);
      if (sequence === 1) return toolModelTurn(request, sequence, [{ id: searchToolId, input: { query: "src/components/studio/" } }]);
      if (sequence === 2) return modelTurn(request, sequence, [capturedSourcePath], "", 400);
      expect(JSON.stringify(request.input)).toContain("inspection_workflow");
      expect(JSON.stringify(request.input)).toContain("Selection and undo behavior are the adjacent acceptance criteria.");
      const text = JSON.stringify(capturedPlan); await request.onDelta(text);
      return modelTurn(request, sequence, [], text);
    });
    const result = await scoped(() => runImprovementAgent({ authority: { ...authority(), allowedToolIds: [toolId, searchToolId] },
      agentId: "atlas", prompt: "Discover the Studio source and adjacent test, inspect the source, and interpret the supplied evidence before returning the bounded plan.",
      costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async id => { runId = id; } }));
    const readback = await readEnrolledRun(runId);
    evidence.enrolled_workflow = { enrollment, result, modelTurns: sequence, ...readback };
    // Record the actual failed intent and checkpoint chain before asserting success,
    // so the baseline proves this is the same production boundary.
    expect(result.completion).toBe("complete");
    expect(result.inspectionResult).toEqual(capturedPlan);
    expect(sequence).toBe(3); expect(result.measuredCostUsd).toBeCloseTo(0.003);
    expect(readback.records).toHaveLength(4);
    expect(readback.workflowRecords).toHaveLength(2);
    expect(readback.checkpoints).toHaveLength(14);
    expect(readback.checkpoints.map(checkpoint => checkpoint.sequence)).toEqual(Array.from({ length: 14 }, (_, index) => index));
    expect(readback.checkpoints.filter(checkpoint => checkpoint.boundary.kind === "model")).toHaveLength(6);
    expect(readback.checkpoints.filter(checkpoint => checkpoint.boundary.kind === "tool")).toHaveLength(8);
    const envelope = assertEnrolledCheckpointChain(readback, modelCheckpoint.mock.calls[0][0].runContractEnvelope);
    evidence.enrolled_workflow = { enrollment, result, modelTurns: sequence, envelope, ...readback };
    for (const record of readback.workflowRecords) {
      expect(record.status).toBe("executed");
      const index = readback.workflowIds.indexOf(record.id);
      expect(index).toBeGreaterThanOrEqual(0);
      const binding = readback.bindings[index];
      expect(binding?.executionScope).toMatchObject({ purpose: "agent.tool.execute", causationId: `inspection-workflow-read-${index + 1}` });
      assertToolExecutionBindingMatchesRequest({ binding: binding!, record, toolInput: record.input });
      const boundaries = readback.checkpoints.filter(checkpoint => checkpoint.toolBinding?.toolExecutionId === record.id);
      expect(boundaries.map(checkpoint => checkpoint.boundary.phase)).toEqual(["before", "after"]);
      expect(boundaries.every(checkpoint => checkpoint.toolBinding?.inputSha256 === binding?.inputSha256)).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
    } finally { modelCheckpoint.mockRestore(); }
  });

  it("settles a real enrolled inspect phase and retains it across owner pauses", async () => {
    await enrollExpandedCheckpoints();
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId);
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actorId);
    const owner = { tenantId, ownerActorId: actorId };
    const modelCheckpoint = vi.spyOn(modelCheckpoints, "persistModelBeforeCheckpointShadow");
    try {
      let configuration = await configureSelfImprovement({ ...owner, projectId,
        repositoryId: String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16)),
        repository: { owner: "isolated", name: `checkpoint-${randomUUID()}`, defaultBranch: "main" },
        policy: createSelfImprovementPolicy({ dailyBudgetUsd: 10, maxCycleBudgetUsd: 10, notifyOutcomes: false }) });
      const claim = await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id,
        expectedGeneration: configuration.generation, baseRevision: "b7b909ad24588cdb6301dbd66008a3cdec85a4cd",
        idempotencyKey: "enrolled-inspect-worker" });
      let stored = claim.cycle!;
      expect(stored).toBeDefined();
      const cycleId = stored.cycle.id, leaseToken = stored.leaseToken!;
      stored = await updateSelfImprovementCycleRuntime({ owner, cycleId, expectedRevision: stored.cycle.revision, leaseToken,
        runtime: { ...initialSelfImprovementRuntime(), phase: "inspect", setupStep: "complete" }, patch: { builderSessionId: sessionId } });
      stored = await releaseSelfImprovementExecutionLease({ owner, cycleId, expectedRevision: stored.cycle.revision, leaseToken });
      const job = { tenantId, payload: { actorId, cycleId } };
      const reservations = () => scoped(() => getSql()`SELECT phase_id,reserved_usd,actual_usd,state,evidence_sha256
        FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${actorId} AND cycle_id=${cycleId} ORDER BY phase_id`);
      configuration = await pauseSelfImprovement({ owner, configurationId: configuration.id,
        expectedGeneration: configuration.generation, paused: true });
      let sequence = 0;
      transport.model.mockImplementation(() => { throw new Error("Paused inspection must not call the model transport."); });
      const pausedBefore = await scoped(() => executeSelfImprovementJob(job, new AbortController().signal));
      expect(pausedBefore).toMatchObject({ __deferOperation: true, resourceId: cycleId, reason: expect.stringContaining("paused") });
      expect(await reservations()).toEqual([]);
      expect(modelCheckpoint).not.toHaveBeenCalled();
      configuration = await pauseSelfImprovement({ owner, configurationId: configuration.id,
        expectedGeneration: configuration.generation, paused: false });
      const capturedPlan = { ...plan, plan: { ...plan.plan, sourcePaths: [capturedSourcePath], adjacentTestPaths: [capturedAdjacentPath] } };
      transport.model.mockImplementation(async (request: ModelRequest) => {
        sequence += 1; expect(sequence).toBeLessThanOrEqual(3);
        if (sequence === 1) return toolModelTurn(request, sequence, [{ id: searchToolId, input: { query: "src/components/studio/" } }]);
        if (sequence === 2) return modelTurn(request, sequence, [capturedSourcePath], "", 400);
        expect(JSON.stringify(request.input)).toContain("inspection_workflow");
        const text = JSON.stringify(capturedPlan); await request.onDelta(text);
        return modelTurn(request, sequence, [], text);
      });
      const result = await scoped(() => executeSelfImprovementJob(job, new AbortController().signal));
      const after = await getSelfImprovementCycle(owner, cycleId);
      const phaseRows = await reservations();
      evidence.cycleAdmitted = true;
      evidence.worker_inspect = { cycleId, configuration, result, after, phaseRows, pausedBefore, modelTurns: sequence,
        actualProviderSpendUsd: 0, transportUsageUsd: 0.003 };
      expect(after).toMatchObject({ spendUsd: 0.003, usageState: "known", runtime: { phase: "reproduce", phaseAttempt: null, plan: capturedPlan.plan },
        cycle: { stage: "planned", builderSessionId: sessionId, dailyReservationUsd: 10 } });
      expect(result).toMatchObject({ __deferOperation: true, resourceId: cycleId });
      expect(sequence).toBe(3);
      expect(phaseRows).toHaveLength(1);
      expect(phaseRows[0]).toMatchObject({ phase_id: "inspect:0", state: "settled" });
      expect(Number(phaseRows[0].actual_usd)).toBeCloseTo(0.003);
      expect(Number(phaseRows[0].reserved_usd)).toBeGreaterThanOrEqual(0.003);
      expect(phaseRows[0].evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Date.parse(after!.leaseExpiresAt)).toBeLessThanOrEqual(Date.now());
      const runtime = after!.runtime as { agentRuns: Array<{ phase: string; agentId: string; runId: string; completed: boolean }> };
      expect(runtime.agentRuns).toHaveLength(1);
      expect(runtime.agentRuns[0]).toMatchObject({ phase: "inspect", agentId: "atlas", completed: true });
      const readback = await readEnrolledRun(runtime.agentRuns[0].runId);
      expect(readback.checkpoints).toHaveLength(14);
      const envelope = assertEnrolledCheckpointChain(readback, modelCheckpoint.mock.calls[0][0].runContractEnvelope);
      configuration = await pauseSelfImprovement({ owner, configurationId: configuration.id,
        expectedGeneration: configuration.generation, paused: true });
      const pausedAfter = await scoped(() => executeSelfImprovementJob(job, new AbortController().signal));
      expect(pausedAfter).toMatchObject({ __deferOperation: true, resourceId: cycleId, reason: expect.stringContaining("paused") });
      expect(sequence).toBe(3);
      expect(await reservations()).toEqual(phaseRows);
      const retained = await getSelfImprovementCycle(owner, cycleId);
      expect(retained?.cycle.revision).toBe(after?.cycle.revision);
      expect(retained?.runtime).toEqual(after?.runtime);
      evidence.worker_inspect = { cycleId, configuration, result, after, phaseRows, pausedBefore, pausedAfter, retained,
        modelTurns: sequence, ...readback, envelope, actualProviderSpendUsd: 0, transportUsageUsd: 0.003 };
      expect(fetch).not.toHaveBeenCalled();
    } finally { modelCheckpoint.mockRestore(); }
  });
});
