import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { ChatRole } from "@/lib/orchestration/types";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  readJsonFile,
  updateJsonFile,
  withJsonFileLock,
} from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  parseSemanticEpisodeEnrichmentV1,
  semanticEpisodeSourceSha256,
  SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
  SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT,
  SEMANTIC_EPISODE_MAX_INPUT_CHARACTERS,
  SEMANTIC_EPISODE_MAX_TURN_CHARACTERS,
  type SemanticEpisodeEnrichmentV1,
} from "@/lib/threads/semantic-summaries";
import {
  conversationSummaryAccessScopeV1Schema,
  conversationSummaryRecordSchema,
  type ConversationSummaryRecord,
} from "@/lib/threads/summaries";
import type {
  ThreadLedger,
  ThreadTurnRecord,
} from "@/lib/threads/types";

type SemanticSummarySql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const SEMANTIC_SUMMARY_ENRICHED_EVENT_TYPE =
  "conversation.summary.semantic_enriched" as const;

export type OwnedSemanticEpisodeSource = Readonly<{
  episode: ConversationSummaryRecord;
  turns: readonly ThreadTurnRecord[];
}>;

export type OwnedSemanticSummaryEnrichment = Readonly<{
  record: SemanticSummaryEnrichmentRecord;
  source: OwnedSemanticEpisodeSource;
}>;

export type SemanticSummaryEnrichmentRecord = Readonly<{
  contract: SemanticEpisodeEnrichmentV1;
  episodeSummarySha256: string;
  createdAt: string;
}>;

export type SemanticSummaryShadowStats = Readonly<{
  currentEnrichmentCount: number;
  distinctThreadCount: number;
}>;

type SemanticSummaryEnrichmentLedger = Readonly<{
  schemaVersion: 1;
  records: readonly SemanticSummaryEnrichmentRecord[];
}>;

type SqlOptions = Readonly<{ sql?: SemanticSummarySql }>;

const FILE_ENRICHMENT_RECORD_CAP = 4_096;
const emptyEnrichmentLedger: SemanticSummaryEnrichmentLedger = Object.freeze({
  schemaVersion: 1,
  records: Object.freeze([]),
});
const emptyThreadLedger: ThreadLedger = {
  threads: [],
  turns: [],
  summaries: [],
};

export class SemanticSummaryEnrichmentConflictError extends Error {
  readonly code = "semantic_summary_enrichment_conflict";

  constructor(
    message = "This semantic summary enrichment changed. Refresh and retry.",
  ) {
    super(message);
    this.name = "SemanticSummaryEnrichmentConflictError";
  }
}

export class SemanticSummaryEpisodeNotFoundError extends Error {
  readonly code = "semantic_summary_episode_not_found";

  constructor(message = "The owned conversation episode was not found.") {
    super(message);
    this.name = "SemanticSummaryEpisodeNotFoundError";
  }
}

export class SemanticSummaryStaleSourceError extends Error {
  readonly code = "semantic_summary_stale_source";

  constructor(
    message = "The conversation episode changed before enrichment was committed.",
  ) {
    super(message);
    this.name = "SemanticSummaryStaleSourceError";
  }
}

/** Reads one exact owner episode and restores its canonical source-turn order. */
export async function readOwnedSemanticEpisodeSource(
  input: {
    tenantId: string;
    actorId: string;
    episodeSummaryId: string;
  },
  options: SqlOptions = {},
): Promise<OwnedSemanticEpisodeSource | undefined> {
  const lookup = normalizeEpisodeLookup(input);
  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = (sql: SemanticSummarySql) =>
      readOwnedEpisodeSourceSql(sql, lookup, false);
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      lookup.tenantId,
      [lookup.actorId],
      () => operation(getSql()),
    );
  }
  const ledger = await readJsonFile<ThreadLedger>(
    threadLedgerFile(),
    emptyThreadLedger,
  );
  return readOwnedEpisodeSourceFromLedger(ledger, lookup);
}

/**
 * Reads one immutable enrichment only while its complete episode source is
 * still current. File fallback removes only the exact stale target record.
 */
export async function getCurrentSemanticEnrichment(
  input: {
    tenantId: string;
    actorId: string;
    enrichmentId: string;
  },
  options: SqlOptions = {},
): Promise<SemanticSummaryEnrichmentRecord | undefined> {
  const tenantId = requiredId(input.tenantId, "tenant id");
  const actorId = requiredId(input.actorId, "actor id");
  const enrichmentId = requiredId(input.enrichmentId, "enrichment id");

  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = async (sql: SemanticSummarySql) => {
      const rows = await sql`
        SELECT *
        FROM omni_conversation_summary_enrichments
        WHERE tenant_id = ${tenantId}
          AND id = ${enrichmentId}
          AND owner_actor_id = ${actorId}
        LIMIT 1
      `;
      if (!rows[0]) return undefined;
      const record = recordFromRow(rows[0]);
      const source = await readOwnedEpisodeSourceSql(sql, {
        tenantId,
        actorId,
        episodeSummaryId: record.contract.episodeSummaryId,
      }, false);
      return source && recordMatchesCurrentSource(record, source)
        ? record
        : undefined;
    };
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      tenantId,
      [actorId],
      () => operation(getSql()),
    );
  }

  return withJsonFileLock(threadLedgerFile(), async () => {
    const threadLedger = await readJsonFile<ThreadLedger>(
      threadLedgerFile(),
      emptyThreadLedger,
    );
    let current: SemanticSummaryEnrichmentRecord | undefined;
    await updateJsonFile<SemanticSummaryEnrichmentLedger>(
      enrichmentLedgerFile(),
      emptyEnrichmentLedger,
      (ledger) => {
        const records = ledger.records.map(parseFileRecord);
        const index = records.findIndex((record) =>
          record.contract.tenantId === tenantId &&
          record.contract.ownerActorId === actorId &&
          record.contract.enrichmentId === enrichmentId
        );
        if (index < 0) return ledger;
        const target = records[index];
        if (fileRecordIsCurrent(target, threadLedger)) {
          current = target;
          return ledger;
        }
        return {
          schemaVersion: 1,
          records: records.filter((_, recordIndex) => recordIndex !== index),
        };
      },
    );
    return current;
  });
}

/**
 * Commits a generated shadow contract only from the governed background
 * worker. The current parent and exact turn bodies are revalidated at commit.
 */
export async function saveSemanticEnrichmentFromWorker(
  value: SemanticEpisodeEnrichmentV1,
  options: Readonly<{
    executionScope: ExecutionScope;
    sql?: SemanticSummarySql;
  }>,
): Promise<SemanticSummaryEnrichmentRecord> {
  const contract = parseSemanticEpisodeEnrichmentV1(value);
  const scope = assertWorkerScope(contract, options.executionScope);

  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = (sql: SemanticSummarySql) =>
      saveSemanticEnrichmentSql(sql, contract, scope);
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      contract.tenantId,
      [contract.ownerActorId],
      () => getSql().transaction(operation) as Promise<
        SemanticSummaryEnrichmentRecord
      >,
    );
  }

  let saved!: SemanticSummaryEnrichmentRecord;
  await withJsonFileLock(threadLedgerFile(), async () => {
    const threadLedger = await readJsonFile<ThreadLedger>(
      threadLedgerFile(),
      emptyThreadLedger,
    );
    const source = readOwnedEpisodeSourceFromLedger(threadLedger, {
      tenantId: contract.tenantId,
      actorId: contract.ownerActorId,
      episodeSummaryId: contract.episodeSummaryId,
    });
    if (!source) throw new SemanticSummaryEpisodeNotFoundError();
    assertContractMatchesCurrentSource(contract, source);
    const now = new Date().toISOString();

    await updateJsonFile<SemanticSummaryEnrichmentLedger>(
      enrichmentLedgerFile(),
      emptyEnrichmentLedger,
      (ledger) => {
        const records = ledger.records.map(parseFileRecord);
        const existing = records.find((record) =>
          record.contract.tenantId === contract.tenantId &&
          record.contract.ownerActorId === contract.ownerActorId &&
          record.contract.enrichmentId === contract.enrichmentId
        );
        if (existing) {
          assertSameRecord(existing, contract, source.episode.summarySha256);
          saved = existing;
          return ledger;
        }
        const identityConflict = records.find((record) =>
          record.contract.tenantId === contract.tenantId &&
          record.contract.ownerActorId === contract.ownerActorId &&
          record.contract.generationId === contract.generationId &&
          record.contract.sourceSha256 === contract.sourceSha256
        );
        if (identityConflict) {
          throw new SemanticSummaryEnrichmentConflictError(
            "This generation and episode source already belong to another enrichment.",
          );
        }
        saved = freezeRecord({
          contract,
          episodeSummarySha256: source.episode.summarySha256,
          createdAt: now,
        });
        const next = [...records, saved]
          .sort(compareRecords)
          .slice(-FILE_ENRICHMENT_RECORD_CAP);
        return { schemaVersion: 1, records: next };
      },
    );
  });

  // The deterministic event repairs the narrow file-mode window where the
  // derived ledger committed before its append-only observation.
  await appendSemanticEnrichedEvent(undefined, scope, saved);
  return saved;
}

/** Lists only enrichments whose complete source is still current. */
export async function listCurrentSemanticEnrichments(
  input: {
    tenantId: string;
    actorId: string;
    threadId: string;
    limit?: number;
  },
  options: SqlOptions = {},
): Promise<SemanticSummaryEnrichmentRecord[]> {
  const tenantId = requiredId(input.tenantId, "tenant id");
  const actorId = requiredId(input.actorId, "actor id");
  const threadId = requiredId(input.threadId, "thread id");
  const limit = boundedLimit(input.limit);

  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = async (sql: SemanticSummarySql) => {
      const rows = await sql`
        SELECT enrichment.*
        FROM omni_conversation_summary_enrichments enrichment
        JOIN omni_conversation_summaries summary
          ON summary.id = enrichment.episode_summary_id
        WHERE enrichment.tenant_id = ${tenantId}
          AND enrichment.owner_actor_id = ${actorId}
          AND enrichment.thread_id = ${threadId}
          AND summary.tenant_id = enrichment.tenant_id
          AND summary.owner_actor_id = enrichment.owner_actor_id
          AND summary.thread_id = enrichment.thread_id
          AND summary.level = 'episode'
          AND summary.source_sha256 = enrichment.episode_source_sha256
          AND summary.summary_sha256 = enrichment.episode_summary_sha256
          AND summary.source_turn_ids = enrichment.source_turn_ids
        ORDER BY enrichment.starts_at DESC, enrichment.id COLLATE "C"
        LIMIT ${limit}
      `;
      if (!rows.length) return [];
      const records = rows.map(recordFromRow);
      const episodeIds = records.map(
        (record) => record.contract.episodeSummaryId,
      );
      const summaryRows = await sql`
        SELECT summary.*
        FROM omni_conversation_summaries summary
        JOIN omni_threads thread ON thread.id = summary.thread_id
        WHERE summary.tenant_id = ${tenantId}
          AND summary.owner_actor_id = ${actorId}
          AND summary.thread_id = ${threadId}
          AND summary.id = ANY(${episodeIds})
          AND summary.level = 'episode'
          AND thread.tenant_id = summary.tenant_id
          AND thread.actor_id = summary.owner_actor_id
          AND thread.project_id IS NOT DISTINCT FROM summary.project_id
      `;
      const episodes = new Map(
        summaryRows.map((row) => {
          const episode = conversationSummaryFromRow(row);
          return [episode.id, episode] as const;
        }),
      );
      const sourceTurnIds = [...new Set(
        records.flatMap((record) => record.contract.sourceTurnIds),
      )];
      const turnRows = await sql`
        SELECT turn.*
        FROM omni_thread_turns turn
        JOIN omni_threads thread ON thread.id = turn.thread_id
        WHERE turn.tenant_id = ${tenantId}
          AND turn.thread_id = ${threadId}
          AND turn.id = ANY(${sourceTurnIds})
          AND thread.tenant_id = turn.tenant_id
          AND thread.actor_id = ${actorId}
      `;
      const turnsById = new Map(
        turnRows.map((row) => {
          const turn = turnFromRow(row);
          return [turn.id, turn] as const;
        }),
      );
      const current: SemanticSummaryEnrichmentRecord[] = [];
      for (const record of records) {
        const episode = episodes.get(record.contract.episodeSummaryId);
        if (!episode) continue;
        try {
          const turns = orderedTurns(
            episode,
            record.contract.sourceTurnIds.flatMap((id) => {
              const turn = turnsById.get(id);
              return turn ? [turn] : [];
            }),
          );
          const source = freezeSource({ episode, turns });
          if (recordMatchesCurrentSource(record, source)) current.push(record);
        } catch (error) {
          if (error instanceof SemanticSummaryStaleSourceError) continue;
          throw error;
        }
      }
      return current;
    };
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      tenantId,
      [actorId],
      () => operation(getSql()),
    );
  }

  return withJsonFileLock(threadLedgerFile(), async () => {
    const threadLedger = await readJsonFile<ThreadLedger>(
      threadLedgerFile(),
      emptyThreadLedger,
    );
    let current: SemanticSummaryEnrichmentRecord[] = [];
    await updateJsonFile<SemanticSummaryEnrichmentLedger>(
      enrichmentLedgerFile(),
      emptyEnrichmentLedger,
      (ledger) => {
        const records = ledger.records.map(parseFileRecord);
        const inRequestedScope = (record: SemanticSummaryEnrichmentRecord) =>
          record.contract.tenantId === tenantId &&
          record.contract.ownerActorId === actorId &&
          record.contract.threadId === threadId;
        const retained = records.filter((record) =>
          !inRequestedScope(record) ||
          fileRecordIsCurrent(record, threadLedger)
        );
        current = retained
          .filter(inRequestedScope)
          .sort((left, right) =>
            right.contract.startsAt.localeCompare(left.contract.startsAt) ||
            left.contract.enrichmentId.localeCompare(
              right.contract.enrichmentId,
            )
          )
          .slice(0, limit);
        return retained.length === records.length
          ? ledger
          : { schemaVersion: 1, records: retained };
      },
    );
    return current;
  });
}

/**
 * Lists current enrichment/source pairs across an explicit bounded actor set.
 * This is the private human-review read; callers must never project owner
 * coordinates or use the returned content as agent instructions.
 */
export async function listOwnedSemanticSummaryEnrichments(
  input: {
    tenantId: string;
    actorIds: readonly string[];
    limit?: number;
  },
  options: SqlOptions = {},
): Promise<OwnedSemanticSummaryEnrichment[]> {
  const tenantId = requiredId(input.tenantId, "tenant id");
  const actorIds = [...new Set(input.actorIds.map((actorId) =>
    requiredId(actorId, "actor id")
  ))].sort();
  if (!actorIds.length || actorIds.length > 32) {
    throw new Error(
      "Semantic summary review requires a bounded actor scope.",
    );
  }
  const limit = boundedLimit(input.limit);

  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = async (sql: SemanticSummarySql) => {
      const rows = await sql`
        SELECT enrichment.*
        FROM omni_conversation_summary_enrichments enrichment
        JOIN omni_conversation_summaries summary
          ON summary.id = enrichment.episode_summary_id
         AND summary.tenant_id = enrichment.tenant_id
         AND summary.owner_actor_id = enrichment.owner_actor_id
         AND summary.thread_id = enrichment.thread_id
         AND summary.level = 'episode'
         AND summary.source_sha256 = enrichment.episode_source_sha256
         AND summary.summary_sha256 = enrichment.episode_summary_sha256
         AND summary.source_turn_ids = enrichment.source_turn_ids
        WHERE enrichment.tenant_id = ${tenantId}
          AND enrichment.owner_actor_id = ANY(${actorIds}::text[])
        ORDER BY enrichment.starts_at DESC, enrichment.id COLLATE "C"
        LIMIT ${limit}
      `;
      if (!rows.length) return [];
      const records = rows.map(recordFromRow);
      const episodeIds = records.map(
        (record) => record.contract.episodeSummaryId,
      );
      const summaryRows = await sql`
        SELECT summary.*
        FROM omni_conversation_summaries summary
        JOIN omni_threads thread ON thread.id = summary.thread_id
        WHERE summary.tenant_id = ${tenantId}
          AND summary.owner_actor_id = ANY(${actorIds}::text[])
          AND summary.id = ANY(${episodeIds})
          AND summary.level = 'episode'
          AND thread.tenant_id = summary.tenant_id
          AND thread.actor_id = summary.owner_actor_id
          AND thread.project_id IS NOT DISTINCT FROM summary.project_id
      `;
      const episodes = new Map(
        summaryRows.map((row) => {
          const episode = conversationSummaryFromRow(row);
          return [episode.id, episode] as const;
        }),
      );
      const sourceTurnIds = [...new Set(
        records.flatMap((record) => record.contract.sourceTurnIds),
      )];
      const turnRows = await sql`
        SELECT turn.*
        FROM omni_thread_turns turn
        JOIN omni_threads thread ON thread.id = turn.thread_id
        WHERE turn.tenant_id = ${tenantId}
          AND turn.id = ANY(${sourceTurnIds})
          AND thread.tenant_id = turn.tenant_id
          AND thread.actor_id = ANY(${actorIds}::text[])
      `;
      const turnsById = new Map(
        turnRows.map((row) => {
          const turn = turnFromRow(row);
          return [turn.id, turn] as const;
        }),
      );
      const candidates: OwnedSemanticSummaryEnrichment[] = [];
      for (const record of records) {
        const episode = episodes.get(record.contract.episodeSummaryId);
        if (!episode) continue;
        try {
          const turns = orderedTurns(
            episode,
            record.contract.sourceTurnIds.flatMap((id) => {
              const turn = turnsById.get(id);
              return turn ? [turn] : [];
            }),
          );
          const source = freezeSource({ episode, turns });
          if (recordMatchesCurrentSource(record, source)) {
            candidates.push(Object.freeze({ record, source }));
          }
        } catch (error) {
          if (error instanceof SemanticSummaryStaleSourceError) continue;
          throw error;
        }
      }
      return candidates;
    };
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      tenantId,
      actorIds,
      () => operation(getSql()),
    );
  }

  return withJsonFileLock(threadLedgerFile(), async () => {
    const [threadLedger, enrichmentLedger] = await Promise.all([
      readJsonFile<ThreadLedger>(threadLedgerFile(), emptyThreadLedger),
      readJsonFile<SemanticSummaryEnrichmentLedger>(
        enrichmentLedgerFile(),
        emptyEnrichmentLedger,
      ),
    ]);
    const actorScope = new Set(actorIds);
    return enrichmentLedger.records
      .map(parseFileRecord)
      .filter((record) =>
        record.contract.tenantId === tenantId &&
        actorScope.has(record.contract.ownerActorId)
      )
      .sort((left, right) =>
        right.contract.startsAt.localeCompare(left.contract.startsAt) ||
        left.contract.enrichmentId.localeCompare(right.contract.enrichmentId)
      )
      .flatMap((record) => {
        const source = readOwnedEpisodeSourceFromLedger(threadLedger, {
          tenantId,
          actorId: record.contract.ownerActorId,
          episodeSummaryId: record.contract.episodeSummaryId,
        });
        return source && recordMatchesCurrentSource(record, source)
          ? [Object.freeze({ record, source })]
          : [];
      })
      .slice(0, limit);
  });
}

/** Returns content-free progress for the human-reviewed shadow sample. */
export async function getSemanticSummaryShadowStats(
  input: {
    tenantId: string;
    actorIds: readonly string[];
  },
  options: SqlOptions = {},
): Promise<SemanticSummaryShadowStats> {
  const tenantId = requiredId(input.tenantId, "tenant id");
  const actorIds = [...new Set(input.actorIds.map((actorId) =>
    requiredId(actorId, "actor id")
  ))].sort();
  if (!actorIds.length || actorIds.length > 32) {
    throw new Error("Semantic summary shadow stats require a bounded actor scope.");
  }

  if (options.sql || hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = async (sql: SemanticSummarySql) => {
      const rows = await sql`
        SELECT
          COUNT(*)::INTEGER AS current_enrichment_count,
          COUNT(DISTINCT enrichment.thread_id)::INTEGER AS distinct_thread_count
        FROM omni_conversation_summary_enrichments enrichment
        JOIN omni_conversation_summaries summary
          ON summary.id = enrichment.episode_summary_id
         AND summary.tenant_id = enrichment.tenant_id
         AND summary.owner_actor_id = enrichment.owner_actor_id
         AND summary.thread_id = enrichment.thread_id
         AND summary.level = 'episode'
         AND summary.source_sha256 = enrichment.episode_source_sha256
         AND summary.summary_sha256 = enrichment.episode_summary_sha256
         AND summary.source_turn_ids = enrichment.source_turn_ids
        WHERE enrichment.tenant_id = ${tenantId}
          AND enrichment.owner_actor_id = ANY(${actorIds})
      `;
      return freezeShadowStats(rows[0]);
    };
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      tenantId,
      actorIds,
      () => operation(getSql()),
    );
  }

  return withJsonFileLock(threadLedgerFile(), async () => {
    const [threadLedger, enrichmentLedger] = await Promise.all([
      readJsonFile<ThreadLedger>(threadLedgerFile(), emptyThreadLedger),
      readJsonFile<SemanticSummaryEnrichmentLedger>(
        enrichmentLedgerFile(),
        emptyEnrichmentLedger,
      ),
    ]);
    const actorScope = new Set(actorIds);
    const records = enrichmentLedger.records
      .map(parseFileRecord)
      .filter((record) =>
        record.contract.tenantId === tenantId &&
        actorScope.has(record.contract.ownerActorId) &&
        fileRecordIsCurrent(record, threadLedger)
      );
    return Object.freeze({
      currentEnrichmentCount: records.length,
      distinctThreadCount: new Set(
        records.map((record) => record.contract.threadId),
      ).size,
    });
  });
}

async function saveSemanticEnrichmentSql(
  sql: SemanticSummarySql,
  contract: SemanticEpisodeEnrichmentV1,
  scope: ExecutionScope,
) {
  const source = await readOwnedEpisodeSourceSql(sql, {
    tenantId: contract.tenantId,
    actorId: contract.ownerActorId,
    episodeSummaryId: contract.episodeSummaryId,
  }, true);
  if (!source) throw new SemanticSummaryEpisodeNotFoundError();
  assertContractMatchesCurrentSource(contract, source);
  const now = new Date().toISOString();

  const inserted = await sql`
    INSERT INTO omni_conversation_summary_enrichments (
      schema_version, id, tenant_id, owner_actor_id, mode,
      generation_id, episode_summary_id, thread_id, project_id,
      bucket_index, source_turn_ids, episode_source_sha256,
      episode_summary_sha256, source_sha256, enrichment_sha256,
      input_character_count, starts_at, ends_at,
      model_provider, model_id, model_routing_source,
      model_assignment_id, model_assignment_revision,
      model_configuration_sha256, model_credential_source,
      model_usage_receipt_id, contract_sha256, contract, created_at
    ) VALUES (
      1, ${contract.enrichmentId}, ${contract.tenantId},
      ${contract.ownerActorId}, 'shadow', ${contract.generationId},
      ${contract.episodeSummaryId}, ${contract.threadId},
      ${contract.projectId}, ${contract.bucketIndex},
      ${contract.sourceTurnIds}, ${contract.episodeSourceSha256},
      ${source.episode.summarySha256}, ${contract.sourceSha256},
      ${contract.enrichmentSha256}, ${contract.inputCharacterCount},
      ${contract.startsAt}, ${contract.endsAt},
      ${contract.modelAttribution.provider},
      ${contract.modelAttribution.model},
      ${contract.modelAttribution.routingSource},
      ${contract.modelAttribution.assignmentId || null},
      ${contract.modelAttribution.assignmentRevision || null},
      ${contract.modelAttribution.assignmentConfigurationSha256 || null},
      ${contract.modelAttribution.credentialSource || null},
      ${contract.modelAttribution.usageReceiptId},
      ${contract.contractSha256}, ${contract}::jsonb, ${now}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  const created = Boolean(inserted[0]);
  let record = inserted[0] ? recordFromRow(inserted[0]) : undefined;
  if (!record) {
    const existing = await sql`
      SELECT *
      FROM omni_conversation_summary_enrichments
      WHERE tenant_id = ${contract.tenantId}
        AND owner_actor_id = ${contract.ownerActorId}
        AND id = ${contract.enrichmentId}
      LIMIT 1
    `;
    if (existing[0]) {
      record = recordFromRow(existing[0]);
      assertSameRecord(record, contract, source.episode.summarySha256);
    } else {
      const identityConflict = await sql`
        SELECT id, contract_sha256
        FROM omni_conversation_summary_enrichments
        WHERE tenant_id = ${contract.tenantId}
          AND owner_actor_id = ${contract.ownerActorId}
          AND generation_id = ${contract.generationId}
          AND source_sha256 = ${contract.sourceSha256}
        LIMIT 1
      `;
      if (identityConflict[0]) {
        throw new SemanticSummaryEnrichmentConflictError(
          "This generation and episode source already belong to another enrichment.",
        );
      }
      throw new SemanticSummaryEnrichmentConflictError(
        "The semantic summary enrichment could not be persisted.",
      );
    }
  }
  assertContractMatchesCurrentSource(record.contract, source);
  if (created) await appendSemanticEnrichedEvent(sql, scope, record);
  return record;
}

async function readOwnedEpisodeSourceSql(
  sql: SemanticSummarySql,
  lookup: {
    tenantId: string;
    actorId: string;
    episodeSummaryId: string;
  },
  forUpdate: boolean,
): Promise<OwnedSemanticEpisodeSource | undefined> {
  const rows = forUpdate
    ? await sql`
        SELECT summary.*
        FROM omni_conversation_summaries summary
        JOIN omni_threads thread ON thread.id = summary.thread_id
        WHERE summary.id = ${lookup.episodeSummaryId}
          AND summary.tenant_id = ${lookup.tenantId}
          AND summary.owner_actor_id = ${lookup.actorId}
          AND summary.level = 'episode'
          AND thread.tenant_id = summary.tenant_id
          AND thread.actor_id = summary.owner_actor_id
          AND thread.project_id IS NOT DISTINCT FROM summary.project_id
        LIMIT 1
        FOR UPDATE OF summary
      `
    : await sql`
        SELECT summary.*
        FROM omni_conversation_summaries summary
        JOIN omni_threads thread ON thread.id = summary.thread_id
        WHERE summary.id = ${lookup.episodeSummaryId}
          AND summary.tenant_id = ${lookup.tenantId}
          AND summary.owner_actor_id = ${lookup.actorId}
          AND summary.level = 'episode'
          AND thread.tenant_id = summary.tenant_id
          AND thread.actor_id = summary.owner_actor_id
          AND thread.project_id IS NOT DISTINCT FROM summary.project_id
        LIMIT 1
      `;
  if (!rows[0]) return undefined;
  const episode = conversationSummaryFromRow(rows[0]);
  const turnRows = await sql`
    SELECT turn.*
    FROM omni_thread_turns turn
    JOIN omni_threads thread ON thread.id = turn.thread_id
    WHERE turn.tenant_id = ${lookup.tenantId}
      AND turn.thread_id = ${episode.threadId!}
      AND turn.id = ANY(${episode.sourceTurnIds})
      AND thread.tenant_id = turn.tenant_id
      AND thread.actor_id = ${lookup.actorId}
      AND thread.project_id IS NOT DISTINCT FROM ${episode.projectId || null}
  `;
  const turns = orderedTurns(episode, turnRows.map(turnFromRow));
  return freezeSource({ episode, turns });
}

function readOwnedEpisodeSourceFromLedger(
  ledger: ThreadLedger,
  lookup: {
    tenantId: string;
    actorId: string;
    episodeSummaryId: string;
  },
): OwnedSemanticEpisodeSource | undefined {
  const rawEpisode = (ledger.summaries || []).find((candidate) =>
    candidate.id === lookup.episodeSummaryId &&
    candidate.tenantId === lookup.tenantId &&
    candidate.actorId === lookup.actorId &&
    candidate.level === "episode"
  );
  const thread = rawEpisode
    ? ledger.threads.find((candidate) =>
        candidate.id === rawEpisode.threadId &&
        candidate.tenantId === lookup.tenantId &&
        candidate.actorId === lookup.actorId
      )
    : undefined;
  if (!rawEpisode || !thread || thread.id !== rawEpisode.threadId) {
    return undefined;
  }
  const episode = conversationSummaryRecordSchema.parse(rawEpisode);
  if ((thread.projectId || null) !== (episode.projectId || null)) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode no longer belongs to its exact thread scope.",
    );
  }
  const turns = orderedTurns(
    episode,
    ledger.turns.filter((turn) =>
      turn.tenantId === lookup.tenantId &&
      turn.threadId === episode.threadId &&
      episode.sourceTurnIds.includes(turn.id)
    ),
  );
  return freezeSource({ episode, turns });
}

function orderedTurns(
  episode: ConversationSummaryRecord,
  candidates: readonly ThreadTurnRecord[],
) {
  if (
    episode.level !== "episode" ||
    episode.rebuildable !== true ||
    !episode.threadId ||
    episode.sourceTurnIds.length !== SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT ||
    episode.childSummaryIds.length !== SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT ||
    new Set(episode.sourceTurnIds).size !== episode.sourceTurnIds.length
  ) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode is not a sealed source episode.",
    );
  }
  const byId = new Map<string, ThreadTurnRecord>();
  for (const rawTurn of candidates) {
    const turn = parseTurn(rawTurn);
    if (
      turn.tenantId !== episode.tenantId ||
      turn.threadId !== episode.threadId ||
      byId.has(turn.id)
    ) {
      throw new SemanticSummaryStaleSourceError(
        "The conversation episode turn scope is inconsistent.",
      );
    }
    byId.set(turn.id, turn);
  }
  const turns = episode.sourceTurnIds.map((id) => byId.get(id));
  if (turns.some((turn) => !turn)) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode no longer has all ordered source turns.",
    );
  }
  const ordered = turns as ThreadTurnRecord[];
  if (
    ordered[0].createdAt !== episode.startsAt ||
    ordered.at(-1)?.createdAt !== episode.endsAt ||
    ordered.some((turn, index) =>
      index > 0 && ordered[index - 1].createdAt.localeCompare(turn.createdAt) > 0
    ) ||
    ordered.some((turn) =>
      turn.content.length > SEMANTIC_EPISODE_MAX_TURN_CHARACTERS
    )
  ) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode ordered source boundaries are inconsistent.",
    );
  }
  const characterCount = ordered.reduce(
    (total, turn) => total + turn.content.length,
    0,
  );
  if (
    characterCount < 1 ||
    characterCount > SEMANTIC_EPISODE_MAX_INPUT_CHARACTERS
  ) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode is outside the enrichment input budget.",
    );
  }
  return Object.freeze(ordered.map((turn) => Object.freeze({ ...turn })));
}

function assertContractMatchesCurrentSource(
  contract: SemanticEpisodeEnrichmentV1,
  source: OwnedSemanticEpisodeSource,
) {
  const episode = source.episode;
  const sourceSha256 = semanticEpisodeSourceSha256({
    episode,
    turns: source.turns,
  });
  const inputCharacterCount = source.turns.reduce(
    (total, turn) => total + turn.content.length,
    0,
  );
  if (
    contract.tenantId !== episode.tenantId ||
    contract.ownerActorId !== episode.actorId ||
    contract.threadId !== episode.threadId ||
    contract.projectId !== (episode.projectId || null) ||
    contract.episodeSummaryId !== episode.id ||
    contract.episodeSourceSha256 !== episode.sourceSha256 ||
    contract.deterministicSummarySha256 !== episode.summarySha256 ||
    contract.bucketIndex !== episode.bucketIndex ||
    contract.startsAt !== episode.startsAt ||
    contract.endsAt !== episode.endsAt ||
    contract.inputCharacterCount !== inputCharacterCount ||
    contract.sourceSha256 !== sourceSha256 ||
    contract.sourceTurnIds.some((id, index) =>
      id !== episode.sourceTurnIds[index]
    )
  ) {
    throw new SemanticSummaryStaleSourceError();
  }

  const turnsById = new Map(source.turns.map((turn) => [turn.id, turn]));
  for (const candidate of [contract.summary, ...contract.statements]) {
    for (const evidence of candidate.evidence) {
      const turn = turnsById.get(evidence.turnId);
      const firstOffset = turn?.content.indexOf(evidence.quote) ?? -1;
      const repeatedOffset = firstOffset < 0
        ? -1
        : turn!.content.indexOf(evidence.quote, firstOffset + 1);
      if (
        !turn ||
        firstOffset !== evidence.startOffset ||
        repeatedOffset >= 0 ||
        evidence.endOffsetExclusive !==
          evidence.startOffset + evidence.quote.length ||
        turn.content.slice(
          evidence.startOffset,
          evidence.endOffsetExclusive,
        ) !== evidence.quote ||
        !isUtf16Boundary(turn.content, evidence.startOffset) ||
        !isUtf16Boundary(turn.content, evidence.endOffsetExclusive)
      ) {
        throw new SemanticSummaryStaleSourceError(
          "Semantic summary evidence no longer matches the exact source turn.",
        );
      }
    }
  }
}

function recordMatchesCurrentSource(
  record: SemanticSummaryEnrichmentRecord,
  source: OwnedSemanticEpisodeSource,
) {
  if (record.episodeSummarySha256 !== source.episode.summarySha256) {
    return false;
  }
  try {
    assertContractMatchesCurrentSource(record.contract, source);
    return true;
  } catch (error) {
    if (error instanceof SemanticSummaryStaleSourceError) return false;
    throw error;
  }
}

function fileRecordIsCurrent(
  record: SemanticSummaryEnrichmentRecord,
  ledger: ThreadLedger,
) {
  try {
    const source = readOwnedEpisodeSourceFromLedger(ledger, {
      tenantId: record.contract.tenantId,
      actorId: record.contract.ownerActorId,
      episodeSummaryId: record.contract.episodeSummaryId,
    });
    return Boolean(source && recordMatchesCurrentSource(record, source));
  } catch (error) {
    if (error instanceof SemanticSummaryStaleSourceError) return false;
    throw error;
  }
}

function recordFromRow(row: SqlRow): SemanticSummaryEnrichmentRecord {
  const contract = parseSemanticEpisodeEnrichmentV1(jsonValue(row.contract));
  const record = freezeRecord({
    contract,
    episodeSummarySha256: requiredSha256(
      row.episode_summary_sha256,
      "episode summary digest",
    ),
    createdAt: requiredTimestamp(row.created_at, "created at"),
  });
  const sourceTurnIds = stringArray(row.source_turn_ids);
  if (
    Number(row.schema_version) !== 1 ||
    String(row.id) !== contract.enrichmentId ||
    String(row.tenant_id) !== contract.tenantId ||
    String(row.owner_actor_id) !== contract.ownerActorId ||
    String(row.mode) !== "shadow" ||
    String(row.generation_id) !== contract.generationId ||
    String(row.episode_summary_id) !== contract.episodeSummaryId ||
    String(row.thread_id) !== contract.threadId ||
    nullableString(row.project_id) !== contract.projectId ||
    Number(row.bucket_index) !== contract.bucketIndex ||
    sourceTurnIds.some((id, index) => id !== contract.sourceTurnIds[index]) ||
    sourceTurnIds.length !== contract.sourceTurnIds.length ||
    String(row.episode_source_sha256) !== contract.episodeSourceSha256 ||
    record.episodeSummarySha256 !== contract.deterministicSummarySha256 ||
    String(row.source_sha256) !== contract.sourceSha256 ||
    String(row.enrichment_sha256) !== contract.enrichmentSha256 ||
    Number(row.input_character_count) !== contract.inputCharacterCount ||
    requiredTimestamp(row.starts_at, "starts at") !== contract.startsAt ||
    requiredTimestamp(row.ends_at, "ends at") !== contract.endsAt ||
    String(row.model_provider) !== contract.modelAttribution.provider ||
    String(row.model_id) !== contract.modelAttribution.model ||
    String(row.model_routing_source) !==
      contract.modelAttribution.routingSource ||
    nullableString(row.model_assignment_id) !==
      (contract.modelAttribution.assignmentId || null) ||
    nullablePositiveInteger(row.model_assignment_revision) !==
      (contract.modelAttribution.assignmentRevision || null) ||
    nullableString(row.model_configuration_sha256) !==
      (contract.modelAttribution.assignmentConfigurationSha256 || null) ||
    nullableString(row.model_credential_source) !==
      (contract.modelAttribution.credentialSource || null) ||
    String(row.model_usage_receipt_id) !==
      contract.modelAttribution.usageReceiptId ||
    String(row.contract_sha256) !== contract.contractSha256
  ) {
    throw new SemanticSummaryEnrichmentConflictError(
      "Stored semantic enrichment metadata does not match its immutable contract.",
    );
  }
  return record;
}

function parseFileRecord(
  value: SemanticSummaryEnrichmentRecord,
): SemanticSummaryEnrichmentRecord {
  return freezeRecord({
    contract: parseSemanticEpisodeEnrichmentV1(value.contract),
    episodeSummarySha256: requiredSha256(
      value.episodeSummarySha256,
      "episode summary digest",
    ),
    createdAt: requiredTimestamp(value.createdAt, "created at"),
  });
}

function freezeRecord(
  value: SemanticSummaryEnrichmentRecord,
): SemanticSummaryEnrichmentRecord {
  return Object.freeze({ ...value });
}

function freezeSource(value: {
  episode: ConversationSummaryRecord;
  turns: readonly ThreadTurnRecord[];
}): OwnedSemanticEpisodeSource {
  return Object.freeze({
    episode: Object.freeze(value.episode),
    turns: Object.freeze([...value.turns]),
  });
}

function assertSameRecord(
  existing: SemanticSummaryEnrichmentRecord,
  requested: SemanticEpisodeEnrichmentV1,
  episodeSummarySha256: string,
) {
  if (
    existing.episodeSummarySha256 !== episodeSummarySha256 ||
    existing.contract.contractSha256 !== requested.contractSha256 ||
    sourceContractSha256(existing.contract) !==
      sourceContractSha256(requested)
  ) {
    throw new SemanticSummaryEnrichmentConflictError(
      "The enrichment id already belongs to a different immutable contract.",
    );
  }
}

async function appendSemanticEnrichedEvent(
  sql: SemanticSummarySql | undefined,
  executionScope: ExecutionScope,
  record: SemanticSummaryEnrichmentRecord,
) {
  const payload = {
    schemaVersion: 1,
    enrichmentId: record.contract.enrichmentId,
    generationId: record.contract.generationId,
    episodeSummaryId: record.contract.episodeSummaryId,
    episodeSourceSha256: record.contract.episodeSourceSha256,
    episodeSummarySha256: record.episodeSummarySha256,
    sourceSha256: record.contract.sourceSha256,
    enrichmentSha256: record.contract.enrichmentSha256,
    contractSha256: record.contract.contractSha256,
    sourceTurnCount: record.contract.sourceTurnIds.length,
    statementCount: record.contract.statements.length,
    shadowOnly: true,
    createdAt: record.createdAt,
  };
  await appendScopedDomainEvent({
    id: `conversation-summary-semantic-enriched:${sourceContractSha256({
      tenantId: record.contract.tenantId,
      ownerActorId: record.contract.ownerActorId,
      payload,
    })}`,
    streamId: `conversation-summary:${record.contract.episodeSummaryId}`,
    type: SEMANTIC_SUMMARY_ENRICHED_EVENT_TYPE,
    executionScope,
    payload,
  }, sql ? { sql } : {});
}

function assertWorkerScope(
  contract: SemanticEpisodeEnrichmentV1,
  value: ExecutionScope,
) {
  const scope = parsePersistedExecutionScope(value);
  if (
    !scope ||
    scope.tenantId !== contract.tenantId ||
    scope.initiatingActorId !== contract.ownerActorId ||
    scope.executingPrincipalType !== "system" ||
    scope.executingPrincipalId !== "background-operations-worker" ||
    scope.workspaceId !== null ||
    scope.projectId !== contract.projectId ||
    scope.missionId !== null ||
    scope.delegationId !== null ||
    scope.causationId !== contract.episodeSummaryId ||
    scope.contextGrantIds.length !== 0 ||
    scope.capabilityGrantIds.length !== 0 ||
    scope.purpose !== SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID
  ) {
    throw new Error(
      "Semantic enrichment persistence requires its exact governed background worker scope.",
    );
  }
  return scope;
}

function conversationSummaryFromRow(row: SqlRow) {
  return conversationSummaryRecordSchema.parse({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.owner_actor_id),
    level: String(row.level),
    bucketIndex: Number(row.bucket_index),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    content: String(row.content),
    sourceTurnIds: stringArray(row.source_turn_ids),
    childSummaryIds: stringArray(row.child_summary_ids),
    sourceSha256: String(row.source_sha256),
    summarySha256: String(row.summary_sha256),
    accessScope: conversationSummaryAccessScopeV1Schema.parse(
      jsonValue(row.access_scope),
    ),
    startsAt: requiredTimestamp(row.starts_at, "episode starts at"),
    endsAt: requiredTimestamp(row.ends_at, "episode ends at"),
    rebuildable: row.rebuildable === true,
    createdAt: requiredTimestamp(row.created_at, "episode created at"),
    updatedAt: requiredTimestamp(row.updated_at, "episode updated at"),
  });
}

function turnFromRow(row: SqlRow): ThreadTurnRecord {
  return parseTurn({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    threadId: String(row.thread_id),
    role: String(row.role) as ChatRole,
    content: String(row.content),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    createdAt: requiredTimestamp(row.created_at, "turn created at"),
  });
}

function parseTurn(value: ThreadTurnRecord): ThreadTurnRecord {
  if (
    !value ||
    requiredId(value.id, "turn id") !== value.id ||
    requiredId(value.tenantId, "turn tenant id") !== value.tenantId ||
    requiredId(value.threadId, "turn thread id") !== value.threadId ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.content !== "string" ||
    value.content.length > SEMANTIC_EPISODE_MAX_TURN_CHARACTERS ||
    (value.runId !== undefined && requiredId(value.runId, "turn run id") !==
      value.runId)
  ) {
    throw new SemanticSummaryStaleSourceError(
      "The conversation episode contains an invalid source turn.",
    );
  }
  return {
    id: value.id,
    tenantId: value.tenantId,
    threadId: value.threadId,
    role: value.role,
    content: value.content,
    ...(value.runId ? { runId: value.runId } : {}),
    createdAt: requiredTimestamp(value.createdAt, "turn created at"),
  };
}

function normalizeEpisodeLookup(input: {
  tenantId: string;
  actorId: string;
  episodeSummaryId: string;
}) {
  return {
    tenantId: requiredId(input.tenantId, "tenant id"),
    actorId: requiredId(input.actorId, "actor id"),
    episodeSummaryId: requiredId(
      input.episodeSummaryId,
      "episode summary id",
    ),
  };
}

function requiredId(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 320 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  ) {
    throw new Error(`Semantic summary ${label} is invalid.`);
  }
  return value;
}

function requiredSha256(value: unknown, label: string) {
  const parsed = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new SemanticSummaryEnrichmentConflictError(
      `Stored semantic summary ${label} is invalid.`,
    );
  }
  return parsed;
}

function requiredTimestamp(value: unknown, label: string) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new SemanticSummaryEnrichmentConflictError(
      `Semantic summary ${label} is invalid.`,
    );
  }
  return date.toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SemanticSummaryEnrichmentConflictError(
      "Stored semantic summary assignment revision is invalid.",
    );
  }
  return parsed;
}

function freezeShadowStats(row: SqlRow | undefined): SemanticSummaryShadowStats {
  const currentEnrichmentCount = Number(row?.current_enrichment_count || 0);
  const distinctThreadCount = Number(row?.distinct_thread_count || 0);
  if (
    !Number.isSafeInteger(currentEnrichmentCount) ||
    currentEnrichmentCount < 0 ||
    !Number.isSafeInteger(distinctThreadCount) ||
    distinctThreadCount < 0 ||
    distinctThreadCount > currentEnrichmentCount
  ) {
    throw new SemanticSummaryEnrichmentConflictError(
      "Stored semantic summary shadow statistics are invalid.",
    );
  }
  return Object.freeze({ currentEnrichmentCount, distinctThreadCount });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SemanticSummaryEnrichmentConflictError(
      "Stored semantic summary JSON is invalid.",
    );
  }
}

function boundedLimit(value: number | undefined) {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error("Semantic summary list limit is invalid.");
  }
  return Math.min(Math.max(Math.round(value || 100), 1), 500);
}

function compareRecords(
  left: SemanticSummaryEnrichmentRecord,
  right: SemanticSummaryEnrichmentRecord,
) {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.contract.enrichmentId.localeCompare(right.contract.enrichmentId);
}

function isUtf16Boundary(value: string, offset: number) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

function threadLedgerFile() {
  return getDataPath("threads.json");
}

function enrichmentLedgerFile() {
  return getDataPath("conversation-summary-enrichments.json");
}
