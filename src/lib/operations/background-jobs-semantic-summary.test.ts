import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSource: vi.fn(),
  saveEnrichment: vi.fn(),
  resolveGeneration: vi.fn(),
  enrichEpisode: vi.fn(),
}));

vi.mock("@/lib/threads/semantic-summary-store", () => ({
  readOwnedSemanticEpisodeSource: mocks.readSource,
  saveSemanticEnrichmentFromWorker: mocks.saveEnrichment,
}));

vi.mock("@/lib/threads/semantic-summaries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/threads/semantic-summaries")>()),
  resolveSemanticSummaryGenerationId: mocks.resolveGeneration,
  enrichConversationEpisode: mocks.enrichEpisode,
}));

import {
  enqueueSemanticSummaryEnrichmentJob,
  processBackgroundOperationQueue,
} from "@/lib/operations/background-jobs";
import {
  enqueueOperationJob,
  getOperationJob,
} from "@/lib/operations/job-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildThreadConversationSummaries } from "@/lib/threads/summaries";
import type { OwnedSemanticEpisodeSource } from "@/lib/threads/semantic-summary-store";
import type { ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

const generationA = `semantic_summary_generation_${"a".repeat(48)}`;
const generationB = `semantic_summary_generation_${"b".repeat(48)}`;
let dataDirectory: string | undefined;

describe("semantic episode enrichment background job", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    dataDirectory = await mkdtemp(
      path.join(tmpdir(), "asael-semantic-summary-job-"),
    );
    process.env.OMNIAGENT_DATA_DIR = dataDirectory;
    delete process.env.DATABASE_URL;
    mocks.resolveGeneration.mockResolvedValue(generationA);
  });

  afterEach(async () => {
    delete process.env.OMNIAGENT_DATA_DIR;
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
    vi.useRealTimers();
  });

  it("coalesces the latest source for one deterministic episode", async () => {
    const firstSource = episodeSource("tenant-coalesce", "actor-coalesce", "First");
    const latestSource = episodeSource("tenant-coalesce", "actor-coalesce", "Latest");
    mocks.readSource
      .mockResolvedValueOnce(firstSource)
      .mockResolvedValueOnce(latestSource);
    const scope = requestScope(firstSource);

    const first = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: firstSource.episode.tenantId,
      actorId: firstSource.episode.actorId,
      executionScope: scope,
      request: enrichmentRequest(firstSource),
    });
    const latest = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: latestSource.episode.tenantId,
      actorId: latestSource.episode.actorId,
      executionScope: scope,
      request: enrichmentRequest(latestSource),
    });

    expect(latest?.id).toBe(first?.id);
    expect(latest?.type).toBe("conversation.summary.enrich");
    expect(latest?.dedupeKey).toMatch(
      /^conversation\.summary\.enrich:[a-f0-9]{48}$/,
    );
    expect(latest?.payload.request).toMatchObject({
      episodeSummaryId: latestSource.episode.id,
      episodeSourceSha256: latestSource.episode.sourceSha256,
      deterministicSummarySha256: latestSource.episode.summarySha256,
      generationId: generationA,
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const firstRequest = first?.payload.request as Record<string, unknown>;
    const latestRequest = latest?.payload.request as Record<string, unknown>;
    expect(latestRequest.deterministicSummarySha256)
      .not.toBe(firstRequest.deterministicSummarySha256);
    expect(latestRequest.sourceSha256).not.toBe(firstRequest.sourceSha256);
    expect(latest?.payload.executionScope).toMatchObject({
      tenantId: latestSource.episode.tenantId,
      initiatingActorId: latestSource.episode.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      workspaceId: null,
      projectId: latestSource.episode.projectId,
      missionId: null,
      delegationId: null,
      causationId: latestSource.episode.id,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "conversation.summary.enrich.v1",
    });
  });

  it("executes in exact actor scope and persists only shadow enrichment metadata", async () => {
    const source = episodeSource("tenant-execute", "actor-execute", "Stable");
    mocks.readSource.mockResolvedValue(source);
    const queued = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      executionScope: requestScope(source),
      request: enrichmentRequest(source),
    });
    const contract = generatedContract(source);
    mocks.enrichEpisode.mockResolvedValue(contract);
    mocks.saveEnrichment.mockResolvedValue({
      contract,
      episodeSummarySha256: source.episode.summarySha256,
      createdAt: "2026-09-11T12:20:00.000Z",
    });

    await expect(processBackgroundOperationQueue({
      tenantId: source.episode.tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    expect(mocks.resolveGeneration).toHaveBeenCalledTimes(2);
    expect(mocks.enrichEpisode).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      episode: source.episode,
      turns: source.turns,
      generationId: generationA,
      executionScope: expect.objectContaining({
        initiatingActorId: source.episode.actorId,
        executingPrincipalId: "background-operations-worker",
        purpose: "conversation.summary.enrich.v1",
      }),
      abortSignal: expect.any(AbortSignal),
    }));
    expect(mocks.saveEnrichment).toHaveBeenCalledWith(contract, {
      executionScope: expect.objectContaining({
        tenantId: source.episode.tenantId,
        initiatingActorId: source.episode.actorId,
        executingPrincipalId: "background-operations-worker",
        purpose: "conversation.summary.enrich.v1",
      }),
    });
    const completed = await getOperationJob(queued!.id, {
      tenantId: source.episode.tenantId,
    });
    expect(completed).toMatchObject({
      status: "completed",
      payload: {
        progress: { stage: "completed" },
        result: {
          resourceId: contract.enrichmentId,
          status: "enriched",
          statementCount: 1,
          shadowOnly: true,
          rankingEffect: "none",
        },
      },
    });
    expect(completed?.payload).not.toHaveProperty("request");
    expect(JSON.stringify(completed?.payload.result)).not.toContain("Stable");
  });

  it("completes stale model generations as superseded without model or store calls", async () => {
    const source = episodeSource("tenant-generation", "actor-generation", "Stable");
    mocks.readSource.mockResolvedValue(source);
    mocks.resolveGeneration
      .mockResolvedValueOnce(generationA)
      .mockResolvedValueOnce(generationB);
    const queued = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      executionScope: requestScope(source),
      request: enrichmentRequest(source),
    });

    await processBackgroundOperationQueue({
      tenantId: source.episode.tenantId,
      limit: 1,
    });

    expect(mocks.enrichEpisode).not.toHaveBeenCalled();
    expect(mocks.saveEnrichment).not.toHaveBeenCalled();
    await expect(getOperationJob(queued!.id, {
      tenantId: source.episode.tenantId,
    })).resolves.toMatchObject({
      status: "completed",
      payload: {
        result: {
          status: "superseded",
          generationId: generationA,
          shadowOnly: true,
          rankingEffect: "none",
        },
      },
    });
  });

  it("supersedes changed episode evidence before resolving or calling a model", async () => {
    const queuedSource = episodeSource("tenant-source", "actor-source", "Queued");
    const changedSource = episodeSource("tenant-source", "actor-source", "Changed");
    mocks.readSource
      .mockResolvedValueOnce(queuedSource)
      .mockResolvedValueOnce(changedSource);
    const queued = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: queuedSource.episode.tenantId,
      actorId: queuedSource.episode.actorId,
      executionScope: requestScope(queuedSource),
      request: enrichmentRequest(queuedSource),
    });

    await processBackgroundOperationQueue({
      tenantId: queuedSource.episode.tenantId,
      limit: 1,
    });

    expect(mocks.resolveGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.enrichEpisode).not.toHaveBeenCalled();
    expect(mocks.saveEnrichment).not.toHaveBeenCalled();
    await expect(getOperationJob(queued!.id, {
      tenantId: queuedSource.episode.tenantId,
    })).resolves.toMatchObject({
      payload: { result: { status: "superseded" } },
    });
  });

  it("rejects cross-actor authority and does not queue stale client bindings", async () => {
    const source = episodeSource("tenant-scope", "actor-scope", "Stable");
    mocks.readSource.mockResolvedValue(source);
    await expect(enqueueSemanticSummaryEnrichmentJob({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      executionScope: createExecutionScope({
        tenantId: source.episode.tenantId,
        initiatingActorId: "another-actor",
        executingPrincipalType: "user",
        executingPrincipalId: "another-actor",
        correlationId: "semantic-summary-cross-actor",
        purpose: "conversation.summary.enrich.queue",
      }),
      request: enrichmentRequest(source),
    })).rejects.toThrow(/does not match its actor/i);

    const stale = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      executionScope: requestScope(source),
      request: {
        ...enrichmentRequest(source),
        deterministicSummarySha256: "f".repeat(64),
      },
    });
    expect(stale).toBeNull();
  });

  it("fails closed when persisted worker causation or grants are broadened", async () => {
    const source = episodeSource("tenant-worker-scope", "actor-worker-scope", "Stable");
    mocks.readSource.mockResolvedValue(source);
    const queued = await enqueueSemanticSummaryEnrichmentJob({
      tenantId: source.episode.tenantId,
      actorId: source.episode.actorId,
      executionScope: requestScope(source),
      request: enrichmentRequest(source),
    });
    const workerScope = queued!.payload.executionScope as Record<string, unknown>;
    await enqueueOperationJob({
      tenantId: source.episode.tenantId,
      type: "conversation.summary.enrich",
      dedupeKey: queued!.dedupeKey,
      payload: {
        ...queued!.payload,
        executionScope: {
          ...workerScope,
          causationId: "another-episode",
          contextGrantIds: ["broadened-context-grant"],
        },
      },
      maxAttempts: 1,
      dedupeMode: "coalesce",
    });

    await expect(processBackgroundOperationQueue({
      tenantId: source.episode.tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 0, failed: 1 });
    expect(mocks.resolveGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.enrichEpisode).not.toHaveBeenCalled();
    expect(mocks.saveEnrichment).not.toHaveBeenCalled();
    await expect(getOperationJob(queued!.id, {
      tenantId: source.episode.tenantId,
    })).resolves.toMatchObject({
      status: "failed",
      lastError: "Semantic summary enrichment job scope is invalid.",
    });
  });
});

function episodeSource(
  tenantId: string,
  actorId: string,
  marker: string,
): OwnedSemanticEpisodeSource {
  const thread: ThreadRecord = {
    id: "thread-semantic-background",
    tenantId,
    actorId,
    projectId: "project-semantic-background",
    title: "Semantic background",
    mode: "orchestrate",
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:12:00.000Z",
  };
  const turns: ThreadTurnRecord[] = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-semantic-${index}`,
    tenantId,
    threadId: thread.id,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${marker} turn ${index}`,
    createdAt: new Date(Date.parse(thread.createdAt) + index * 60_000).toISOString(),
  }));
  const episode = buildThreadConversationSummaries({
    thread,
    turns,
    now: "2026-09-11T12:15:00.000Z",
  }).find((summary) => summary.level === "episode")!;
  return { episode, turns };
}

function enrichmentRequest(source: OwnedSemanticEpisodeSource) {
  return {
    episodeSummaryId: source.episode.id,
    episodeSourceSha256: source.episode.sourceSha256,
    deterministicSummarySha256: source.episode.summarySha256,
    generationId: generationA,
  };
}

function requestScope(source: OwnedSemanticEpisodeSource) {
  return createExecutionScope({
    tenantId: source.episode.tenantId,
    initiatingActorId: source.episode.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: source.episode.actorId,
    projectId: source.episode.projectId,
    correlationId: `semantic-summary-${source.episode.tenantId}`,
    purpose: "conversation.summary.enrich.queue",
  });
}

function generatedContract(source: OwnedSemanticEpisodeSource) {
  return {
    enrichmentId: `semantic_episode_enrichment_${"c".repeat(48)}`,
    episodeSummaryId: source.episode.id,
    generationId: generationA,
    sourceSha256: "d".repeat(64),
    enrichmentSha256: "e".repeat(64),
    statements: [{ statementId: `semantic_episode_statement_${"f".repeat(48)}` }],
  };
}
