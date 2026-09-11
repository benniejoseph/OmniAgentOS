import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  enqueueSemanticSummaryEnrichmentJob: vi.fn(),
  getOwnedThread: vi.fn(),
  listConversationSummaries: vi.fn(),
  listCurrentSemanticEnrichments: vi.fn(),
  listThreads: vi.fn(),
  listThreadTurns: vi.fn(),
  projectOperationJobStatus: vi.fn(),
  rebuildConversationSummaryHierarchy: vi.fn(),
  resolveSemanticSummaryGenerationId: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueSemanticSummaryEnrichmentJob:
    routeMocks.enqueueSemanticSummaryEnrichmentJob,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
}));

vi.mock("@/lib/threads/semantic-summary-store", () => ({
  listCurrentSemanticEnrichments: routeMocks.listCurrentSemanticEnrichments,
}));

vi.mock("@/lib/threads/semantic-summaries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/threads/semantic-summaries")>()),
  resolveSemanticSummaryGenerationId:
    routeMocks.resolveSemanticSummaryGenerationId,
}));

vi.mock("@/lib/threads/store", () => ({
  createThread: vi.fn(),
  getOwnedThread: routeMocks.getOwnedThread,
  listConversationSummaries: routeMocks.listConversationSummaries,
  listThreads: routeMocks.listThreads,
  listThreadTurns: routeMocks.listThreadTurns,
  rebuildConversationSummaryHierarchy:
    routeMocks.rebuildConversationSummaryHierarchy,
}));

import {
  GET as GETThread,
  POST as POSTThread,
} from "@/app/api/threads/[id]/route";
import { GET as GETThreads } from "@/app/api/threads/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "thread-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [canonicalActorId, actorId],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.getOwnedThread.mockReset();
  routeMocks.listConversationSummaries.mockReset().mockResolvedValue([]);
  routeMocks.listCurrentSemanticEnrichments.mockReset().mockResolvedValue([]);
  routeMocks.listThreads.mockReset().mockResolvedValue([]);
  routeMocks.listThreadTurns.mockReset().mockResolvedValue([]);
  routeMocks.enqueueSemanticSummaryEnrichmentJob.mockReset();
  routeMocks.resolveSemanticSummaryGenerationId.mockReset().mockResolvedValue(
    `semantic_summary_generation_${"d".repeat(48)}`,
  );
  routeMocks.projectOperationJobStatus.mockReset().mockImplementation((job) => ({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.payload.progress,
    priority: job.priority,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  }));
  routeMocks.rebuildConversationSummaryHierarchy.mockReset().mockResolvedValue([]);
});

describe("request-bound thread routes", () => {
  it("passes the authenticated actor binding to the thread list", async () => {
    const response = await GETThreads(
      new Request("http://localhost/api/threads?limit=20"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listThreads).toHaveBeenCalledWith(20, {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
  });

  it("resolves the owner before reading thread turns", async () => {
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId,
      title: "Thread A",
      mode: "orchestrate",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });

    const response = await GETThread(
      new Request("http://localhost/api/threads/thread-a"),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getOwnedThread).toHaveBeenCalledWith("thread-a", {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
    expect(routeMocks.listThreadTurns).toHaveBeenCalledWith("thread-a", {
      tenantId: context.tenantId,
      limit: 40,
    });
    expect(routeMocks.listConversationSummaries).toHaveBeenCalledWith(
      "thread-a",
      { tenantId: context.tenantId, levels: ["episode"], limit: 100 },
    );
    expect(routeMocks.getOwnedThread.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.listThreadTurns.mock.invocationCallOrder[0],
    );
  });

  it("does not read turns when the owner-scoped thread is absent", async () => {
    routeMocks.getOwnedThread.mockResolvedValue(null);

    const response = await GETThread(
      new Request("http://localhost/api/threads/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listThreadTurns).not.toHaveBeenCalled();
    expect(routeMocks.listConversationSummaries).not.toHaveBeenCalled();
  });

  it("rebuilds only an owner-scoped hierarchy and removes actor coordinates", async () => {
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId,
      title: "Thread A",
      mode: "orchestrate",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    routeMocks.rebuildConversationSummaryHierarchy.mockResolvedValue([
      summaryRecord(),
    ]);

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rebuild_summaries" }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceType: "conversation_summary",
      resourceId: "thread-a",
    }));
    expect(routeMocks.rebuildConversationSummaryHierarchy).toHaveBeenCalledWith(
      "thread-a",
      { tenantId: context.tenantId, actorId },
    );
    const payload = await response.json();
    expect(payload.summaries[0]).not.toHaveProperty("actorId");
    expect(payload.summaries[0].accessScope).not.toHaveProperty("tenantId");
    expect(payload.summaries[0].accessScope).not.toHaveProperty("actorId");
  });

  it("queues only sealed owner episodes and returns trackable safe jobs", async () => {
    routeMocks.getOwnedThread.mockResolvedValue(threadRecord());
    routeMocks.listConversationSummaries.mockResolvedValue([
      sealedSummaryRecord(),
      summaryRecord(),
      sealedSummaryRecord({
        id: "summary-other-owner",
        actorId: "another-owner@example.test",
      }),
    ]);
    routeMocks.enqueueSemanticSummaryEnrichmentJob.mockResolvedValue(
      operationJob(),
    );

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "semantic-summary-request-a",
        },
        body: JSON.stringify({
          action: "enqueue_semantic_summaries",
          limit: 3,
        }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "write.memory",
        resourceType: "conversation_summary",
        resourceId: "thread-a",
        metadata: {
          action: "enqueue_semantic_summaries",
          limit: 3,
        },
      }),
    );
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).toHaveBeenCalledTimes(1);
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId,
      executionScope: expect.objectContaining({
        tenantId: context.tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: "semantic-summary-request-a",
        causationId: "summary-sealed-a",
        purpose: "conversation.summary.enrich.queue",
      }),
      request: {
        episodeSummaryId: "summary-sealed-a",
        episodeSourceSha256: "a".repeat(64),
        deterministicSummarySha256: "b".repeat(64),
        generationId: `semantic_summary_generation_${"d".repeat(48)}`,
      },
    });
    expect(payload).toMatchObject({
      deterministicSummariesActive: true,
      semanticEnrichment: { status: "queued", shadowOnly: true },
      eligibleEpisodeCount: 1,
      queuedJobCount: 1,
      upToDateCount: 0,
      staleEpisodeCount: 0,
      jobs: [{
        id: "semantic-job-a",
        type: "conversation.summary.enrich",
        status: "queued",
        progress: { stage: "queued", shadowOnly: true },
        statusUrl: "/api/operations/jobs/semantic-job-a",
      }],
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /private conversation|configured-semantic-model|episodeSummarySha256/i,
    );
  });

  it("keeps deterministic summaries active when no Memory model is configured", async () => {
    routeMocks.getOwnedThread.mockResolvedValue(threadRecord());
    routeMocks.listConversationSummaries.mockResolvedValue([
      sealedSummaryRecord(),
    ]);
    routeMocks.resolveSemanticSummaryGenerationId.mockRejectedValue(
      new Error("The semantic summary memory model is not configured."),
    );

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enqueue_semantic_summaries" }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      deterministicSummariesActive: true,
      semanticEnrichment: { status: "not_configured", shadowOnly: true },
      jobs: [],
      eligibleEpisodeCount: 1,
      queuedJobCount: 0,
    });
    expect(payload.message).toMatch(/configure the Memory model in Settings/i);
    expect(routeMocks.listCurrentSemanticEnrichments).not.toHaveBeenCalled();
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).not.toHaveBeenCalled();
  });

  it("does not regenerate a current enrichment for the same Settings generation", async () => {
    const episode = sealedSummaryRecord();
    routeMocks.getOwnedThread.mockResolvedValue(threadRecord());
    routeMocks.listConversationSummaries.mockResolvedValue([episode]);
    routeMocks.listCurrentSemanticEnrichments.mockResolvedValue([{
      contract: {
        episodeSummaryId: episode.id,
        episodeSourceSha256: episode.sourceSha256,
        deterministicSummarySha256: episode.summarySha256,
        generationId: `semantic_summary_generation_${"d".repeat(48)}`,
      },
    }]);

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enqueue_semantic_summaries" }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      semanticEnrichment: { status: "up_to_date", shadowOnly: true },
      jobs: [],
      eligibleEpisodeCount: 1,
      queuedJobCount: 0,
      upToDateCount: 1,
    });
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).not.toHaveBeenCalled();
  });

  it("does not enqueue semantic summaries without a canonical actor binding", async () => {
    routeMocks.authorizeRequest.mockResolvedValue({
      tenantId: context.tenantId,
      actorId,
      role: "admin",
      source: "header",
    });
    routeMocks.getOwnedThread.mockResolvedValue(threadRecord());

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enqueue_semantic_summaries" }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(409);
    expect(routeMocks.listConversationSummaries).not.toHaveBeenCalled();
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).not.toHaveBeenCalled();
  });

  it("rejects an unbounded semantic summary enqueue request", async () => {
    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "enqueue_semantic_summaries",
          limit: 26,
        }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.enqueueSemanticSummaryEnrichmentJob).not.toHaveBeenCalled();
  });
});

function threadRecord() {
  return {
    id: "thread-a",
    tenantId: context.tenantId,
    actorId,
    title: "Thread A",
    mode: "orchestrate",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function sealedSummaryRecord(overrides: Record<string, unknown> = {}) {
  const sourceTurnIds = Array.from(
    { length: 12 },
    (_, index) => `turn-${index}`,
  );
  const childSummaryIds = Array.from(
    { length: 12 },
    (_, index) => `turn-summary-${index}`,
  );
  return {
    ...summaryRecord(),
    id: "summary-sealed-a",
    sourceTurnIds,
    childSummaryIds,
    ...overrides,
  };
}

function operationJob() {
  return {
    id: "semantic-job-a",
    tenantId: context.tenantId,
    type: "conversation.summary.enrich",
    status: "queued",
    payload: {
      actorId,
      request: { privateConversation: "must not be projected" },
      progress: { stage: "queued", shadowOnly: true },
    },
    priority: 0,
    attempt: 0,
    maxAttempts: 3,
    runAt: "2026-09-11T05:00:00.000Z",
    createdAt: "2026-09-11T05:00:00.000Z",
    updatedAt: "2026-09-11T05:00:00.000Z",
  };
}

function summaryRecord() {
  return {
    id: "summary-a",
    tenantId: context.tenantId,
    actorId,
    level: "episode",
    bucketIndex: 0,
    threadId: "thread-a",
    content: "Episode summary",
    sourceTurnIds: ["turn-a"],
    childSummaryIds: ["turn-summary-a"],
    sourceSha256: "a".repeat(64),
    summarySha256: "b".repeat(64),
    accessScope: {
      schemaVersion: 1,
      visibility: "user_private",
      tenantId: context.tenantId,
      actorId,
      threadId: "thread-a",
      projectId: null,
      purposeIds: ["conversation.context.compile.v1"],
      scopeSha256: "c".repeat(64),
    },
    startsAt: "2026-09-04T10:00:00.000Z",
    endsAt: "2026-09-04T11:00:00.000Z",
    rebuildable: true,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}
