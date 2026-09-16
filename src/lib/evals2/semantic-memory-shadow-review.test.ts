import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pairs: [] as unknown[],
  jobs: [] as unknown[],
  events: [] as Array<Record<string, unknown>>,
  append: vi.fn(),
  listEvents: vi.fn(),
  listJobs: vi.fn(),
  listPairs: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.append,
  listRecentEvents: mocks.listEvents,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  listOperationJobs: mocks.listJobs,
}));
vi.mock("@/lib/threads/semantic-summary-store", () => ({
  listOwnedSemanticSummaryEnrichments: mocks.listPairs,
}));

import { createExecutionScope } from "@/lib/security/execution-scope";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import {
  getSemanticMemoryShadowReviewWorkspace,
  saveSemanticMemoryShadowReview,
  saveSemanticMemoryShadowRankProbe,
  SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE,
  SemanticMemoryShadowReviewConflictError,
} from "@/lib/evals2/semantic-memory-shadow-review";
import {
  buildSemanticEpisodeEnrichmentV1,
  deriveSemanticEpisodeEnrichmentId,
  deriveSemanticEpisodeStatementId,
  semanticEpisodeOutputSha256,
  semanticEpisodeSourceSha256,
} from "@/lib/threads/semantic-summaries";
import { buildThreadConversationSummaries } from "@/lib/threads/summaries";
import type { ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

const tenantId = "tenant-shadow-review";
const actorId = "actor:shadow-review";
const correlationId = "review-correlation-1";
const fixture = semanticFixture();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pairs = [fixture.pair];
  mocks.jobs = [{
    payload: {
      actorId,
      result: {
        enrichmentId: fixture.contract.enrichmentId,
        generationLatencyMs: 2_450,
      },
    },
  }];
  mocks.events = [];
  mocks.listPairs.mockImplementation(async () => mocks.pairs);
  mocks.listJobs.mockImplementation(async () => mocks.jobs);
  mocks.listEvents.mockImplementation(async () => mocks.events);
  mocks.append.mockImplementation(async (input: Record<string, unknown>) => {
    const scope = input.executionScope as ReturnType<typeof reviewScope>;
    const event = {
      id: input.id,
      seq: mocks.events.length + 1,
      streamId: input.streamId,
      type: input.type,
      tenantId: scope.tenantId,
      actorId: scope.initiatingActorId,
      payload: input.payload,
      executionScope: scope,
      correlationId: scope.correlationId,
      causationId: scope.causationId,
      at: "2026-09-16T08:30:00.000Z",
    };
    mocks.events.push(event);
    return event;
  });
});

describe("semantic shadow human review", () => {
  it("builds a reviewable actor-scoped candidate with exact source evidence", async () => {
    const workspace = await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
    });

    expect(mocks.listPairs).toHaveBeenCalledWith({
      tenantId,
      actorIds: [actorId],
      limit: 24,
    });
    expect(workspace.report).toBeNull();
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0]).toMatchObject({
      id: fixture.contract.enrichmentId,
      reviewable: true,
      metrics: {
        generationLatencyMs: 2_450,
        quoteBindingCount: 2,
        validQuoteBindingCount: 2,
        semanticItemCount: 2,
        deterministicReplayMatch: true,
      },
      scope: {
        ownerActorId: actorId,
        threadId: fixture.thread.id,
        sourceSha256: fixture.contract.sourceSha256,
        enrichmentSha256: fixture.contract.enrichmentSha256,
      },
    });
    expect(workspace.candidates[0].sourceTurns[1].content).toContain(
      "Friday is approved",
    );
    expect(workspace.candidates[0].semanticItems[0].evidence[0].valid)
      .toBe(true);
  });

  it("persists content-free adjudication and immediately projects the gate case", async () => {
    const candidate = (await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
    })).candidates[0];
    const itemDecisions = candidate.semanticItems.map(({ id }) => ({
      itemId: id,
      decision: "supported" as const,
    }));

    const saved = await saveSemanticMemoryShadowReview({
      tenantId,
      actorIds: [actorId],
      review: {
        enrichmentId: candidate.id,
        reviewSourceSha256: candidate.reviewSourceSha256,
        dimension: "decision",
        itemDecisions,
        importantFactCount: 3,
        baselineImportantFactHitCount: 1,
        semanticImportantFactHitCount: 3,
        compressionJudgment: "good",
        scopeLeakCount: 0,
        humanReviewed: true,
      },
      executionScope: reviewScope(),
      correlationId,
    });

    expect(saved).toMatchObject({
      reviewSourceSha256: candidate.reviewSourceSha256,
      itemDecisions,
      case: {
        humanReviewed: true,
        dimension: "decision",
        supportedSemanticItemCount: 2,
        generationLatencyMs: 2_450,
      },
    });
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({
      streamId: `conversation-summary:${fixture.episode.id}`,
      type: SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE,
      executionScope: reviewScope(),
    }));
    const eventPayload = JSON.stringify(
      (mocks.append.mock.calls[0][0] as Record<string, unknown>).payload,
    );
    expect(eventPayload).not.toContain("Friday is approved");
    expect(eventPayload).not.toContain("Apollo remains scheduled");
    expect(eventPayload).not.toContain("configured-semantic-memory-model");

    const projected = await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
    });
    expect(projected.observation?.cases).toHaveLength(1);
    expect(projected.report).toMatchObject({
      caseCount: 1,
      activationReady: false,
      failureCodes: expect.arrayContaining(["insufficient_cases"]),
    });
    expect(projected.candidates[0].latestReview).toMatchObject({
      reviewSourceSha256: candidate.reviewSourceSha256,
    });
  });

  it("rejects partial, stale, and incorrectly scoped review writes", async () => {
    const candidate = (await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
    })).candidates[0];
    const baseReview = {
      enrichmentId: candidate.id,
      reviewSourceSha256: candidate.reviewSourceSha256,
      dimension: "decision" as const,
      itemDecisions: [{
        itemId: candidate.semanticItems[0].id,
        decision: "supported" as const,
      }],
      importantFactCount: 1,
      baselineImportantFactHitCount: 1,
      semanticImportantFactHitCount: 1,
      compressionJudgment: "good" as const,
      scopeLeakCount: 0,
      humanReviewed: true as const,
    };

    await expect(saveSemanticMemoryShadowReview({
      tenantId,
      actorIds: [actorId],
      review: baseReview,
      executionScope: reviewScope(),
      correlationId,
    })).rejects.toBeInstanceOf(SemanticMemoryShadowReviewConflictError);
    await expect(saveSemanticMemoryShadowReview({
      tenantId,
      actorIds: [actorId],
      review: {
        ...baseReview,
        reviewSourceSha256: "f".repeat(64),
        itemDecisions: candidate.semanticItems.map(({ id }) => ({
          itemId: id,
          decision: "supported" as const,
        })),
      },
      executionScope: reviewScope(),
      correlationId,
    })).rejects.toBeInstanceOf(SemanticMemoryShadowReviewConflictError);
    await expect(saveSemanticMemoryShadowReview({
      tenantId,
      actorIds: [actorId],
      review: {
        ...baseReview,
        itemDecisions: candidate.semanticItems.map(({ id }) => ({
          itemId: id,
          decision: "supported" as const,
        })),
      },
      executionScope: reviewScope({ correlationId: "wrong-correlation" }),
      correlationId,
    })).rejects.toThrow("exact actor and episode scope");
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("persists a separate measured rank probe without retaining its query", async () => {
    mocks.pairs = Array.from({ length: 24 }, (_, index) => {
      const summary = index === 23
        ? {
            ...fixture.contract.summary,
            text: "Apollo release date was approved for Friday.",
          }
        : fixture.contract.summary;
      return {
        ...fixture.pair,
        record: {
          ...fixture.pair.record,
          contract: {
            ...fixture.contract,
            enrichmentId:
              `semantic_episode_enrichment_${index.toString(16).padStart(48, "0")}`,
            summary,
            enrichmentSha256: semanticEpisodeOutputSha256({
              summary,
              statements: fixture.contract.statements,
            }),
          },
        },
      };
    });
    mocks.jobs = mocks.pairs.map((pair) => ({
      payload: {
        actorId,
        result: {
          enrichmentId: (pair as typeof fixture.pair).record.contract.enrichmentId,
          generationLatencyMs: 2_450,
        },
      },
    }));
    const workspace = await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
      limit: 100,
    });
    const candidate = workspace.candidates[23];
    const probeCorrelationId = "rank-probe-correlation-1";

    const saved = await saveSemanticMemoryShadowRankProbe({
      tenantId,
      actorIds: [actorId],
      probe: {
        enrichmentId: candidate.id,
        reviewSourceSha256: candidate.reviewSourceSha256,
        query: "Which Apollo release date was approved?",
        humanConfirmedTarget: true,
      },
      correlationId: probeCorrelationId,
      executionScope: rankProbeScope(candidate, probeCorrelationId),
    });

    expect(saved).toMatchObject({
      enrichmentId: candidate.id,
      corpusCount: 24,
      semanticFirstRelevantRank: 1,
      humanConfirmedTarget: true,
    });
    const payload = JSON.stringify(
      (mocks.append.mock.calls.at(-1)?.[0] as Record<string, unknown>).payload,
    );
    expect(payload).not.toContain("Which Apollo release date was approved?");
    expect(payload).toContain("semantic-memory-shadow-rank-probe:1");

    const projected = await getSemanticMemoryShadowReviewWorkspace({
      tenantId,
      actorIds: [actorId],
      limit: 100,
    });
    expect(projected.candidates[23].latestRankProbe).toMatchObject({
      corpusCount: 24,
      semanticFirstRelevantRank: 1,
    });
  });
});

function reviewScope(overrides: { correlationId?: string } = {}) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    workspaceId: null,
    projectId: fixture.thread.projectId,
    missionId: null,
    delegationId: null,
    correlationId: overrides.correlationId || correlationId,
    causationId: fixture.contract.enrichmentId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "conversation.summary.semantic_shadow.review",
  });
}

function rankProbeScope(
  candidate: Awaited<ReturnType<
    typeof getSemanticMemoryShadowReviewWorkspace
  >>["candidates"][number],
  correlationId: string,
) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    workspaceId: null,
    projectId: candidate.scope.projectId,
    missionId: null,
    delegationId: null,
    correlationId,
    causationId: candidate.id,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "conversation.summary.semantic_shadow.rank_probe",
  });
}

function semanticFixture() {
  const thread: ThreadRecord = {
    id: "thread-shadow-review",
    tenantId,
    actorId,
    projectId: "project-shadow-review",
    title: "Apollo planning",
    mode: "learn",
    createdAt: "2026-09-16T07:00:00.000Z",
    updatedAt: "2026-09-16T08:00:00.000Z",
  };
  const turns: ThreadTurnRecord[] = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-shadow-${index}`,
    tenantId,
    threadId: thread.id,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: index === 1
      ? "Friday is approved for Apollo, and the team should preserve the launch checklist."
      : `Exact private planning detail ${index} keeps this evaluation episode representative and long enough for review.`,
    createdAt: new Date(Date.UTC(2026, 8, 16, 7, index)).toISOString(),
  }));
  const episode = buildThreadConversationSummaries({
    thread,
    turns,
    now: "2026-09-16T08:05:00.000Z",
  }).find((summary) => summary.level === "episode")!;
  const quote = "Friday is approved for Apollo";
  const startOffset = turns[1].content.indexOf(quote);
  const evidence = {
    turnId: turns[1].id,
    quote,
    quoteSha256: contentSha256Hex(quote),
    coordinateSpace: "turn_content" as const,
    offsetUnit: "utf16_code_unit" as const,
    startOffset,
    endOffsetExclusive: startOffset + quote.length,
  };
  const statementBody = {
    kind: "decision" as const,
    text: "Apollo remains scheduled for Friday.",
    confidenceBasisPoints: 9_500,
    evidence: [evidence],
  };
  const statements = [{
    statementId: deriveSemanticEpisodeStatementId(statementBody),
    ...statementBody,
  }];
  const summary = {
    text: "Apollo is scheduled for Friday with its launch checklist preserved.",
    confidenceBasisPoints: 9_200,
    evidence: [evidence],
  };
  const sourceSha256 = semanticEpisodeSourceSha256({ episode, turns });
  const generationId = `semantic_summary_generation_${"a".repeat(48)}`;
  const enrichmentId = deriveSemanticEpisodeEnrichmentId({
    generationId,
    sourceSha256,
  });
  const contract = buildSemanticEpisodeEnrichmentV1({
    enrichmentId,
    generationId,
    tenantId,
    ownerActorId: actorId,
    threadId: thread.id,
    projectId: thread.projectId || null,
    episodeSummaryId: episode.id,
    episodeSourceSha256: episode.sourceSha256,
    deterministicSummarySha256: episode.summarySha256,
    bucketIndex: episode.bucketIndex,
    startsAt: episode.startsAt,
    endsAt: episode.endsAt,
    sourceTurnIds: [...episode.sourceTurnIds],
    inputCharacterCount: turns.reduce((sum, turn) => sum + turn.content.length, 0),
    sourceSha256,
    summary,
    statements,
    enrichmentSha256: semanticEpisodeOutputSha256({ summary, statements }),
    modelAttribution: {
      provider: "openai",
      model: "configured-semantic-memory-model",
      routingSource: "tenant_assignment",
      assignmentScope: "memory",
      assignmentId: "assignment-semantic-memory",
      assignmentRevision: 1,
      assignmentConfigurationSha256: "b".repeat(64),
      credentialSource: "tenant_vault",
      usageReceiptRecorded: true,
      usageReceiptId: "usage-shadow-review",
    },
  });
  return {
    thread,
    turns,
    episode,
    contract,
    pair: {
      record: {
        contract,
        episodeSummarySha256: episode.summarySha256,
        createdAt: "2026-09-16T08:10:00.000Z",
      },
      source: { episode, turns },
    },
  };
}
