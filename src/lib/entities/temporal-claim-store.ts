import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  getEntityRelationDefinition,
  type EntityRelationTypeId,
} from "@/lib/entities/ontology";
import {
  parseEntityAccessBinding,
  parseEntityRecord,
  type EntityAccessBinding,
  type EntityRecord,
} from "@/lib/entities/registry";
import { readEntityRegistry } from "@/lib/entities/store";
import {
  parseTemporalRelationClaimRecord,
  parseTemporalRelationClaimRevision,
  relationClaimIsVisibleAt,
  relationEpistemicKindSchema,
  type RelationEpistemicKind,
  type TemporalRelationClaimRecord,
  type TemporalRelationClaimRevision,
} from "@/lib/entities/temporal-claims";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

type TemporalClaimLedger = {
  schemaVersion: 1;
  records: TemporalRelationClaimRecord[];
};

type TemporalClaimSqlClient = ReturnType<typeof getSql>;

const emptyLedger: TemporalClaimLedger = {
  schemaVersion: 1,
  records: [],
};

export type TemporalRelationClaimQuery = Readonly<{
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  entityId?: string;
  relationTypeId?: EntityRelationTypeId;
  epistemicKinds?: readonly RelationEpistemicKind[];
  validAt?: string;
  recordedAt?: string;
  history?: boolean;
  limit?: number;
}>;

export async function saveTemporalRelationClaimRevision(input: {
  claim: TemporalRelationClaimRevision;
  executionScope: ExecutionScope;
}): Promise<TemporalRelationClaimRecord> {
  const claim = parseTemporalRelationClaimRevision(input.claim);
  const scope = assertTemporalClaimScope(
    input.executionScope,
    claim.accessBinding,
    "entity.write.v1",
  );

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(
      scope.tenantId,
      [scope.initiatingActorId],
      () => getSql().transaction(async (sql: TemporalClaimSqlClient) => {
        const existing = await loadRevision(sql, scope.tenantId, claim.revisionId);
        if (existing) {
          assertSameClaimDigest(existing.claim, claim);
          return existing;
        }
        await assertStoredEndpoints(sql, claim);
        const current = await loadCurrentClaim(
          sql,
          scope.tenantId,
          claim.claimId,
          true,
        );
        if (claim.previousRevisionId === null) {
          if (current) {
            throw new Error("Entity relation claim already has a current revision.");
          }
        } else {
          if (!current || current.claim.revisionId !== claim.previousRevisionId) {
            throw new Error("Entity relation claim changed concurrently.");
          }
          assertRevisionIdentity(current.claim, claim);
          if (claim.recordedAt <= current.claim.recordedAt) {
            throw new Error("Entity relation revision must advance system time.");
          }
          const closed = await sql`
            UPDATE omni_entity_relation_claims
            SET superseded_at = ${claim.recordedAt}
            WHERE tenant_id = ${scope.tenantId}
              AND id = ${current.claim.revisionId}
              AND superseded_at IS NULL
            RETURNING id
          `;
          if (!closed[0]) {
            throw new Error("Entity relation claim changed concurrently.");
          }
        }
        await insertRevision(sql, claim);
        const record = parseTemporalRelationClaimRecord({
          claim,
          supersededAt: null,
        });
        await appendRelationEvent(claim, scope, sql);
        return record;
      }) as Promise<TemporalRelationClaimRecord>,
    );
  }

  await assertStoredFileEndpoints(claim, scope);
  let stored: TemporalRelationClaimRecord | undefined;
  let created = false;
  await updateJsonFile<TemporalClaimLedger>(
    getTemporalClaimsFile(),
    emptyLedger,
    (ledger) => {
      const records = ledger.records.map(parseTemporalRelationClaimRecord);
      const existing = records.find((record) =>
        record.claim.revisionId === claim.revisionId
      );
      if (existing) {
        assertSameClaimDigest(existing.claim, claim);
        stored = existing;
        return ledger;
      }
      const current = records.find((record) =>
        record.claim.claimId === claim.claimId && record.supersededAt === null
      );
      if (claim.previousRevisionId === null) {
        if (current) {
          throw new Error("Entity relation claim already has a current revision.");
        }
      } else {
        if (!current || current.claim.revisionId !== claim.previousRevisionId) {
          throw new Error("Entity relation claim changed concurrently.");
        }
        assertRevisionIdentity(current.claim, claim);
        if (claim.recordedAt <= current.claim.recordedAt) {
          throw new Error("Entity relation revision must advance system time.");
        }
      }
      const nextRecords = records.map((record) =>
        record.claim.revisionId === claim.previousRevisionId
          ? parseTemporalRelationClaimRecord({
              claim: record.claim,
              supersededAt: claim.recordedAt,
            })
          : record
      );
      stored = parseTemporalRelationClaimRecord({ claim, supersededAt: null });
      created = true;
      return { schemaVersion: 1, records: [...nextRecords, stored] };
    },
  );
  if (created) await appendRelationEvent(claim, scope);
  return stored!;
}

export async function queryTemporalRelationClaims(
  input: TemporalRelationClaimQuery,
): Promise<readonly TemporalRelationClaimRecord[]> {
  const accessBinding = parseEntityAccessBinding(input.accessBinding);
  const scope = assertTemporalClaimScope(
    input.executionScope,
    accessBinding,
    "entity.read.v1",
  );
  const query = parseQuery(input);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(
      scope.tenantId,
      [scope.initiatingActorId],
      async () => {
        const clauses = [
          "tenant_id = $1",
          "owner_actor_id = $2",
          "access_scope_sha256 = $3",
        ];
        const values: unknown[] = [
          scope.tenantId,
          scope.initiatingActorId,
          accessBinding.accessScopeSha256,
        ];
        const bind = (value: unknown) => {
          values.push(value);
          return `$${values.length}`;
        };
        if (query.entityId) {
          const parameter = bind(query.entityId);
          clauses.push(`(source_entity_id = ${parameter} OR target_entity_id = ${parameter})`);
        }
        if (query.relationTypeId) {
          clauses.push(`relation_type_id = ${bind(query.relationTypeId)}`);
        }
        if (query.epistemicKinds.length) {
          clauses.push(`epistemic_kind = ANY(${bind(query.epistemicKinds)}::TEXT[])`);
        }
        if (query.history) {
          if (query.validAt) {
            const parameter = bind(query.validAt);
            clauses.push(
              `valid_from <= ${parameter}::TIMESTAMPTZ`,
              `(valid_to IS NULL OR valid_to > ${parameter}::TIMESTAMPTZ)`,
            );
          }
        } else {
          const recordedAt = bind(query.recordedAt);
          const validAt = bind(query.validAt!);
          clauses.push(
            `recorded_at <= ${recordedAt}::TIMESTAMPTZ`,
            `(superseded_at IS NULL OR superseded_at > ${recordedAt}::TIMESTAMPTZ)`,
            `valid_from <= ${validAt}::TIMESTAMPTZ`,
            `(valid_to IS NULL OR valid_to > ${validAt}::TIMESTAMPTZ)`,
            "claim_state = 'active'",
          );
        }
        values.push(query.limit);
        const rows = await getSql().query(
          `SELECT contract, superseded_at
           FROM omni_entity_relation_claims
           WHERE ${clauses.join(" AND ")}
           ORDER BY recorded_at DESC, id COLLATE "C"
           LIMIT $${values.length}`,
          values,
        );
        return Object.freeze(rows.map(recordFromRow));
      },
    );
  }

  const ledger = await readJsonFile<TemporalClaimLedger>(
    getTemporalClaimsFile(),
    emptyLedger,
  );
  return Object.freeze(ledger.records
    .map(parseTemporalRelationClaimRecord)
    .filter((record) => {
      const claim = record.claim;
      if (
        claim.accessBinding.tenantId !== scope.tenantId ||
        claim.accessBinding.ownerActorId !== scope.initiatingActorId ||
        claim.accessBinding.accessScopeSha256 !== accessBinding.accessScopeSha256 ||
        (query.entityId &&
          claim.source.entityId !== query.entityId &&
          claim.target.entityId !== query.entityId) ||
        (query.relationTypeId && claim.relationTypeId !== query.relationTypeId) ||
        (query.epistemicKinds.length &&
          !query.epistemicKinds.includes(claim.epistemicKind))
      ) return false;
      if (query.history) {
        return !query.validAt || (
          claim.validFrom <= query.validAt &&
          (claim.validTo === null || claim.validTo > query.validAt)
        );
      }
      return relationClaimIsVisibleAt(record, {
        validAt: query.validAt!,
        recordedAt: query.recordedAt,
      });
    })
    .sort((left, right) =>
      right.claim.recordedAt.localeCompare(left.claim.recordedAt) ||
      left.claim.revisionId.localeCompare(right.claim.revisionId)
    )
    .slice(0, query.limit));
}

function parseQuery(input: TemporalRelationClaimQuery) {
  const history = input.history === true;
  const now = new Date().toISOString();
  const recordedAt = canonicalTimestamp(input.recordedAt || now);
  const validAt = input.validAt
    ? canonicalTimestamp(input.validAt)
    : history
      ? undefined
      : recordedAt;
  const entityId = input.entityId?.trim();
  if (entityId && (entityId.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(entityId))) {
    throw new Error("Entity relation query entity ID is invalid.");
  }
  if (input.relationTypeId) {
    getEntityRelationDefinition("asael-ontology:1", input.relationTypeId);
  }
  const epistemicKinds = [...new Set(
    (input.epistemicKinds || []).map((kind) =>
      relationEpistemicKindSchema.parse(kind)
    ),
  )].sort();
  const limit = Math.min(Math.max(Math.round(input.limit || 50), 1), 200);
  return {
    entityId,
    relationTypeId: input.relationTypeId,
    epistemicKinds,
    validAt,
    recordedAt,
    history,
    limit,
  };
}

async function assertStoredEndpoints(
  sql: TemporalClaimSqlClient,
  claim: TemporalRelationClaimRevision,
) {
  const rows = await sql`
    SELECT contract
    FROM omni_entity_records
    WHERE tenant_id = ${claim.accessBinding.tenantId}
      AND owner_actor_id = ${claim.accessBinding.ownerActorId}
      AND id = ANY(${[claim.source.entityId, claim.target.entityId]}::TEXT[])
      AND access_scope_sha256 = ${claim.accessBinding.accessScopeSha256}
      AND state = 'active'
    ORDER BY id COLLATE "C"
    FOR SHARE
  `;
  assertEndpointRecords(rows.map((row) => parseEntityRecord(row.contract)), claim);
}

async function assertStoredFileEndpoints(
  claim: TemporalRelationClaimRevision,
  scope: ExecutionScope,
) {
  const registry = await readEntityRegistry({
    accessBinding: claim.accessBinding,
    executionScope: deriveExecutionScope(scope, { purpose: "entity.read.v1" }),
  });
  assertEndpointRecords(registry.entities, claim);
}

function assertEndpointRecords(
  entities: readonly EntityRecord[],
  claim: TemporalRelationClaimRevision,
) {
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));
  for (const endpoint of [claim.source, claim.target]) {
    const entity = byId.get(endpoint.entityId);
    if (
      !entity ||
      entity.state !== "active" ||
      entity.entityTypeId !== endpoint.entityTypeId ||
      entity.accessBinding.accessScopeSha256 !==
        claim.accessBinding.accessScopeSha256 ||
      (claim.previousRevisionId === null &&
        entity.entitySha256 !== endpoint.entitySha256)
    ) {
      throw new Error("Entity relation endpoint is not active in the claim scope.");
    }
  }
}

async function insertRevision(
  sql: TemporalClaimSqlClient,
  claim: TemporalRelationClaimRevision,
) {
  const rows = await sql`
    INSERT INTO omni_entity_relation_claims (
      tenant_id, id, claim_id, previous_revision_id, owner_actor_id,
      ontology_version_id, relation_type_id, source_entity_id,
      source_entity_type_id, target_entity_id, target_entity_type_id,
      epistemic_kind, claim_state, confidence_basis_points,
      access_scope_sha256, lineage_memory_ids, lineage_evidence_unit_ids,
      valid_from, valid_to, recorded_at, superseded_at, contract, claim_sha256
    ) VALUES (
      ${claim.accessBinding.tenantId}, ${claim.revisionId}, ${claim.claimId},
      ${claim.previousRevisionId}, ${claim.accessBinding.ownerActorId},
      ${claim.ontologyVersionId}, ${claim.relationTypeId},
      ${claim.source.entityId}, ${claim.source.entityTypeId},
      ${claim.target.entityId}, ${claim.target.entityTypeId},
      ${claim.epistemicKind}, ${claim.claimState},
      ${claim.confidenceBasisPoints}, ${claim.accessBinding.accessScopeSha256},
      ${lineageIds(claim, "memory")}, ${lineageIds(claim, "evidence_unit")},
      ${claim.validFrom}, ${claim.validTo}, ${claim.recordedAt}, NULL,
      ${claim}::jsonb, ${claim.claimSha256}
    )
    RETURNING id
  `;
  if (!rows[0]) throw new Error("Entity relation claim could not be recorded.");
}

async function loadRevision(
  sql: TemporalClaimSqlClient,
  tenantId: string,
  revisionId: string,
) {
  const rows = await sql`
    SELECT contract, superseded_at
    FROM omni_entity_relation_claims
    WHERE tenant_id = ${tenantId} AND id = ${revisionId}
    LIMIT 1
  `;
  return rows[0] ? recordFromRow(rows[0]) : undefined;
}

async function loadCurrentClaim(
  sql: TemporalClaimSqlClient,
  tenantId: string,
  claimId: string,
  forUpdate = false,
) {
  const rows = await sql.query(
    `SELECT contract, superseded_at
     FROM omni_entity_relation_claims
     WHERE tenant_id = $1 AND claim_id = $2 AND superseded_at IS NULL
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, claimId],
  );
  return rows[0] ? recordFromRow(rows[0]) : undefined;
}

function recordFromRow(row: Record<string, unknown>) {
  return parseTemporalRelationClaimRecord({
    claim: row.contract,
    supersededAt: row.superseded_at
      ? new Date(String(row.superseded_at)).toISOString()
      : null,
  });
}

function assertRevisionIdentity(
  current: TemporalRelationClaimRevision,
  next: TemporalRelationClaimRevision,
) {
  if (
    current.claimId !== next.claimId ||
    current.ontologyVersionId !== next.ontologyVersionId ||
    current.relationTypeId !== next.relationTypeId ||
    current.source.entityId !== next.source.entityId ||
    current.source.entityTypeId !== next.source.entityTypeId ||
    current.target.entityId !== next.target.entityId ||
    current.target.entityTypeId !== next.target.entityTypeId ||
    current.accessBinding.accessScopeSha256 !==
      next.accessBinding.accessScopeSha256
  ) {
    throw new Error("Entity relation revision cannot change claim identity.");
  }
}

function assertSameClaimDigest(
  actual: TemporalRelationClaimRevision,
  expected: TemporalRelationClaimRevision,
) {
  if (actual.claimSha256 !== expected.claimSha256) {
    throw new Error("Entity relation revision ID is bound to another contract.");
  }
}

function assertTemporalClaimScope(
  value: ExecutionScope,
  binding: EntityAccessBinding,
  purpose: "entity.read.v1" | "entity.write.v1",
) {
  const scope = parsePersistedExecutionScope(value);
  if (
    !scope?.initiatingActorId ||
    scope.purpose !== purpose ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== scope.initiatingActorId ||
    scope.tenantId !== binding.tenantId ||
    scope.initiatingActorId !== binding.ownerActorId ||
    scope.workspaceId !== binding.workspaceId ||
    scope.projectId !== binding.projectId ||
    scope.missionId !== binding.missionId ||
    binding.ownerAgentId !== null ||
    binding.visibility !== "user_private" ||
    binding.workspaceId !== null ||
    binding.projectId !== null ||
    binding.missionId !== null ||
    !binding.allowedPurposeIds.includes(purpose)
  ) {
    throw new Error("Entity relation scope does not match its access binding.");
  }
  return scope as ExecutionScope & { initiatingActorId: string };
}

function lineageIds(
  claim: TemporalRelationClaimRevision,
  kind: "memory" | "evidence_unit",
) {
  return [...new Set(claim.lineage
    .filter((reference) => reference.kind === kind)
    .map((reference) => reference.referenceId))]
    .sort((left, right) => left.localeCompare(right));
}

function appendRelationEvent(
  claim: TemporalRelationClaimRevision,
  executionScope: ExecutionScope,
  sql?: TemporalClaimSqlClient,
) {
  return appendScopedDomainEvent({
    id: `entity-relation-claim:${claim.claimSha256}`,
    streamId: `entity-relation:${claim.claimId}`,
    type: claim.previousRevisionId
      ? "entity.relation_claim.revised"
      : "entity.relation_claim.recorded",
    executionScope,
    payload: {
      schemaVersion: 1,
      claimId: claim.claimId,
      revisionId: claim.revisionId,
      previousRevisionId: claim.previousRevisionId,
      relationTypeId: claim.relationTypeId,
      epistemicKind: claim.epistemicKind,
      claimState: claim.claimState,
      sourceEntityId: claim.source.entityId,
      targetEntityId: claim.target.entityId,
      validFrom: claim.validFrom,
      validTo: claim.validTo,
      claimSha256: claim.claimSha256,
      accessScopeSha256: claim.accessBinding.accessScopeSha256,
    },
  }, sql ? { sql } : {});
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Entity relation query timestamp is invalid.");
  }
  return parsed.toISOString();
}

function getTemporalClaimsFile() {
  return getDataPath("entity-temporal-relation-claims.json");
}
