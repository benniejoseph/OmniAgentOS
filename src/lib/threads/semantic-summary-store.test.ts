import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async (
    _input: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ) => ({ id: "semantic-summary-event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: () => false,
  runWithDatabaseActorScope: vi.fn(
    async (_tenantId: string, _actorIds: string[], operation: () => unknown) =>
      operation(),
  ),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExecutionScope } from "@/lib/security/execution-scope";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  getCurrentSemanticEnrichment,
  getSemanticSummaryShadowStats,
  listCurrentSemanticEnrichments,
  listOwnedSemanticSummaryEnrichments,
  readOwnedSemanticEpisodeSource,
  saveSemanticEnrichmentFromWorker,
  SEMANTIC_SUMMARY_ENRICHED_EVENT_TYPE,
  SemanticSummaryEnrichmentConflictError,
  SemanticSummaryStaleSourceError,
} from "@/lib/threads/semantic-summary-store";
import {
  buildSemanticEpisodeEnrichmentV1,
  deriveSemanticEpisodeEnrichmentId,
  deriveSemanticEpisodeStatementId,
  semanticEpisodeOutputSha256,
  semanticEpisodeSourceSha256,
  SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
  type SemanticEpisodeEnrichmentV1,
  type SemanticEpisodeEvidenceBindingV1,
} from "@/lib/threads/semantic-summaries";
import {
  buildThreadConversationSummaries,
  type ConversationSummaryRecord,
} from "@/lib/threads/summaries";
import type {
  ThreadLedger,
  ThreadRecord,
  ThreadTurnRecord,
} from "@/lib/threads/types";

const tenantId = "tenant-semantic-store";
const actorId = "actor:semantic-store";
let dataDir = "";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T05:30:00.000Z"));
  dataDir = await mkdtemp(path.join(tmpdir(), "asael-semantic-store-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  mocks.appendScopedDomainEvent.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OMNIAGENT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("semantic conversation summary store", () => {
  it("reports only current content-free shadow progress in the requested actor scope", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    await saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
    });

    await expect(getSemanticSummaryShadowStats({
      tenantId,
      actorIds: [actorId],
    })).resolves.toEqual({
      currentEnrichmentCount: 1,
      distinctThreadCount: 1,
    });
    await expect(getSemanticSummaryShadowStats({
      tenantId,
      actorIds: ["actor:sibling"],
    })).resolves.toEqual({
      currentEnrichmentCount: 0,
      distinctThreadCount: 0,
    });
    await expect(getSemanticSummaryShadowStats({
      tenantId,
      actorIds: [],
    })).rejects.toThrow("bounded actor scope");
  });

  it("reads bounded PostgreSQL shadow counts without opening enrichment content", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const sql = fakeSql((text, values) => {
      calls.push({ text, values });
      return [{
        current_enrichment_count: "24",
        distinct_thread_count: "6",
      }];
    });

    await expect(getSemanticSummaryShadowStats({
      tenantId,
      actorIds: [actorId, "actor:legacy"],
    }, { sql: sql as never })).resolves.toEqual({
      currentEnrichmentCount: 24,
      distinctThreadCount: 6,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("COUNT(DISTINCT enrichment.thread_id)");
    expect(calls[0].text).not.toContain("enrichment.contract");
  });

  it("reads, saves, and lists an exact owner enrichment idempotently", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);

    const source = await readOwnedSemanticEpisodeSource({
      tenantId,
      actorId,
      episodeSummaryId: fixture.episode.id,
    });
    expect(source?.turns.map((turn) => turn.id)).toEqual(
      fixture.episode.sourceTurnIds,
    );

    const first = await saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
    });
    const second = await saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
    });
    expect(second).toEqual(first);
    expect(await getCurrentSemanticEnrichment({
      tenantId,
      actorId,
      enrichmentId: contract.enrichmentId,
    })).toEqual(first);
    expect(await getCurrentSemanticEnrichment({
      tenantId,
      actorId: "actor:someone-else",
      enrichmentId: contract.enrichmentId,
    })).toBeUndefined();
    expect(await listCurrentSemanticEnrichments({
      tenantId,
      actorId,
      threadId: thread.id,
    })).toEqual([first]);
    expect(await listOwnedSemanticSummaryEnrichments({
      tenantId,
      actorIds: [actorId],
    })).toEqual([{ record: first, source }]);
    expect(await listOwnedSemanticSummaryEnrichments({
      tenantId,
      actorIds: ["actor:someone-else"],
    })).toEqual([]);
    expect(await readOwnedSemanticEpisodeSource({
      tenantId,
      actorId: "actor:someone-else",
      episodeSummaryId: fixture.episode.id,
    })).toBeUndefined();
    expect(await listCurrentSemanticEnrichments({
      tenantId,
      actorId: "actor:someone-else",
      threadId: thread.id,
    })).toEqual([]);

    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
    const event = mocks.appendScopedDomainEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      type: SEMANTIC_SUMMARY_ENRICHED_EVENT_TYPE,
      streamId: `conversation-summary:${fixture.episode.id}`,
      payload: {
        schemaVersion: 1,
        enrichmentId: contract.enrichmentId,
        generationId: contract.generationId,
        episodeSummaryId: fixture.episode.id,
        episodeSourceSha256: fixture.episode.sourceSha256,
        episodeSummarySha256: fixture.episode.summarySha256,
        sourceSha256: contract.sourceSha256,
        enrichmentSha256: contract.enrichmentSha256,
        contractSha256: contract.contractSha256,
        sourceTurnCount: 12,
        statementCount: 1,
        shadowOnly: true,
        createdAt: "2026-09-11T05:30:00.000Z",
      },
    });
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain("Friday is approved");
    expect(serializedEvent).not.toContain("Apollo remains scheduled");
    expect(serializedEvent).not.toContain("evidence");
    expect(serializedEvent).not.toContain("modelAttribution");
  });

  it("rejects changed turn content and stops listing stale derived records", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    const saved = await saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
    });
    const siblingThread: ThreadRecord = {
      ...thread,
      id: "thread-sibling-tenant",
      tenantId: "tenant-sibling",
      actorId: "actor:sibling",
      projectId: "project-sibling",
    };
    const siblingTurns = makeTurns(siblingThread);
    const siblingEpisode = buildThreadConversationSummaries({
      thread: siblingThread,
      turns: siblingTurns,
      now: "2026-09-11T04:31:00.000Z",
    }).find((summary) => summary.level === "episode")!;
    const siblingContract = enrichmentContract(
      siblingEpisode,
      siblingTurns,
    );
    const enrichmentFile = getDataPath(
      "conversation-summary-enrichments.json",
    );
    const stored = await readJsonFile<{
      schemaVersion: 1;
      records: Array<Record<string, unknown>>;
    }>(enrichmentFile, { schemaVersion: 1, records: [] });
    await writeJsonFile(enrichmentFile, {
      ...stored,
      records: [...stored.records, {
        contract: siblingContract,
        episodeSummarySha256: siblingEpisode.summarySha256,
        createdAt: "2026-09-11T05:29:00.000Z",
      }],
    });
    const changedTurns = fixture.turns.map((turn, index) =>
      index === 1
        ? { ...turn, content: "Friday was replaced by Monday." }
        : turn
    );
    await writeThreadLedger({
      threads: [thread],
      turns: changedTurns,
      summaries: [...fixture.summaries],
    });

    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
    })).rejects.toBeInstanceOf(SemanticSummaryStaleSourceError);
    expect(await getCurrentSemanticEnrichment({
      tenantId,
      actorId,
      enrichmentId: contract.enrichmentId,
    })).toBeUndefined();
    expect(await listCurrentSemanticEnrichments({
      tenantId,
      actorId,
      threadId: thread.id,
    })).toEqual([]);
    const retained = await readJsonFile<{
      schemaVersion: 1;
      records: Array<{ contract: SemanticEpisodeEnrichmentV1 }>;
    }>(enrichmentFile, { schemaVersion: 1, records: [] });
    expect(retained.records).toHaveLength(1);
    expect(retained.records[0].contract.tenantId).toBe("tenant-sibling");
    expect(saved.contract.enrichmentId).toBe(contract.enrichmentId);
  });

  it("rejects deterministic summary drift and contract digest conflicts", async () => {
    const fixture = await seedThreadLedger();
    const first = enrichmentContract(fixture.episode, fixture.turns);
    await saveSemanticEnrichmentFromWorker(first, {
      executionScope: workerScope(),
    });
    const conflicting = enrichmentContract(
      fixture.episode,
      fixture.turns,
      "A different but valid shadow output.",
    );
    expect(conflicting.enrichmentId).toBe(first.enrichmentId);
    expect(conflicting.contractSha256).not.toBe(first.contractSha256);
    await expect(saveSemanticEnrichmentFromWorker(conflicting, {
      executionScope: workerScope(),
    })).rejects.toBeInstanceOf(SemanticSummaryEnrichmentConflictError);

    const replacementContent = "A newly rendered deterministic episode summary.";
    const changedEpisode = {
      ...fixture.episode,
      content: replacementContent,
      summarySha256: createHash("sha256")
        .update(replacementContent)
        .digest("hex"),
      updatedAt: "2026-09-11T05:31:00.000Z",
    };
    await writeThreadLedger({
      threads: [thread],
      turns: fixture.turns,
      summaries: fixture.summaries.map((summary) =>
        summary.id === fixture.episode.id ? changedEpisode : summary
      ),
    });
    await expect(saveSemanticEnrichmentFromWorker(first, {
      executionScope: workerScope(),
    })).rejects.toBeInstanceOf(SemanticSummaryStaleSourceError);
    expect(await listCurrentSemanticEnrichments({
      tenantId,
      actorId,
      threadId: thread.id,
    })).toEqual([]);
  });

  it("requires the exact project-bound governed worker scope", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "some-other-worker",
        projectId: thread.projectId,
        correlationId: "wrong-worker",
        purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
      }),
    })).rejects.toThrow("exact governed background worker scope");
    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "background-operations-worker",
        projectId: thread.projectId,
        correlationId: "wrong-causation",
        causationId: "another-episode",
        purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
      }),
    })).rejects.toThrow("exact governed background worker scope");
    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "background-operations-worker",
        projectId: thread.projectId,
        correlationId: "unexpected-grant",
        causationId: fixture.episode.id,
        contextGrantIds: ["grant-not-needed"],
        purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
      }),
    })).rejects.toThrow("exact governed background worker scope");
    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "background-operations-worker",
        correlationId: "missing-project",
        purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
      }),
    })).rejects.toThrow("exact governed background worker scope");
  });

  it("reselects the parent FOR UPDATE and appends metadata in the supplied SQL transaction", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    const insertedRow = enrichmentRow(
      contract,
      fixture.episode,
      "2026-09-11T05:30:00.000Z",
    );
    const calls: string[] = [];
    const sql = fakeSql((text) => {
      calls.push(text);
      if (text.includes("FROM omni_conversation_summaries summary")) {
        return [summaryRow(fixture.episode)];
      }
      if (text.includes("FROM omni_thread_turns turn")) {
        return fixture.turns.map(turnRow).reverse();
      }
      if (text.includes("INSERT INTO omni_conversation_summary_enrichments")) {
        return [insertedRow];
      }
      if (text.includes("FROM omni_conversation_summary_enrichments")) {
        return [insertedRow];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const saved = await saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
      sql: sql as never,
    });
    expect(saved.contract).toEqual(contract);
    expect(calls[0]).toContain("FOR UPDATE OF summary");
    expect(calls[1]).toContain("FROM omni_thread_turns turn");
    expect(calls[2]).toContain(
      "INSERT INTO omni_conversation_summary_enrichments",
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SEMANTIC_SUMMARY_ENRICHED_EVENT_TYPE,
      }),
      { sql },
    );
    expect(await getCurrentSemanticEnrichment({
      tenantId,
      actorId,
      enrichmentId: contract.enrichmentId,
    }, { sql: sql as never })).toEqual(saved);
  });

  it("returns undefined when a PostgreSQL record no longer matches exact turn evidence", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    const storedRow = enrichmentRow(
      contract,
      fixture.episode,
      "2026-09-11T05:29:00.000Z",
    );
    const changedTurns = fixture.turns.map((turn, index) =>
      index === 1
        ? { ...turn, content: "Apollo moved away from Friday." }
        : turn
    );
    const sql = fakeSql((text) => {
      if (text.includes("FROM omni_conversation_summary_enrichments")) {
        return [storedRow];
      }
      if (text.includes("FROM omni_conversation_summaries summary")) {
        return [summaryRow(fixture.episode)];
      }
      if (text.includes("FROM omni_thread_turns turn")) {
        return changedTurns.map(turnRow);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(getCurrentSemanticEnrichment({
      tenantId,
      actorId,
      enrichmentId: contract.enrichmentId,
    }, { sql: sql as never })).resolves.toBeUndefined();
  });

  it("validates a 500-item PostgreSQL listing with bounded batch reads", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    const storedRow = enrichmentRow(
      contract,
      fixture.episode,
      "2026-09-11T05:29:00.000Z",
    );
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const sql = fakeSql((text, values) => {
      calls.push({ text, values });
      if (text.includes("SELECT enrichment.*")) return [storedRow];
      if (text.includes("FROM omni_conversation_summaries summary")) {
        return [summaryRow(fixture.episode)];
      }
      if (text.includes("FROM omni_thread_turns turn")) {
        return fixture.turns.map(turnRow);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(listCurrentSemanticEnrichments({
      tenantId,
      actorId,
      threadId: thread.id,
      limit: 500,
    }, { sql: sql as never })).resolves.toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[0].values.at(-1)).toBe(500);
  });

  it("resolves a PostgreSQL retry only when the stored contract is identical", async () => {
    const fixture = await seedThreadLedger();
    const contract = enrichmentContract(fixture.episode, fixture.turns);
    const existingRow = enrichmentRow(
      contract,
      fixture.episode,
      "2026-09-11T05:29:00.000Z",
    );
    const sql = fakeSql((text) => {
      if (text.includes("FROM omni_conversation_summaries summary")) {
        return [summaryRow(fixture.episode)];
      }
      if (text.includes("FROM omni_thread_turns turn")) {
        return fixture.turns.map(turnRow);
      }
      if (text.includes("INSERT INTO omni_conversation_summary_enrichments")) {
        return [];
      }
      if (
        text.includes("FROM omni_conversation_summary_enrichments") &&
        text.includes("AND id =")
      ) {
        return [existingRow];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(saveSemanticEnrichmentFromWorker(contract, {
      executionScope: workerScope(),
      sql: sql as never,
    })).resolves.toMatchObject({
      contract,
      createdAt: "2026-09-11T05:29:00.000Z",
    });
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});

const thread: ThreadRecord = {
  id: "thread-semantic-store",
  tenantId,
  actorId,
  projectId: "project-semantic-store",
  title: "Apollo planning",
  mode: "learn",
  createdAt: "2026-09-11T04:00:00.000Z",
  updatedAt: "2026-09-11T04:30:00.000Z",
};

async function seedThreadLedger() {
  const turns = makeTurns();
  const summaries = buildThreadConversationSummaries({
    thread,
    turns,
    now: "2026-09-11T04:31:00.000Z",
  });
  const episode = summaries.find((summary) => summary.level === "episode")!;
  await writeThreadLedger({
    threads: [thread],
    turns,
    summaries: [...summaries],
  });
  return { turns, summaries, episode };
}

function writeThreadLedger(ledger: ThreadLedger) {
  return writeJsonFile(getDataPath("threads.json"), ledger);
}

function makeTurns(targetThread: ThreadRecord = thread): ThreadTurnRecord[] {
  const contents = [
    "Keep Apollo on Friday.",
    "😀 Friday is approved for Apollo.",
    "The budget owner remains unresolved.",
  ];
  return Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index}`,
    tenantId: targetThread.tenantId,
    threadId: targetThread.id,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: contents[index] || `Exact conversation detail ${index}.`,
    createdAt: new Date(Date.UTC(2026, 8, 11, 4, index)).toISOString(),
  }));
}

function enrichmentContract(
  episode: ConversationSummaryRecord,
  turns: readonly ThreadTurnRecord[],
  summaryText = "Apollo remains scheduled for Friday.",
): SemanticEpisodeEnrichmentV1 {
  const generationId = `semantic_summary_generation_${"a".repeat(48)}`;
  const sourceSha256 = semanticEpisodeSourceSha256({ episode, turns });
  const enrichmentId = deriveSemanticEpisodeEnrichmentId({
    generationId,
    sourceSha256,
  });
  const evidence = turnEvidence(turns[1], "Friday is approved for Apollo.");
  const statementBody = {
    kind: "decision" as const,
    text: "Friday is approved as Apollo's schedule.",
    confidenceBasisPoints: 9_600,
    evidence: [evidence],
  };
  const statements = [{
    statementId: deriveSemanticEpisodeStatementId(statementBody),
    ...statementBody,
  }];
  const summary = {
    text: summaryText,
    confidenceBasisPoints: 9_300,
    evidence: [evidence],
  };
  return buildSemanticEpisodeEnrichmentV1({
    enrichmentId,
    generationId,
    tenantId: episode.tenantId,
    ownerActorId: episode.actorId,
    threadId: episode.threadId!,
    projectId: episode.projectId || null,
    episodeSummaryId: episode.id,
    episodeSourceSha256: episode.sourceSha256,
    deterministicSummarySha256: episode.summarySha256,
    bucketIndex: episode.bucketIndex,
    startsAt: episode.startsAt,
    endsAt: episode.endsAt,
    sourceTurnIds: [...episode.sourceTurnIds],
    inputCharacterCount: turns.reduce(
      (total, turn) => total + turn.content.length,
      0,
    ),
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
      assignmentRevision: 7,
      assignmentConfigurationSha256: "b".repeat(64),
      credentialSource: "tenant_vault",
      usageReceiptRecorded: true,
      usageReceiptId: "usage-semantic-store",
    },
  });
}

function turnEvidence(
  turn: ThreadTurnRecord,
  quote: string,
): SemanticEpisodeEvidenceBindingV1 {
  const startOffset = turn.content.indexOf(quote);
  return {
    turnId: turn.id,
    quote,
    quoteSha256: contentSha256Hex(quote),
    coordinateSpace: "turn_content",
    offsetUnit: "utf16_code_unit",
    startOffset,
    endOffsetExclusive: startOffset + quote.length,
  };
}

function workerScope() {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    projectId: thread.projectId,
    correlationId: "semantic-summary-worker",
    causationId: makeEpisode(makeTurns()).id,
    purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
  });
}

function makeEpisode(turns: readonly ThreadTurnRecord[]) {
  return buildThreadConversationSummaries({
    thread,
    turns,
    now: "2026-09-11T04:31:00.000Z",
  }).find((summary) => summary.level === "episode")!;
}

function summaryRow(summary: ConversationSummaryRecord) {
  return {
    id: summary.id,
    tenant_id: summary.tenantId,
    owner_actor_id: summary.actorId,
    level: summary.level,
    bucket_index: summary.bucketIndex,
    thread_id: summary.threadId,
    project_id: summary.projectId || null,
    content: summary.content,
    source_turn_ids: [...summary.sourceTurnIds],
    child_summary_ids: [...summary.childSummaryIds],
    source_sha256: summary.sourceSha256,
    summary_sha256: summary.summarySha256,
    access_scope: summary.accessScope,
    starts_at: summary.startsAt,
    ends_at: summary.endsAt,
    rebuildable: true,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
  };
}

function turnRow(turn: ThreadTurnRecord) {
  return {
    id: turn.id,
    tenant_id: turn.tenantId,
    thread_id: turn.threadId,
    role: turn.role,
    content: turn.content,
    run_id: turn.runId || null,
    created_at: turn.createdAt,
  };
}

function enrichmentRow(
  contract: SemanticEpisodeEnrichmentV1,
  episode: ConversationSummaryRecord,
  createdAt: string,
) {
  return {
    schema_version: 1,
    id: contract.enrichmentId,
    tenant_id: contract.tenantId,
    owner_actor_id: contract.ownerActorId,
    mode: "shadow",
    generation_id: contract.generationId,
    episode_summary_id: contract.episodeSummaryId,
    thread_id: contract.threadId,
    project_id: contract.projectId,
    bucket_index: contract.bucketIndex,
    source_turn_ids: [...contract.sourceTurnIds],
    episode_source_sha256: contract.episodeSourceSha256,
    episode_summary_sha256: episode.summarySha256,
    source_sha256: contract.sourceSha256,
    enrichment_sha256: contract.enrichmentSha256,
    input_character_count: contract.inputCharacterCount,
    starts_at: contract.startsAt,
    ends_at: contract.endsAt,
    model_provider: contract.modelAttribution.provider,
    model_id: contract.modelAttribution.model,
    model_routing_source: contract.modelAttribution.routingSource,
    model_assignment_id: contract.modelAttribution.assignmentId,
    model_assignment_revision: contract.modelAttribution.assignmentRevision,
    model_configuration_sha256:
      contract.modelAttribution.assignmentConfigurationSha256,
    model_credential_source: contract.modelAttribution.credentialSource,
    model_usage_receipt_id: contract.modelAttribution.usageReceiptId,
    contract_sha256: contract.contractSha256,
    contract,
    created_at: createdAt,
  };
}

function fakeSql(
  handler: (text: string, values: readonly unknown[]) => SqlRow[],
) {
  return Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      handler(strings.join("?"), values)
    ),
    { transactionScoped: true },
  );
}

type SqlRow = Record<string, unknown>;
