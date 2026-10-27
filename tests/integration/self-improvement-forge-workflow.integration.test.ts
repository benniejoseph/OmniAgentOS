/**
 * Opt-in synthetic engineering workflow. Real pool-one PostgreSQL/RLS, worker,
 * model planner, governed tools, audit/effect receipts and local file bytes.
 * Model, Sandbox and GitHub HTTP transports are replaced; no provider or hosting
 * calls. Worker phases are invoked explicitly, so this does not prove cadence.
 */
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationItem, streamResponseTurn } from "@/lib/openai/client";

const transport = vi.hoisted(() => ({ model: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/config", async original => ({ ...await original<typeof import("@/lib/config")>(),
  hasOpenAIKey: () => true, hasGeminiKey: () => false, hasAnthropicKey: () => false }));
vi.mock("@/lib/openai/client", async original => ({ ...await original<typeof import("@/lib/openai/client")>(), streamResponseTurn: transport.model }));
vi.mock("@vercel/sandbox", () => ({ APIError: class APIError extends Error {},
  Sandbox: { get: transport.sandbox, create: () => { throw new Error("Provisioning is outside the local workflow fixture."); } } }));

import { APP_BUILDER_ROOT, APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION, builderFileSha256 } from "@/lib/app-builder/contracts";
import { createBuilderSessionRecord, getBuilderCheckpoint, getBuilderVerification, listBuilderActivity, transitionBuilderSession } from "@/lib/app-builder/store";
import { bindBuilderRepository, listBuilderDeliveries } from "@/lib/app-builder/delivery-store";
import { getBuilderWorkspaceManifest, readBuilderRepositoryChanges } from "@/lib/app-builder/sandbox";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService } from "@/lib/app-services/projects";
import { capabilityFunctionName } from "@/lib/capabilities/toolbox";
import { closeDatabaseClient, getDatabasePoolMax, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { getAgentRun } from "@/lib/runs/store";
import * as modelCheckpoints from "@/lib/runs/boundary-checkpoint-shadow";
import { parseRunContractEnvelopeV1 } from "@/lib/runs/contracts";
import { RUN_CHECKPOINT_CAPABILITY_ID, RUN_CHECKPOINT_CONTRACT_VERSION_ID, RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256 } from "@/lib/runs/approval-checkpoint-shadow";
import { parseRunCheckpointV1 } from "@/lib/runs/checkpoints";
import { registerTenantCapabilityRollout, transitionTenantCapabilityRolloutStatus } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { selfImprovementSha256 } from "@/lib/self-improvement/contracts";
import { initialSelfImprovementRuntime, type ImprovementPlan } from "@/lib/self-improvement/runtime";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle, pauseSelfImprovement,
  releaseSelfImprovementExecutionLease, transitionSelfImprovementCycle, updateSelfImprovementCycleRuntime } from "@/lib/self-improvement/store";
import { executeSelfImprovementJob } from "@/lib/self-improvement/worker";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { forgeHandoffReceiptSchema } from "@/lib/self-improvement/forge-handoff";
import { assertToolExecutionBindingMatchesRequest, getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";

const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `forge-workflow-${randomUUID()}`, userId = randomUUID(), actorId = `actor:${userId}`, email = `${userId}@example.test`;
const role = `forge_workflow_${randomBytes(6).toString("hex")}`;
const sourcePath = "src/capacity.ts", adjacentPath = "src/capacity.test.ts", regressionPath = "src/capacity-regression.test.ts";
const source = "export function addCopies(size: number, copies: number) { return size + copies; }\n";
const sourceFiles = { "AGENTS.md": "Read the selected source and adjacent test. Write only the allowed phase paths.\n", [sourcePath]: source,
  [adjacentPath]: "import { expect, it } from 'vitest';\nimport { addCopies } from './capacity';\nit('preserves additions below capacity', () => expect(addCopies(2, 3)).toBe(5));\n",
  "package.json": JSON.stringify({ name: "synthetic-forge-workflow", version: "1.0.0", private: true, type: "module", dependencies: { next: "16.4.3", react: "19.2.4", "react-dom": "19.2.4" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, strict: true, noEmit: true, skipLibCheck: true, jsx: "react-jsx", esModuleInterop: true, incremental: true, plugins: [{ name: "next" }] }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"], exclude: ["node_modules"] }),
  "vitest.config.mts": "export default { test: { environment: 'node', include: ['src/**/*.test.ts'], maxWorkers: 1, fileParallelism: false } };\n",
  "eslint.config.mjs": "import parser from '@typescript-eslint/parser';\nexport default [{ files: ['src/**/*.ts'], languageOptions: { parser }, rules: { 'no-constant-condition': 'error' } }];\n",
  "src/app/page.tsx": "export default function Page() { return <main>Synthetic capacity fixture</main>; }\n",
  "src/app/layout.tsx": "import type { ReactNode } from 'react';\nexport default function Layout({ children }: { children: ReactNode }) { return <html><body>{children}</body></html>; }\n" };
const regression = "import { expect, it } from 'vitest';\nimport { addCopies } from './capacity';\nit('rejects capacity overflow', () => expect(() => addCopies(9, 2)).toThrow('Capacity exceeded'));\nit('accepts exactly ten', () => expect(addCopies(8, 2)).toBe(10));\n";
const repairedSource = "export function addCopies(size: number, copies: number) { if (size + copies > 10) throw new Error('Capacity exceeded'); return size + copies; }\n";
const selectedPlan: ImprovementPlan = { summary: "Reject capacity overflow before returning a changed size.", sourcePaths: [sourcePath], newSourcePaths: [],
  focusedTestPaths: [regressionPath], adjacentTestPaths: [adjacentPath], acceptanceCriteria: ["A sum over ten throws; ten is accepted."] };
const baseSha = "753a557cc58fa0e794769b2e3e0fa6cb1e6535e0", repositoryId = String(100_000 + Number.parseInt(randomBytes(6).toString("hex"), 16));
const owner = { tenantId, ownerActorId: actorId };
const scoped = <T>(work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actorId, email], work);
const context: SecurityContext = { tenantId, actorId: email, source: "session", role: "admin",
  auth: { userId, email, sessionId: "synthetic-no-login", tenantName: "Forge workflow fixture" } };
const execute = promisify(execFile);
type ModelRequest = Parameters<typeof streamResponseTurn>[0];
type ModelTurn = Awaited<ReturnType<typeof streamResponseTurn>>;

function modelTurn(request: ModelRequest, sequence: number, calls: Array<{ id: string; input: Record<string, unknown> }> = [], text = "", tokens = 50): ModelTurn {
  const functionCalls = calls.map((call, index) => ({ callId: `forge-fixture-${sequence}-${index}`, name: capabilityFunctionName(call.id), argumentsJson: JSON.stringify(call.input) }));
  const outputItems: ConversationItem[] = functionCalls.map(call => ({ type: "function_call", id: `item-${call.callId}`, call_id: call.callId, name: call.name, arguments: call.argumentsJson }));
  if (text) outputItems.push({ type: "message", role: "assistant", content: text });
  const usage = { inputTokens: tokens - 20, outputTokens: 20, cachedInputTokens: 0, totalTokens: tokens };
  return { responseId: `synthetic-forge-${sequence}`, functionCalls, outputItems, text, model: request.model, fallbackUsed: false, latencyMs: 1,
    usage, estimatedCostUsd: 0.001, attempts: [{ provider: "openai", model: request.model, status: "completed", latencyMs: 1, usage, estimatedCostUsd: 0.001 }], usageReceiptRecorded: false };
}

candidate("self-improvement Forge workflow with actual effects", () => {
  let admin: ReturnType<typeof postgres> | undefined, roleCreated = false, directory: string, projectId: string, sessionId: string, sandboxName: string;
  let fixtureConfiguration: Awaited<ReturnType<typeof configureSelfImprovement>> | undefined;
  const evidence: Record<string, unknown> = { actualProviderCalls: 0, productionWrites: false, source: "tiny synthetic capacity function", setupExcluded: true };
  const commandCalls: Array<{ cmd: string; args: string[] }> = [];
  const executedCommands: Array<Record<string, unknown>> = [], writes: Array<{ path: string; sha256: string }> = [], snapshots: Array<Record<string, unknown>> = [];
  let effectsAllowed = false, githubAllowed = false;
  const githubCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const githubBlobs = new Map<string, string>();
  let githubTree: Array<{ path: string; mode: string; type: string; sha: string }> = [], githubBranch = "";
  const candidateSha = "c".repeat(40), candidateTree = "d".repeat(40), baseTree = "b".repeat(40);
  let baseline: Buffer;
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the existing isolated candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the existing isolated loopback candidate database is allowed.");
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OMNIAGENT_SANDBOX_ACCESS_TOKEN", "OMNIAGENT_OPENAI_GATEWAY_TOKEN", "OMNIAGENT_INTERNAL_AUTH_SECRET", "OMNIAGENT_EXECUTION_PAYLOAD_SECRET"]) {
      if (process.env[key]?.trim()) throw new Error(`Live credential ${key} is forbidden in this deterministic fixture.`);
    }
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (!githubAllowed) throw new Error("Unexpected network transport in deterministic Forge fixture.");
      const url = new URL(String(request));
      if (url.origin !== "https://api.github.com") throw new Error("Only the synthetic selected-repository GitHub HTTP adapter is allowed.");
      const method = init?.method || "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const endpoint = url.pathname + url.search; githubCalls.push({ method, path: endpoint, body });
      const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (endpoint === "/app/installations/111" && method === "GET") return reply({ repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", checks: "read" }, suspended_at: null });
      if (endpoint === "/app/installations/111/access_tokens" && method === "POST") {
        expect(body.repository_ids).toEqual([Number(repositoryId)]);
        return reply({ token: "local-transport-not-a-provider-token", expires_at: new Date(Date.now() + 300_000).toISOString() });
      }
      const prefix = "/repos/isolated/forge-fixture";
      if (endpoint === `${prefix}/git/ref/heads/main`) return reply({ object: { sha: baseSha } });
      if (endpoint.startsWith(`${prefix}/git/ref/heads/codex`)) return reply({ message: "Synthetic branch does not exist." }, 404);
      if (endpoint === `${prefix}/git/commits/${baseSha}`) return reply({ sha: baseSha, tree: { sha: baseTree }, parents: [] });
      if (endpoint === `${prefix}/git/blobs` && method === "POST") {
        expect(body.encoding).toBe("utf-8"); expect([regression, repairedSource]).toContain(body.content);
        const sha = createHash("sha1").update(`blob ${Buffer.byteLength(body.content)}\0${body.content}`).digest("hex"); githubBlobs.set(sha, body.content); return reply({ sha });
      }
      if (endpoint === `${prefix}/git/trees` && method === "POST") {
        expect(body.base_tree).toBe(baseTree); githubTree = body.tree;
        expect(githubTree.map(file => file.path).sort()).toEqual([regressionPath, sourcePath].sort());
        for (const file of githubTree) { expect(file).toMatchObject({ mode: "100644", type: "blob" }); expect(githubBlobs.get(file.sha)).toBe(await readFile(path.join(directory, file.path), "utf8")); }
        return reply({ sha: candidateTree });
      }
      if (endpoint === `${prefix}/git/commits` && method === "POST") { expect(body).toMatchObject({ tree: candidateTree, parents: [baseSha] }); return reply({ sha: candidateSha }); }
      if (endpoint === `${prefix}/git/refs` && method === "POST") { expect(body.sha).toBe(candidateSha); expect(body.ref).toMatch(/^refs\/heads\/codex\/asael-improve-/); githubBranch = body.ref.slice("refs/heads/".length); return reply({ object: { sha: candidateSha } }); }
      if (endpoint === `${prefix}/pulls` && method === "POST") { expect(body).toMatchObject({ head: githubBranch, base: "main", draft: true }); return reply({ number: 1, html_url: "https://github.com/isolated/forge-fixture/pull/1" }); }
      if (endpoint === `${prefix}/git/commits/${candidateSha}`) return reply({ sha: candidateSha, tree: { sha: candidateTree }, parents: [{ sha: baseSha }] });
      if (endpoint === `${prefix}/compare/${baseSha}...${candidateSha}?per_page=100`) return reply({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, commits: [{ sha: candidateSha }], files: githubTree.map(file => { const content = githubBlobs.get(file.sha)!;
          const prior = file.path === sourcePath ? source : "", additions = content.trimEnd().split("\n").length, deletions = prior ? prior.trimEnd().split("\n").length : 0;
          return { filename: file.path, status: prior ? "modified" : "added", additions, deletions, changes: additions + deletions }; }) });
      throw new Error(`Unapproved synthetic GitHub endpoint ${method} ${endpoint}`);
    }));
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(266);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Forge workflow fixture',${tenantId})`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4"); vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actorId);
    expect(getDatabasePoolMax()).toBe(1);
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "asael-forge-workflow-")));
    for (const [name, content] of Object.entries(sourceFiles)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), content, { mode: 0o600 });
    }
    await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
    await writeFile(path.join(directory, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "./.next/types/routes.d.ts";\n', { mode: 0o600 });
    const entries = Object.entries(sourceFiles).map(([name, content]) => ({ path: name, sha256: builderFileSha256(content), mode: "100644" })).sort((a, b) => a.path.localeCompare(b.path));
    baseline = Buffer.from(JSON.stringify({ contractVersion: APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION, repositoryId, repositoryFullName: "isolated/forge-fixture", baseSha,
      archiveSha256: createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex"), workspaceSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      fileCount: entries.length, importedAt: new Date().toISOString(), entries }));
    transport.sandbox.mockImplementation(async (input: { name: string }) => {
      expect(input.name).toBe(sandboxName);
      return {
        runCommand: async (command: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }) => {
          commandCalls.push(command);
          if (effectsAllowed && command.cmd === "mkdir") {
            expect(command.args).toEqual(["-p", `${APP_BUILDER_ROOT}/src`]);
            await mkdir(path.join(directory, "src"), { recursive: true });
            return { exitCode: 0, durationMs: 1, stdout: async () => "", stderr: async () => "" };
          }
          if (command.cmd !== "node") throw new Error("Only fixed Builder Node commands are admitted.");
          const inspector = command.args[0] === "-e";
          if (!inspector) {
            if (!effectsAllowed) throw new Error("Candidate commands are not admitted in the no-write fixture.");
            expect(command.cwd).toBe(APP_BUILDER_ROOT);
            const accepted = [
              ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", `./${regressionPath}`],
              ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", `./${adjacentPath}`],
              ["node_modules/eslint/bin/eslint.js", "--max-warnings=0", "--no-warn-ignored", "--", `./${sourcePath}`, `./${regressionPath}`],
              ["--max-old-space-size=6144", "node_modules/typescript/bin/tsc", "--noEmit"],
              ["node_modules/next/dist/bin/next", "typegen"],
            ];
            expect(accepted).toContainEqual(command.args);
          }
          const startedAt = Date.now();
          let exitCode = 0, stdout = "", stderr = "";
          try {
            const args = inspector ? ["-e", command.args[1].replace(JSON.stringify(APP_BUILDER_ROOT), JSON.stringify(directory)), ...command.args.slice(2)] : command.args;
            const output = await execute(process.execPath, args, { cwd: directory, maxBuffer: 2_000_000, timeout: inspector ? 10_000 : 60_000,
              env: { PATH: "/opt/homebrew/opt/node@24/bin:/usr/bin:/bin", HOME: directory, NODE_ENV: (command.env?.NODE_ENV || "production") as "test" | "production", NEXT_TELEMETRY_DISABLED: "1" } });
            stdout = output.stdout; stderr = output.stderr;
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string };
            exitCode = typeof failure.code === "number" ? failure.code : 1; stdout = failure.stdout || ""; stderr = failure.stderr || "";
          }
          if (!inspector) executedCommands.push({ command, exitCode, stdout, stderr });
          // Sandbox transport remaps only actual Vitest suite absolute paths.
          // Assertion statuses/counts and failures are produced by real Vitest.
          if (command.args[0] === "node_modules/vitest/vitest.mjs") {
            const report = JSON.parse(stdout);
            for (const suite of report.testResults) { expect(suite.name.startsWith(directory + "/")).toBe(true); suite.name = APP_BUILDER_ROOT + suite.name.slice(directory.length); }
            stdout = JSON.stringify(report);
          }
          return { exitCode, durationMs: Date.now() - startedAt, stdout: async () => stdout, stderr: async () => stderr };
        },
        readFileToBuffer: async ({ path: requested }: { path: string }) => {
          if (requested === "/vercel/sandbox/asael-repository-baseline.json") return baseline;
          if (!requested.startsWith(`${APP_BUILDER_ROOT}/`)) throw new Error("Unexpected file transport path.");
          try { return await readFile(path.join(directory, requested.slice(APP_BUILDER_ROOT.length + 1))); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
        },
        writeFiles: async (files: Array<{ path: string; content: string | Buffer; mode?: number }>) => {
          if (!effectsAllowed) throw new Error("File effects are disabled for the no-write fixture.");
          for (const file of files) {
            expect([`${APP_BUILDER_ROOT}/${sourcePath}`, `${APP_BUILDER_ROOT}/${regressionPath}`]).toContain(file.path);
            const relative = file.path.slice(APP_BUILDER_ROOT.length + 1), target = path.join(directory, relative);
            await writeFile(target, file.content, { mode: file.mode }); if (file.mode) await chmod(target, file.mode);
            writes.push({ path: relative, sha256: builderFileSha256(await readFile(target)) });
          }
        },
        snapshot: async () => {
          if (!effectsAllowed) throw new Error("Snapshots are disabled for the no-write fixture.");
          const bytes = await Promise.all([...Object.keys(sourceFiles), regressionPath].sort().map(async name => ({ path: name, content: (await readFile(path.join(directory, name))).toString("base64") })));
          const snapshotId = `snap_${createHash("sha256").update(JSON.stringify(bytes)).digest("hex")}`;
          snapshots.push({ snapshotId, bytes }); return { snapshotId, sizeBytes: Buffer.byteLength(JSON.stringify(bytes)), expiresAt: new Date(Date.now() + 86_400_000) };
        },
      };
    });
    await scoped(async () => {
      evidence.rls = (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_projects') AS projects,row_security_active('omni_tool_executions') AS tools FROM pg_roles WHERE rolname=current_user`)[0];
      expect(evidence.rls).toMatchObject({ rolsuper: false, rolbypassrls: false, projects: true, tools: true });
      await getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${email})`;
      const caller = createRequestMutationAppServiceCaller(new Request("https://fixture.invalid/api/projects", { method: "POST", headers: { "Idempotency-Key": `forge-project-${randomUUID()}` } }), context, { purpose: "app.projects.create" });
      projectId = (await createProjectService(caller, { title: "Synthetic capacity repair", objective: "Reject a sum above ten and preserve the exact capacity boundary." })).data.project.id;
      const created = await createBuilderSessionRecord({ tenantId, actorId, projectId, workspaceMode: "source_only", idempotencyKey: "forge-source-fixture" });
      const ready = await transitionBuilderSession({ tenantId, actorId, session: created.session, status: "ready", eventType: "app_builder.session.ready", eventKey: "local-files-ready" });
      sessionId = ready.id; sandboxName = ready.sandboxName;
      await bindBuilderRepository({ tenantId, actorId, projectId, sessionId, baseSha,
        repository: { repositoryId, owner: "isolated", name: "forge-fixture", fullName: "isolated/forge-fixture", defaultBranch: "main", private: true, htmlUrl: "https://github.com/isolated/forge-fixture" } });
    });
  });
  afterAll(async () => {
    try {
      await closeDatabaseClient();
      if (admin && roleCreated) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); }
      if (process.env.ASAEL_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_CANDIDATE_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally { await admin?.end(); if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  async function admitReproduction(phase: "inspect" | "reproduce" = "reproduce") {
    const configuration = fixtureConfiguration ?? await configureSelfImprovement({ ...owner, projectId, repositoryId,
      repository: { owner: "isolated", name: "forge-fixture", defaultBranch: "main" },
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }) });
    fixtureConfiguration = configuration;
    const claim = await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, baseRevision: baseSha, idempotencyKey: `forge-cycle-${randomUUID()}` });
    expect(claim.outcome).toBe("claimed");
    let stored = claim.cycle!;
    const cycleId = stored.cycle.id, leaseToken = stored.leaseToken!;
    stored = await updateSelfImprovementCycleRuntime({ owner, cycleId, expectedRevision: stored.cycle.revision, leaseToken,
      runtime: { ...initialSelfImprovementRuntime(), phase, setupStep: "complete", ...(phase === "reproduce" ? { plan: selectedPlan, sourceHashes: { [sourcePath]: builderFileSha256(source) } } : {}) }, patch: { builderSessionId: sessionId } });
    if (phase === "reproduce") {
      const signal = sealEngineeringSignal({ version: 1, scope: stored.cycle.scope, kind: "code_defect", summary: selectedPlan.summary,
        symptomSha256: selfImprovementSha256("synthetic_capacity", source), observations: [{ sourceKind: "source_file", sourceId: sourcePath,
          sourceSha256: builderFileSha256(source), path: sourcePath, sourceRevision: baseSha, observedAt: new Date().toISOString(), outcome: "needs_work" }] });
      stored = await transitionSelfImprovementCycle({ owner, cycleId, expectedRevision: stored.cycle.revision, leaseToken, nextStage: "planned", patch: { signal } });
    }
    await releaseSelfImprovementExecutionLease({ owner, cycleId, expectedRevision: stored.cycle.revision, leaseToken });
    return { configuration, cycleId, job: { tenantId, payload: { actorId, cycleId } } };
  }

  it("reports an incomplete reproduction after six reads and the real final-only model turn without claiming an invalid edit", async () => {
    const admitted = await admitReproduction();
    let sequence = 0;
    const choices: unknown[] = [];
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence++; choices.push(request.toolChoice); expect(sequence).toBeLessThanOrEqual(7);
      if (sequence <= 6) {
        expect(request.toolChoice).not.toBe("none");
        const call = sequence % 2 ? { id: "app.projects.builder.search", input: { query: sourcePath } }
          : { id: "app.projects.builder.file.read", input: { path: sourcePath, startLine: 1, lineCount: 30 } };
        return modelTurn(request, sequence, [call], "", sequence === 6 ? 15_000 : 8_000);
      }
      expect(request.toolChoice).toBe("none");
      const text = "I cannot write the selected regression in this final turn because tools are unavailable. No file has been saved.";
      await request.onDelta(text);
      return modelTurn(request, sequence, [], text, 1_000);
    });
    let failure: unknown;
    try { await scoped(() => executeSelfImprovementJob(admitted.job, new AbortController().signal)); } catch (error) { failure = error; }
    const current = await getSelfImprovementCycle(owner, admitted.cycleId);
    const runId = (current!.runtime as { agentRuns: Array<{ runId: string }> }).agentRuns[0].runId;
    const run = await scoped(() => getAgentRun(runId, { tenantId }));
    const events = await scoped(() => listStreamEvents(`run:${runId}`, { tenantId, limit: 1_000, order: "asc" }));
    const ids = [...new Set(events.filter(event => event.type === "run.tool" && typeof event.payload.executionId === "string").map(event => String(event.payload.executionId)))];
    const records = await scoped(() => getToolExecutionsByIds(ids, { tenantId }));
    const bindings = await scoped(() => Promise.all(records.map(record => getToolExecutionScopeBinding(record.id, { tenantId }))));
    for (let index = 0; index < records.length; index++) assertToolExecutionBindingMatchesRequest({ binding: bindings[index]!, record: records[index], toolInput: records[index].input });
    const reservations = await scoped(() => getSql()`SELECT phase_id,reserved_usd,actual_usd,state,evidence_sha256 FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${actorId} AND cycle_id=${admitted.cycleId}`);
    evidence.no_write = { admitted, current, run, events, records, bindings, reservations, choices, sequence, failure: String(failure), sourceSha256: builderFileSha256(await readFile(path.join(directory, sourcePath), "utf8")) };
    expect(sequence).toBe(7);
    const modelRecords = records.filter((_, index) => !bindings[index]?.executionScope.causationId?.startsWith("forge-workflow-read-"));
    expect(modelRecords.filter(record => record.status === "executed")).toHaveLength(6);
    expect(records.every(record => ["app.projects.builder.search", "app.projects.builder.file.read"].includes(record.toolId))).toBe(true);
    expect(choices.at(-1)).toBe("none");
    expect(current).toMatchObject({ spendUsd: 0.007, usageState: "known", cycle: { stage: "failed" }, runtime: { phase: "reproduce", phaseAttempt: null } });
    expect(reservations).toHaveLength(1); expect(reservations[0].state).toBe("settled"); expect(Number(reservations[0].actual_usd)).toBeCloseTo(0.007);
    expect(await readFile(path.join(directory, sourcePath), "utf8")).toBe(source);
    await expect(readFile(path.join(directory, regressionPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(commandCalls.every(command => command.cmd === "node" && command.args[0] === "-e")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    // This is deliberately red on753: empty diff is currently mislabeled as an unauthorized edit.
    expect(String(failure)).toMatch(/incomplete.*(?:no_changes|budget_before_effect)|no executed.*(?:write|change)/i);
    const savedCount = transport.model.mock.calls.length;
    expect(await scoped(() => executeSelfImprovementJob(admitted.job, new AbortController().signal))).toMatchObject({ stage: "failed" });
    expect(transport.model.mock.calls).toHaveLength(savedCount);
  });

  it("executes the admitted synthetic repair through actual red and green checks, review and one transport-only GitHub delivery", async () => {
    effectsAllowed = true;
    const effectStart = writes.length, commandStart = executedCommands.length;
    const admitted = await admitReproduction("inspect");
    const modelCheckpoint = vi.spyOn(modelCheckpoints, "persistModelBeforeCheckpointShadow");
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId,
      correlationId: randomUUID(), purpose: "forge_worker_checkpoint_fixture" });
    await scoped(async () => {
      await registerTenantCapabilityRollout({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID, rolloutGeneration: 1,
        engineVersion: RUN_CHECKPOINT_ENGINE_VERSION_ID, contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
        configurationSha256: RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256, mode: "canary", executionScope });
      await transitionTenantCapabilityRolloutStatus({ tenantId, capabilityId: RUN_CHECKPOINT_CAPABILITY_ID, expectedRolloutGeneration: 1,
        expectedStatus: "registered", nextStatus: "active", executionScope });
    });
    const phaseTurns: Record<string, number> = {}, progress: Array<Record<string, unknown>> = [];
    let activePhase = "", sequence = 0;
    transport.model.mockImplementation(async (request: ModelRequest) => {
      sequence++; const turn = phaseTurns[activePhase] = (phaseTurns[activePhase] || 0) + 1;
      expect(request.toolChoice).not.toBe("none");
      expect(turn).toBeLessThanOrEqual(2);
      if (activePhase === "inspect") {
        if (turn === 1) return modelTurn(request, sequence, [sourcePath, adjacentPath].map(file => ({ id: "app.projects.builder.file.read", input: { path: file, startLine: 1, lineCount: 200 } })));
        const text = JSON.stringify({ decision: "repair", plan: selectedPlan }); await request.onDelta(text); return modelTurn(request, sequence, [], text);
      }
      if (activePhase === "reproduce" || activePhase === "implement") {
        expect(JSON.stringify(request.input)).toContain("forge_workflow");
        expect(JSON.stringify(request.input)).toContain(sourcePath); expect(JSON.stringify(request.input)).toContain(adjacentPath);
        if (turn === 1) return modelTurn(request, sequence, [activePhase === "reproduce"
          ? { id: "app.projects.builder.file.update", input: { path: regressionPath, expectedSha256: null, content: regression } }
          : { id: "app.projects.builder.file.edit", input: { path: sourcePath, expectedSha256: builderFileSha256(source), edits: [{ oldText: "return size + copies;", newText: "if (size + copies > 10) throw new Error('Capacity exceeded'); return size + copies;" }] } }]);
        const text = JSON.stringify({ summary: activePhase === "reproduce" ? "Added the selected failing regression and exact-capacity case." : "Reject sums above ten before returning the new size." });
        await request.onDelta(text); return modelTurn(request, sequence, [], text);
      }
      if (activePhase === "review") {
        if (turn === 1) return modelTurn(request, sequence, [sourcePath, regressionPath].map(file => ({ id: "app.projects.builder.file.read", input: { path: file, startLine: 1, lineCount: 200 } })));
        const text = "PASS\nArchitecture impact: none\nThe actual baseline failed on overflow. The unchanged regression and adjacent tests now pass; the exact capacity remains accepted.";
        await request.onDelta(text); return modelTurn(request, sequence, [], text);
      }
      throw new Error(`Unexpected paid phase ${activePhase}`);
    });
    const reservationRows = () => scoped(() => getSql()`SELECT phase_id,reserved_usd,actual_usd,state,evidence_sha256 FROM omni_self_improvement_phase_reservations
      WHERE tenant_id=${tenantId} AND owner_actor_id=${actorId} AND cycle_id=${admitted.cycleId} ORDER BY phase_id`);
    let current = await getSelfImprovementCycle(owner, admitted.cycleId), configuration = admitted.configuration;
    try {
      for (let step = 0; step < 16; step++) {
        activePhase = String(current!.runtime.phase);
        if (activePhase === "release_wait") break;
        if (activePhase === "reproduce") {
          // This is a real owner pause through the stored configuration, not a mocked authority callback.
          configuration = await pauseSelfImprovement({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, paused: true });
          const turnsBefore = sequence, rowsBefore = await reservationRows(), before = current;
          expect(await scoped(() => executeSelfImprovementJob(admitted.job, new AbortController().signal))).toMatchObject({ __deferOperation: true, reason: expect.stringContaining("paused") });
          expect(sequence).toBe(turnsBefore); expect(await reservationRows()).toEqual(rowsBefore);
          expect((await getSelfImprovementCycle(owner, admitted.cycleId))?.runtime).toEqual(before?.runtime);
          progress.push({ phase: "owner_pause", modelTurns: sequence, reservations: rowsBefore });
          configuration = await pauseSelfImprovement({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, paused: false });
        }
        if (activePhase === "deliver") {
          // Real github.ts runs with a newly generated, synthetic signing key and a strict HTTP adapter.
          // No existing credential or real GitHub service is used.
          const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
          vi.stubEnv("OMNIAGENT_GITHUB_APP_ID", "222"); vi.stubEnv("OMNIAGENT_GITHUB_APP_INSTALLATION_ID", "111");
          vi.stubEnv("OMNIAGENT_GITHUB_APP_REPOSITORY_IDS", repositoryId); vi.stubEnv("OMNIAGENT_GITHUB_APP_PRIVATE_KEY", String(key)); githubAllowed = true;
        }
        const result = await scoped(() => executeSelfImprovementJob(admitted.job, new AbortController().signal));
        current = await getSelfImprovementCycle(owner, admitted.cycleId);
        progress.push({ phase: activePhase, result, current, commands: executedCommands.slice(commandStart), writes: writes.slice(effectStart) });
        if (activePhase === "reproduce") {
          expect(await readFile(path.join(directory, regressionPath), "utf8")).toBe(regression);
          expect(await readFile(path.join(directory, sourcePath), "utf8")).toBe(source);
          expect(current?.runtime.phase).toBe("baseline_check");
        }
        if (activePhase === "baseline_check") expect(current?.runtime).toMatchObject({ phase: "implement", baseline: { exitCode: 1, totalTests: 2, passedTests: 1, failedTests: 1 } });
        if (activePhase === "implement") {
          expect(await readFile(path.join(directory, sourcePath), "utf8")).toBe(repairedSource);
          expect(await readFile(path.join(directory, regressionPath), "utf8")).toBe(regression);
        }
      }
      expect(current?.runtime.phase).toBe("release_wait");
      expect(current?.cycle.stage).toBe("ready_for_release");
      expect(phaseTurns).toEqual({ inspect: 2, reproduce: 2, implement: 2, review: 2 });
      const reservations = await reservationRows();
      expect(reservations).toHaveLength(4); expect(reservations.every(row => row.state === "settled")).toBe(true);
      expect(reservations.map(row => row.phase_id).sort()).toEqual(["inspect:0", "reproduce:1", "implement:2", "review:3"].sort());
      expect(current).toMatchObject({ spendUsd: 0.008, usageState: "known", cycle: { dailyReservationUsd: 10 } });
      const commands = executedCommands.slice(commandStart);
      // typegen is an actual preparation command of the one typecheck, not another validation claim.
      expect(commands).toHaveLength(6);
      expect(commands.map(command => command.exitCode)).toEqual([1, 0, 0, 0, 0, 0]);
      expect(writes.slice(effectStart).map(write => write.path)).toEqual([regressionPath, sourcePath]);
      expect(snapshots).toHaveLength(1);
      const runs = current!.runtime.agentRuns as Array<{ phase: string; runId: string; completed: boolean }>;
      const runEvidence = await scoped(async () => Promise.all(runs.map(async run => {
        const events = await listStreamEvents(`run:${run.runId}`, { tenantId, limit: 1_000, order: "asc" });
        const ids = [...new Set(events.filter(event => event.type === "run.tool" && typeof event.payload.executionId === "string").map(event => String(event.payload.executionId)))];
        const records = await getToolExecutionsByIds(ids, { tenantId });
        const bindings = await Promise.all(records.map(record => getToolExecutionScopeBinding(record.id, { tenantId })));
        for (let index = 0; index < records.length; index++) {
          expect(records[index]).toMatchObject({ tenantId, actorId, status: "executed", dryRun: false });
          expect(records[index].input).toMatchObject({ projectId, sessionId });
          expect(bindings[index]?.executionScope).toMatchObject({ correlationId: run.runId, purpose: "agent.tool.execute", projectId, tenantId });
          assertToolExecutionBindingMatchesRequest({ binding: bindings[index]!, record: records[index], toolInput: records[index].input });
        }
        const checkpointRows = await getSql()`SELECT checkpoint_json FROM omni_run_checkpoints WHERE tenant_id=${tenantId} AND actor_id=${actorId} AND run_id=${run.runId} ORDER BY sequence`;
        const checkpoints = checkpointRows.map(row => parseRunCheckpointV1(row.checkpoint_json));
        if (["reproduce", "implement"].includes(run.phase)) {
          expect(checkpoints).toHaveLength(0); // Production expanded profile remains read-only.
          const mutations = records.filter(record => ["app.projects.builder.file.update", "app.projects.builder.file.edit"].includes(record.toolId));
          expect(mutations).toHaveLength(1);
          const receipt = (current!.runtime.forgeReceipts as unknown[]).map(value => forgeHandoffReceiptSchema.parse(value)).find(item => item.runId === run.runId)!;
          expect(receipt).toMatchObject({ phase: run.phase, outcome: "completed", reason: "complete", origin: "forge_workflow" });
          expect(receipt.effects).toHaveLength(1);
          expect(receipt.effects[0]).toMatchObject({ executionId: mutations[0].id, path: run.phase === "reproduce" ? regressionPath : sourcePath,
            sha256: builderFileSha256(run.phase === "reproduce" ? regression : repairedSource), previousSha256: run.phase === "reproduce" ? null : builderFileSha256(source) });
          expect(receipt.reads.map(item => item.path)).toEqual(run.phase === "reproduce" ? [sourcePath, adjacentPath] : [sourcePath, adjacentPath, regressionPath]);
          expect(records.filter((_, index) => bindings[index]?.executionScope.causationId?.startsWith("forge-workflow-read-")).map(record => record.id).sort()).toEqual(receipt.reads.map(item => item.executionId).sort());
        } else {
          expect(checkpoints.length).toBeGreaterThan(0);
          const captured = modelCheckpoint.mock.calls.map(call => call[0].runContractEnvelope).find(item => item?.runId === run.runId);
          const envelope = parseRunContractEnvelopeV1(captured)!;
          expect(events.find(event => event.type === "run.manifests.resolved")?.payload).toMatchObject({ envelopeId: envelope.envelopeId,
            envelopeSha256: createHash("sha256").update(JSON.stringify(envelope)).digest("hex") });
          checkpoints.forEach((checkpoint, index) => {
            expect(checkpoint.sequence).toBe(index);
            expect(checkpoint.enginePin).toEqual({ rolloutCapabilityId: RUN_CHECKPOINT_CAPABILITY_ID, engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
              contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID, configurationSha256: RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256,
              runContractEnvelopeId: envelope.envelopeId, runContractEnvelopeSha256: canonicalJsonSha256(envelope), harnessManifestId: envelope.harnessManifest.harnessManifestId,
              harnessManifestSha256: canonicalJsonSha256(envelope.harnessManifest), rolloutMode: "canary", rolloutLifecycleStatus: "active", rolloutGeneration: 1, rolloutLifecycleRevision: 1 });
            const previous = checkpoints[index - 1];
            expect(checkpoint.parent).toEqual(previous ? { checkpointId: previous.checkpointId, checkpointSha256: previous.checkpointSha256, sequence: previous.sequence } : null);
          });
          expect(checkpoints.at(-1)?.resourceUsage.externalEffectCount).toBe(0);
        }
        return { ...run, events, records, bindings, checkpoints };
      })));
      const checkpoint = await scoped(() => getBuilderCheckpoint(current!.cycle.checkpointId!, sessionId, { tenantId, actorId }));
      const verification = await scoped(() => getBuilderVerification(current!.cycle.verificationId!, sessionId, { tenantId, actorId }));
      const deliveries = await scoped(() => listBuilderDeliveries(sessionId, { tenantId, actorId }));
      const activity = await scoped(() => listBuilderActivity(sessionId, { tenantId, actorId }, 100));
      expect(checkpoint?.workspaceSha256).toBe(current!.cycle.candidate!.workspaceSha256);
      expect((await getBuilderWorkspaceManifest(sandboxName)).sha256).toBe(checkpoint?.workspaceSha256);
      expect((await readBuilderRepositoryChanges({ sandboxName, repositoryId, baseSha })).map(change => change.kind === "upsert" ? change.file.path : change.path).sort()).toEqual([regressionPath, sourcePath].sort());
      expect(verification).toMatchObject({ status: "passed", checkpointId: checkpoint?.id });
      expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ status: "pull_request_open", commitSha: candidateSha, checkpointId: checkpoint?.id, verificationId: verification?.id });
      expect(githubCalls.filter(call => call.method === "POST" && call.path.endsWith("/pulls"))).toHaveLength(1);
      const modelCount = sequence, commandCount = executedCommands.length, githubCount = githubCalls.length;
      expect(await scoped(() => executeSelfImprovementJob(admitted.job, new AbortController().signal))).toMatchObject({ stage: "ready_for_release" });
      expect(sequence).toBe(modelCount); expect(executedCommands).toHaveLength(commandCount); expect(githubCalls).toHaveLength(githubCount);
      evidence.full_workflow = { admitted, current, phaseTurns, progress, reservations, runEvidence, checkpoint, verification, deliveries, activity,
        snapshots, commands, writes: writes.slice(effectStart), githubCalls, sourceUnchangedUntilImplementation: true, regressionUnchangedDuringImplementation: true,
        actualProviderCalls: 0, actualGithubCalls: 0, realGithubCodeOverSyntheticHttp: true };
    } finally {
      modelCheckpoint.mockRestore();
      const retained = await getSelfImprovementCycle(owner, admitted.cycleId);
      const retainedRuns = retained!.runtime.agentRuns as Array<{ runId: string }>;
      const retainedReceipts = await scoped(async () => Promise.all(retainedRuns.map(async item => {
        const events = await listStreamEvents(`run:${item.runId}`, { tenantId, limit: 1_000, order: "asc" });
        const ids = [...new Set(events.filter(event => event.type === "run.tool" && typeof event.payload.executionId === "string").map(event => String(event.payload.executionId)))];
        return { runId: item.runId, events, records: await getToolExecutionsByIds(ids, { tenantId }) };
      })));
      evidence.full_workflow_progress = { admitted, current: retained, progress, phaseTurns, retainedReceipts,
        reservations: await reservationRows(), commands: executedCommands.slice(commandStart), writes: writes.slice(effectStart), githubCalls };
      effectsAllowed = false; githubAllowed = false;
    }
  });
});
