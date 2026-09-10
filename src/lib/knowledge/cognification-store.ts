import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  parseCognificationCandidateBatchV1,
  type CognificationCandidateBatchV1,
} from "@/lib/knowledge/cognification-contract";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type CognificationSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const KNOWLEDGE_COGNITION_EVENT_TYPES = Object.freeze({
  proposed: "knowledge.cognition.proposed",
  reviewed: "knowledge.cognition.reviewed",
  projected: "knowledge.cognition.projected",
} as const);

export const KNOWLEDGE_COGNITION_STATUSES = [
  "pending_review",
  "confirmed",
  "dismissed",
] as const;

export type KnowledgeCognitionStatus =
  (typeof KNOWLEDGE_COGNITION_STATUSES)[number];
export type KnowledgeCognitionReviewDecision = "confirm" | "dismiss";
export type KnowledgeCognitionReviewMetadata = Readonly<
  Record<string, string | number | boolean | null>
>;

export type KnowledgeCognitionRecord = Readonly<{
  candidate: CognificationCandidateBatchV1;
  status: KnowledgeCognitionStatus;
  reviewedByActorId: string | null;
  reviewDecision: KnowledgeCognitionReviewDecision | null;
  reviewMetadata: KnowledgeCognitionReviewMetadata;
  reviewedAt: string | null;
  projectedMemoryId: string | null;
  projectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type KnowledgeCognitionLedger = Readonly<{
  schemaVersion: 1;
  records: readonly KnowledgeCognitionRecord[];
}>;

type StoreOptions = Readonly<{
  executionScope?: ExecutionScope;
  sql?: CognificationSql;
}>;

const emptyLedger: KnowledgeCognitionLedger = Object.freeze({
  schemaVersion: 1,
  records: Object.freeze([]),
});

export class KnowledgeCognitionConflictError extends Error {
  readonly code = "knowledge_cognition_conflict";

  constructor(message = "This knowledge cognition changed. Refresh and try again.") {
    super(message);
    this.name = "KnowledgeCognitionConflictError";
  }
}

export class KnowledgeCognitionNotFoundError extends Error {
  readonly code = "knowledge_cognition_not_found";

  constructor(message = "Knowledge cognition candidate was not found.") {
    super(message);
    this.name = "KnowledgeCognitionNotFoundError";
  }
}

export async function saveKnowledgeCognition(
  value: CognificationCandidateBatchV1,
  options: StoreOptions = {},
): Promise<KnowledgeCognitionRecord> {
  const candidate = parseCognificationCandidateBatchV1(value);
  const scope = options.executionScope
    ? assertExactOwnerScope(candidate, options.executionScope, Boolean(options.sql))
    : undefined;
  const now = new Date().toISOString();

  if (hasDatabaseUrl() || options.sql) {
    if (!options.sql) await ensureDatabaseSchema();
    const operation = async (sql: CognificationSql) => {
      const inserted = await sql`
        INSERT INTO omni_knowledge_cognition_candidates (
          schema_version, id, tenant_id, owner_actor_id, document_id,
          source_item_id, source_revision_id, batch_index, batch_count,
          model_provider, model_id, model_assignment_id,
          model_assignment_revision, model_configuration_sha256,
          model_usage_receipt_id, contract_sha256, contract, status,
          review_metadata, created_at, updated_at
        ) VALUES (
          1, ${candidate.batchId}, ${candidate.tenantId},
          ${candidate.ownerActorId}, ${candidate.documentId},
          ${candidate.sourceItemId}, ${candidate.sourceRevisionId},
          ${candidate.batchIndex}, ${candidate.batchCount},
          ${candidate.modelAttribution.provider},
          ${candidate.modelAttribution.model},
          ${candidate.modelAttribution.assignmentId || null},
          ${candidate.modelAttribution.assignmentRevision || null},
          ${candidate.modelAttribution.assignmentConfigurationSha256 || null},
          ${candidate.modelAttribution.usageReceiptId},
          ${candidate.contractSha256}, ${candidate}::jsonb,
          'pending_review', '{}'::jsonb, ${now}, ${now}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      let created = Boolean(inserted[0]);
      let record = inserted[0] ? recordFromRow(inserted[0]) : undefined;
      if (!record) {
        const existing = await readKnowledgeCognitionRow(
          sql,
          candidate.batchId,
          candidate.tenantId,
          candidate.ownerActorId,
        );
        if (!existing) {
          const digestRows = await sql`
            SELECT *
            FROM omni_knowledge_cognition_candidates
            WHERE tenant_id = ${candidate.tenantId}
              AND owner_actor_id = ${candidate.ownerActorId}
              AND contract_sha256 = ${candidate.contractSha256}
            LIMIT 1
          `;
          if (digestRows[0]) {
            throw new KnowledgeCognitionConflictError(
              "This cognition contract is already bound to another batch.",
            );
          }
          throw new KnowledgeCognitionConflictError(
            "The cognition candidate could not be persisted.",
          );
        }
        assertSameCandidate(existing.candidate, candidate);
        record = existing;
        created = false;
      }
      if (created && scope) {
        await appendCognitionEvent(sql, scope, record, "proposed");
      }
      return record;
    };
    if (options.sql) return operation(options.sql);
    return runWithDatabaseActorScope(
      candidate.tenantId,
      [candidate.ownerActorId],
      () => getSql().transaction(operation) as Promise<KnowledgeCognitionRecord>,
    );
  }

  let saved!: KnowledgeCognitionRecord;
  let created = false;
  await updateJsonFile<KnowledgeCognitionLedger>(
    cognitionFile(),
    emptyLedger,
    (ledger) => {
      const records = ledger.records.map(parseRecord);
      const existing = records.find((record) =>
        record.candidate.tenantId === candidate.tenantId &&
        record.candidate.batchId === candidate.batchId
      );
      if (existing) {
        assertOwner(existing, candidate.tenantId, candidate.ownerActorId);
        assertSameCandidate(existing.candidate, candidate);
        saved = existing;
        return ledger;
      }
      const digestConflict = records.find((record) =>
        record.candidate.tenantId === candidate.tenantId &&
        record.candidate.contractSha256 === candidate.contractSha256
      );
      if (digestConflict) {
        throw new KnowledgeCognitionConflictError(
          "This cognition contract is already bound to another batch.",
        );
      }
      saved = freezeRecord({
        candidate,
        status: "pending_review",
        reviewedByActorId: null,
        reviewDecision: null,
        reviewMetadata: {},
        reviewedAt: null,
        projectedMemoryId: null,
        projectedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      created = true;
      return { schemaVersion: 1, records: [...records, saved] };
    },
  );
  if (created && scope) {
    await appendCognitionEvent(undefined, scope, saved, "proposed");
  }
  return saved;
}

export async function getKnowledgeCognition(
  id: string,
  owner: { tenantId: string; actorId: string },
): Promise<KnowledgeCognitionRecord | undefined> {
  const normalized = normalizeLookup(id, owner);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(
      normalized.tenantId,
      [normalized.actorId],
      () => readKnowledgeCognitionRow(
        getSql(),
        normalized.id,
        normalized.tenantId,
        normalized.actorId,
      ),
    );
  }
  const ledger = await readJsonFile<KnowledgeCognitionLedger>(
    cognitionFile(),
    emptyLedger,
  );
  const record = ledger.records.map(parseRecord).find((candidate) =>
    candidate.candidate.batchId === normalized.id &&
    candidate.candidate.tenantId === normalized.tenantId &&
    candidate.candidate.ownerActorId === normalized.actorId
  );
  return record;
}

export async function listKnowledgeCognitions(input: {
  tenantId: string;
  actorId: string;
  status?: KnowledgeCognitionStatus;
  documentId?: string;
  limit?: number;
}): Promise<KnowledgeCognitionRecord[]> {
  const tenantId = requiredId(input.tenantId, "tenant id");
  const actorId = requiredId(input.actorId, "actor id");
  const status = input.status === undefined
    ? undefined
    : parseStatus(input.status);
  const documentId = input.documentId === undefined
    ? undefined
    : requiredId(input.documentId, "document id");
  const limit = Math.min(Math.max(Math.round(input.limit || 100), 1), 250);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(tenantId, [actorId], async () => {
      const rows = await getSql()`
        SELECT *
        FROM omni_knowledge_cognition_candidates
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${actorId}
          AND (${status || null}::text IS NULL OR status = ${status || null})
          AND (
            ${documentId || null}::text IS NULL
            OR document_id = ${documentId || null}
          )
        ORDER BY created_at DESC, id COLLATE "C"
        LIMIT ${limit}
      `;
      return rows.map(recordFromRow);
    });
  }

  const ledger = await readJsonFile<KnowledgeCognitionLedger>(
    cognitionFile(),
    emptyLedger,
  );
  return ledger.records
    .map(parseRecord)
    .filter((record) =>
      record.candidate.tenantId === tenantId &&
      record.candidate.ownerActorId === actorId &&
      (!status || record.status === status) &&
      (!documentId || record.candidate.documentId === documentId)
    )
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.candidate.batchId.localeCompare(right.candidate.batchId)
    )
    .slice(0, limit);
}

export async function reviewKnowledgeCognition(input: {
  id: string;
  tenantId: string;
  actorId: string;
  decision: KnowledgeCognitionReviewDecision;
  reviewedBy: string;
  reviewMetadata?: KnowledgeCognitionReviewMetadata;
  executionScope: ExecutionScope;
  sql?: CognificationSql;
}): Promise<KnowledgeCognitionRecord> {
  const lookup = normalizeLookup(input.id, input);
  if (requiredId(input.reviewedBy, "reviewer id") !== lookup.actorId) {
    throw new Error("Knowledge cognition review requires the exact owner.");
  }
  const decision = parseDecision(input.decision);
  const targetStatus = decision === "confirm" ? "confirmed" : "dismissed";
  const reviewMetadata = parseReviewMetadata(input.reviewMetadata || {});
  const scope = assertOwnerMutationScope(input, input.executionScope, Boolean(input.sql));
  const now = new Date().toISOString();

  if (hasDatabaseUrl() || input.sql) {
    if (!input.sql) await ensureDatabaseSchema();
    const operation = async (sql: CognificationSql) => {
      const existing = await readKnowledgeCognitionRowForUpdate(
        sql,
        lookup.id,
        lookup.tenantId,
        lookup.actorId,
      );
      if (!existing) throw new KnowledgeCognitionNotFoundError();
      if (existing.status !== "pending_review") {
        assertIdempotentReview(existing, targetStatus, lookup.actorId, reviewMetadata);
        return existing;
      }
      const rows = await sql`
        UPDATE omni_knowledge_cognition_candidates
        SET status = ${targetStatus},
            reviewed_by_actor_id = ${lookup.actorId},
            review_decision = ${decision},
            review_metadata = ${reviewMetadata}::jsonb,
            reviewed_at = ${now},
            updated_at = ${now}
        WHERE tenant_id = ${lookup.tenantId}
          AND owner_actor_id = ${lookup.actorId}
          AND id = ${lookup.id}
          AND status = 'pending_review'
        RETURNING *
      `;
      if (!rows[0]) throw new KnowledgeCognitionConflictError();
      const record = recordFromRow(rows[0]);
      await appendCognitionEvent(sql, scope, record, "reviewed");
      return record;
    };
    if (input.sql) return operation(input.sql);
    return runWithDatabaseActorScope(
      lookup.tenantId,
      [lookup.actorId],
      () => getSql().transaction(operation) as Promise<KnowledgeCognitionRecord>,
    );
  }

  let reviewed!: KnowledgeCognitionRecord;
  let changed = false;
  await updateJsonFile<KnowledgeCognitionLedger>(
    cognitionFile(),
    emptyLedger,
    (ledger) => {
      const records = ledger.records.map(parseRecord);
      const index = records.findIndex((record) =>
        record.candidate.batchId === lookup.id &&
        record.candidate.tenantId === lookup.tenantId &&
        record.candidate.ownerActorId === lookup.actorId
      );
      if (index < 0) throw new KnowledgeCognitionNotFoundError();
      const existing = records[index];
      if (existing.status !== "pending_review") {
        assertIdempotentReview(existing, targetStatus, lookup.actorId, reviewMetadata);
        reviewed = existing;
        return ledger;
      }
      reviewed = freezeRecord({
        ...existing,
        status: targetStatus,
        reviewedByActorId: lookup.actorId,
        reviewDecision: decision,
        reviewMetadata,
        reviewedAt: now,
        updatedAt: now,
      });
      const next = [...records];
      next[index] = reviewed;
      changed = true;
      return { schemaVersion: 1, records: next };
    },
  );
  if (changed) await appendCognitionEvent(undefined, scope, reviewed, "reviewed");
  return reviewed;
}

export async function markKnowledgeCognitionProjected(input: {
  id: string;
  tenantId: string;
  actorId: string;
  projectedMemoryId: string;
  executionScope: ExecutionScope;
  sql?: CognificationSql;
}): Promise<KnowledgeCognitionRecord> {
  const lookup = normalizeLookup(input.id, input);
  const projectedMemoryId = requiredId(
    input.projectedMemoryId,
    "projected memory id",
  );
  const scope = assertOwnerMutationScope(input, input.executionScope, Boolean(input.sql));
  const now = new Date().toISOString();

  if (hasDatabaseUrl() || input.sql) {
    if (!input.sql) await ensureDatabaseSchema();
    const operation = async (sql: CognificationSql) => {
      const existing = await readKnowledgeCognitionRowForUpdate(
        sql,
        lookup.id,
        lookup.tenantId,
        lookup.actorId,
      );
      if (!existing) throw new KnowledgeCognitionNotFoundError();
      if (existing.projectedMemoryId) {
        if (existing.projectedMemoryId !== projectedMemoryId) {
          throw new KnowledgeCognitionConflictError(
            "This cognition is already projected to another memory.",
          );
        }
        return existing;
      }
      if (existing.status !== "confirmed") {
        throw new KnowledgeCognitionConflictError(
          "Only a confirmed cognition can be projected to memory.",
        );
      }
      const rows = await sql`
        UPDATE omni_knowledge_cognition_candidates
        SET projected_memory_id = ${projectedMemoryId},
            projected_at = ${now},
            updated_at = ${now}
        WHERE tenant_id = ${lookup.tenantId}
          AND owner_actor_id = ${lookup.actorId}
          AND id = ${lookup.id}
          AND status = 'confirmed'
          AND projected_memory_id IS NULL
        RETURNING *
      `;
      if (!rows[0]) throw new KnowledgeCognitionConflictError();
      const record = recordFromRow(rows[0]);
      await appendCognitionEvent(sql, scope, record, "projected");
      return record;
    };
    if (input.sql) return operation(input.sql);
    return runWithDatabaseActorScope(
      lookup.tenantId,
      [lookup.actorId],
      () => getSql().transaction(operation) as Promise<KnowledgeCognitionRecord>,
    );
  }

  let projected!: KnowledgeCognitionRecord;
  let changed = false;
  await updateJsonFile<KnowledgeCognitionLedger>(
    cognitionFile(),
    emptyLedger,
    (ledger) => {
      const records = ledger.records.map(parseRecord);
      const index = records.findIndex((record) =>
        record.candidate.batchId === lookup.id &&
        record.candidate.tenantId === lookup.tenantId &&
        record.candidate.ownerActorId === lookup.actorId
      );
      if (index < 0) throw new KnowledgeCognitionNotFoundError();
      const existing = records[index];
      if (existing.projectedMemoryId) {
        if (existing.projectedMemoryId !== projectedMemoryId) {
          throw new KnowledgeCognitionConflictError(
            "This cognition is already projected to another memory.",
          );
        }
        projected = existing;
        return ledger;
      }
      if (existing.status !== "confirmed") {
        throw new KnowledgeCognitionConflictError(
          "Only a confirmed cognition can be projected to memory.",
        );
      }
      projected = freezeRecord({
        ...existing,
        projectedMemoryId,
        projectedAt: now,
        updatedAt: now,
      });
      const next = [...records];
      next[index] = projected;
      changed = true;
      return { schemaVersion: 1, records: next };
    },
  );
  if (changed) await appendCognitionEvent(undefined, scope, projected, "projected");
  return projected;
}

async function readKnowledgeCognitionRow(
  sql: CognificationSql,
  id: string,
  tenantId: string,
  actorId: string,
) {
  const rows = await sql`
    SELECT *
    FROM omni_knowledge_cognition_candidates
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${actorId}
      AND id = ${id}
    LIMIT 1
  `;
  return rows[0] ? recordFromRow(rows[0]) : undefined;
}

async function readKnowledgeCognitionRowForUpdate(
  sql: CognificationSql,
  id: string,
  tenantId: string,
  actorId: string,
) {
  const rows = await sql`
    SELECT *
    FROM omni_knowledge_cognition_candidates
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${actorId}
      AND id = ${id}
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ? recordFromRow(rows[0]) : undefined;
}

async function appendCognitionEvent(
  sql: CognificationSql | undefined,
  executionScope: ExecutionScope,
  record: KnowledgeCognitionRecord,
  transition: "proposed" | "reviewed" | "projected",
) {
  const payload = transition === "proposed"
    ? {
        schemaVersion: 1,
        cognitionId: record.candidate.batchId,
        contractSha256: record.candidate.contractSha256,
        sourceRevisionId: record.candidate.sourceRevisionId,
        batchIndex: record.candidate.batchIndex,
        candidateCount: candidateCount(record.candidate),
        status: record.status,
        createdAt: record.createdAt,
      }
    : transition === "reviewed"
      ? {
          schemaVersion: 1,
          cognitionId: record.candidate.batchId,
          contractSha256: record.candidate.contractSha256,
          decision: record.reviewDecision,
          status: record.status,
          reviewedAt: record.reviewedAt,
        }
      : {
          schemaVersion: 1,
          cognitionId: record.candidate.batchId,
          contractSha256: record.candidate.contractSha256,
          projectedMemoryId: record.projectedMemoryId,
          projectedAt: record.projectedAt,
        };
  const eventId = `knowledge-cognition-${transition}:${sourceContractSha256({
    tenantId: record.candidate.tenantId,
    ownerActorId: record.candidate.ownerActorId,
    payload,
  })}`;
  await appendScopedDomainEvent({
    id: eventId,
    streamId: `knowledge-cognition:${record.candidate.ownerActorId}`,
    type: KNOWLEDGE_COGNITION_EVENT_TYPES[transition],
    executionScope,
    payload,
  }, sql ? { sql } : {});
}

function recordFromRow(row: SqlRow): KnowledgeCognitionRecord {
  const candidate = parseCognificationCandidateBatchV1(jsonValue(row.contract));
  const record = freezeRecord({
    candidate,
    status: parseStatus(row.status),
    reviewedByActorId: nullableString(row.reviewed_by_actor_id),
    reviewDecision: row.review_decision === null || row.review_decision === undefined
      ? null
      : parseDecision(row.review_decision),
    reviewMetadata: parseReviewMetadata(jsonValue(row.review_metadata) || {}),
    reviewedAt: nullableTimestamp(row.reviewed_at),
    projectedMemoryId: nullableString(row.projected_memory_id),
    projectedAt: nullableTimestamp(row.projected_at),
    createdAt: requiredTimestamp(row.created_at, "created at"),
    updatedAt: requiredTimestamp(row.updated_at, "updated at"),
  });
  if (
    String(row.id) !== candidate.batchId ||
    String(row.tenant_id) !== candidate.tenantId ||
    String(row.owner_actor_id) !== candidate.ownerActorId ||
    String(row.document_id) !== candidate.documentId ||
    String(row.source_item_id) !== candidate.sourceItemId ||
    String(row.source_revision_id) !== candidate.sourceRevisionId ||
    Number(row.batch_index) !== candidate.batchIndex ||
    Number(row.batch_count) !== candidate.batchCount ||
    String(row.model_provider) !== candidate.modelAttribution.provider ||
    String(row.model_id) !== candidate.modelAttribution.model ||
    String(row.model_usage_receipt_id) !==
      candidate.modelAttribution.usageReceiptId ||
    nullableString(row.model_assignment_id) !==
      (candidate.modelAttribution.assignmentId || null) ||
    nullablePositiveInteger(row.model_assignment_revision) !==
      (candidate.modelAttribution.assignmentRevision || null) ||
    nullableString(row.model_configuration_sha256) !==
      (candidate.modelAttribution.assignmentConfigurationSha256 || null) ||
    String(row.contract_sha256) !== candidate.contractSha256
  ) {
    throw new KnowledgeCognitionConflictError(
      "Stored cognition identity does not match its immutable contract.",
    );
  }
  return parseRecord(record);
}

function parseRecord(value: KnowledgeCognitionRecord): KnowledgeCognitionRecord {
  const candidate = parseCognificationCandidateBatchV1(value.candidate);
  const record = freezeRecord({
    candidate,
    status: parseStatus(value.status),
    reviewedByActorId: nullableString(value.reviewedByActorId),
    reviewDecision: value.reviewDecision === null
      ? null
      : parseDecision(value.reviewDecision),
    reviewMetadata: parseReviewMetadata(value.reviewMetadata),
    reviewedAt: nullableTimestamp(value.reviewedAt),
    projectedMemoryId: nullableString(value.projectedMemoryId),
    projectedAt: nullableTimestamp(value.projectedAt),
    createdAt: requiredTimestamp(value.createdAt, "created at"),
    updatedAt: requiredTimestamp(value.updatedAt, "updated at"),
  });
  validateRecordState(record);
  return record;
}

function freezeRecord(
  value: Omit<KnowledgeCognitionRecord, "reviewMetadata"> & {
    reviewMetadata: KnowledgeCognitionReviewMetadata;
  },
): KnowledgeCognitionRecord {
  return Object.freeze({
    ...value,
    reviewMetadata: Object.freeze({ ...value.reviewMetadata }),
  });
}

function validateRecordState(record: KnowledgeCognitionRecord) {
  if (record.updatedAt < record.createdAt) {
    throw new KnowledgeCognitionConflictError("Cognition timestamps are invalid.");
  }
  if (record.status === "pending_review") {
    if (
      record.reviewedByActorId || record.reviewDecision || record.reviewedAt ||
      record.projectedMemoryId || record.projectedAt ||
      Object.keys(record.reviewMetadata).length
    ) {
      throw new KnowledgeCognitionConflictError("Pending cognition review state is invalid.");
    }
    return;
  }
  const expectedDecision = record.status === "confirmed" ? "confirm" : "dismiss";
  if (
    record.reviewedByActorId !== record.candidate.ownerActorId ||
    record.reviewDecision !== expectedDecision ||
    !record.reviewedAt || record.reviewedAt < record.createdAt ||
    record.reviewedAt > record.updatedAt
  ) {
    throw new KnowledgeCognitionConflictError("Cognition review state is invalid.");
  }
  if (
    record.status === "dismissed" &&
    (record.projectedMemoryId || record.projectedAt)
  ) {
    throw new KnowledgeCognitionConflictError("Dismissed cognition cannot be projected.");
  }
  if (Boolean(record.projectedMemoryId) !== Boolean(record.projectedAt)) {
    throw new KnowledgeCognitionConflictError("Cognition projection state is incomplete.");
  }
  if (
    record.status === "confirmed" &&
    ((record.projectedAt && record.projectedAt !== record.updatedAt) ||
      (!record.projectedAt && record.reviewedAt !== record.updatedAt))
  ) {
    throw new KnowledgeCognitionConflictError("Cognition transition time is invalid.");
  }
}

function assertSameCandidate(
  existing: CognificationCandidateBatchV1,
  candidate: CognificationCandidateBatchV1,
) {
  if (
    existing.contractSha256 !== candidate.contractSha256 ||
    sourceContractSha256(existing) !== sourceContractSha256(candidate)
  ) {
    throw new KnowledgeCognitionConflictError(
      "Cognition batch id already refers to another immutable contract.",
    );
  }
}

function assertIdempotentReview(
  record: KnowledgeCognitionRecord,
  status: KnowledgeCognitionStatus,
  reviewer: string,
  metadata: KnowledgeCognitionReviewMetadata,
) {
  if (
    record.status !== status ||
    record.reviewedByActorId !== reviewer ||
    sourceContractSha256(record.reviewMetadata) !== sourceContractSha256(metadata)
  ) {
    throw new KnowledgeCognitionConflictError();
  }
}

function assertOwner(
  record: KnowledgeCognitionRecord,
  tenantId: string,
  actorId: string,
) {
  if (
    record.candidate.tenantId !== tenantId ||
    record.candidate.ownerActorId !== actorId
  ) {
    throw new Error("Knowledge cognition crosses its owner scope.");
  }
}

function assertExactOwnerScope(
  candidate: CognificationCandidateBatchV1,
  executionScope: ExecutionScope,
  governedTransaction: boolean,
) {
  return assertOwnerMutationScope(
    {
      tenantId: candidate.tenantId,
      actorId: candidate.ownerActorId,
    },
    executionScope,
    governedTransaction,
  );
}

function assertOwnerMutationScope(
  owner: { tenantId: string; actorId: string },
  executionScope: ExecutionScope,
  governedTransaction: boolean,
) {
  const scope = parsePersistedExecutionScope(executionScope);
  const userOwner =
    scope?.executingPrincipalType === "user" &&
    scope.executingPrincipalId === owner.actorId;
  const governedPrincipal =
    governedTransaction &&
    scope?.executingPrincipalType === "system" &&
    Boolean(scope.executingPrincipalId);
  if (
    !scope ||
    scope.tenantId !== owner.tenantId ||
    scope.initiatingActorId !== owner.actorId ||
    (!userOwner && !governedPrincipal) ||
    scope.workspaceId !== null ||
    scope.projectId !== null ||
    scope.missionId !== null
  ) {
    throw new Error("Knowledge cognition mutation requires an exact owner scope.");
  }
  return scope;
}

function normalizeLookup(
  id: string,
  owner: { tenantId: string; actorId: string },
) {
  return {
    id: requiredId(id, "cognition id"),
    tenantId: requiredId(owner.tenantId, "tenant id"),
    actorId: requiredId(owner.actorId, "actor id"),
  };
}

function requiredId(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !value ||
    value.length > 320 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  ) {
    throw new Error(`Knowledge cognition ${label} is invalid.`);
  }
  return value;
}

function parseStatus(value: unknown): KnowledgeCognitionStatus {
  if (
    value !== "pending_review" &&
    value !== "confirmed" &&
    value !== "dismissed"
  ) {
    throw new Error("Knowledge cognition status is invalid.");
  }
  return value;
}

function parseDecision(value: unknown): KnowledgeCognitionReviewDecision {
  if (value !== "confirm" && value !== "dismiss") {
    throw new Error("Knowledge cognition review decision is invalid.");
  }
  return value;
}

function parseReviewMetadata(value: unknown): KnowledgeCognitionReviewMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Knowledge cognition review metadata must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) {
    throw new Error("Knowledge cognition review metadata is too large.");
  }
  const parsed: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new Error("Knowledge cognition review metadata key is invalid.");
    }
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error("Knowledge cognition review metadata value is invalid.");
    }
    if (
      (typeof item === "string" && item.length > 240) ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new Error("Knowledge cognition review metadata value is invalid.");
    }
    parsed[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 8_192) {
    throw new Error("Knowledge cognition review metadata is too large.");
  }
  return Object.freeze(parsed);
}

function candidateCount(candidate: CognificationCandidateBatchV1) {
  return candidate.topics.length + candidate.claims.length +
    candidate.entities.length + candidate.relations.length + 1;
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new KnowledgeCognitionConflictError("Stored cognition JSON is invalid.");
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new KnowledgeCognitionConflictError(
      "Stored cognition model assignment revision is invalid.",
    );
  }
  return parsed;
}

function requiredTimestamp(value: unknown, label: string) {
  const parsed = nullableTimestamp(value);
  if (!parsed) throw new Error(`Knowledge cognition ${label} is invalid.`);
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Knowledge cognition timestamp is invalid.");
  }
  return date.toISOString();
}

function cognitionFile() {
  return getDataPath("knowledge-cognition-candidates.json");
}
