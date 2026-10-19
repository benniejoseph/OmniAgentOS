import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { ingestKnowledgeService } from "@/lib/app-services/knowledge";
import { getCanonicalKnowledgeEvidenceByChunkIds, listKnowledgeChunks, listKnowledgeDocuments } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { executeGovernedTool } from "@/lib/tools/executor";

const mocks = vi.hoisted(() => ({ embedTexts: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1, 0.2])) }));
vi.mock("@/lib/openai/client", async (original) => ({
  ...await original<typeof import("@/lib/openai/client")>(),
  embedTexts: mocks.embedTexts,
}));
vi.mock("@/lib/trust/ledger", () => ({
  actionClassFor: (toolId: string) => toolId,
  recordActionOutcome: vi.fn(),
  resolveAutonomy: vi.fn(),
}));
vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

const context = { tenantId: "knowledge-save-tenant", actorId: "knowledge-save-owner", role: "admin" as const, source: "default" as const };
const executionScope = createExecutionScope({
  tenantId: context.tenantId, initiatingActorId: context.actorId,
  executingPrincipalType: "user", executingPrincipalId: context.actorId,
  correlationId: "knowledge-save-request", purpose: "tool.knowledge.save.test",
});
const document = { title: "Vendor recommendation", content: "Vendor A costs USD 600 and delivers in 7 days. Vendor B costs USD 450 and takes 10 days. Vendor A meets the 8-day deadline." };
let directory: string;
let previousDataDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  directory = await mkdtemp(path.join(tmpdir(), "asael-knowledge-save-"));
  process.env.OMNIAGENT_DATA_DIR = directory;
  delete process.env.DATABASE_URL;
  mocks.embedTexts.mockClear();
});
afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await rm(directory, { recursive: true, force: true });
});

describe("governed knowledge save through real application storage", () => {
  it.each(["app.knowledge.ingest", "knowledge.ingest"])("saves and verifies one attributed document through %s, then replays without another write", async (toolId) => {
    const request = { toolId, input: document, context, executionScope, dryRun: false, idempotencyKey: "save-recommendation" };
    const first = await executeGovernedTool(request);
    expect(first.record.status, first.record.reason).toBe("executed");
    const replay = await executeGovernedTool(request);
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.record.status).toBe("executed");
    const verification = await executeGovernedTool({ toolId: "app.knowledge.list", input: { limit: 20 }, context, executionScope, dryRun: false, idempotencyKey: "verify-recommendation" });
    expect(verification.record.status, verification.record.reason).toBe("executed");
    expect(verification.result).toMatchObject({ documents: [{ title: document.title }] });
    const chunks = await listKnowledgeChunks(20, { tenantId: context.tenantId });
    const evidence = await getCanonicalKnowledgeEvidenceByChunkIds(chunks.map(chunk => chunk.id), { tenantId: context.tenantId });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ chunk: { content: document.content }, evidenceUnit: { tenantId: context.tenantId, ownerActorId: context.actorId, capturedAt: first.record.createdAt, visibility: "user_private" } });
    expect(await listKnowledgeDocuments(20, { tenantId: "unrelated-tenant" })).toEqual([]);
    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
  });

  it("reuses the same admitted source and refuses changed content for that request", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: "direct-save" });
    const options = { observedAt: "2026-10-19T20:15:23.618Z" };
    const first = await ingestKnowledgeService(caller, document, options);
    const replay = await ingestKnowledgeService(caller, document, options);
    expect(replay.data.document.id).toBe(first.data.document.id);
    expect(await listKnowledgeDocuments(20, { tenantId: context.tenantId })).toHaveLength(1);
    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
    await expect(ingestKnowledgeService(caller, { ...document, content: "Changed comparison" }, options)).rejects.toThrow(/different|match|bound|payload/i);
    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
    expect((await listKnowledgeChunks(20, { tenantId: context.tenantId }))[0].content).toBe(document.content);
  });

  it("honors cancellation before embedding or saving", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: "canceled-save" });
    await expect(ingestKnowledgeService(caller, document, { observedAt: "2026-10-19T20:15:23.618Z", abortSignal: AbortSignal.abort(new Error("owner stopped")) })).rejects.toThrow("owner stopped");
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(await listKnowledgeDocuments(20, { tenantId: context.tenantId })).toEqual([]);
  });
});
