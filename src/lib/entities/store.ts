import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  buildEntityMergeReview,
  parseEntityAccessBinding,
  parseEntityAlias,
  parseEntityMergeReview,
  parseEntityRecord,
  parseEntityResolutionDecision,
  resolveEntityIdentity,
  transitionEntityRecord,
  type EntityAccessBinding,
  type EntityAlias,
  type EntityMergeReview,
  type EntityRecord,
  type EntityResolutionDecision,
} from "@/lib/entities/registry";
import type { EntityTypeId } from "@/lib/entities/ontology";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

type EntityRegistryLedger = {
  schemaVersion: 1;
  entities: EntityRecord[];
  aliases: EntityAlias[];
  resolutions: EntityResolutionDecision[];
  mergeReviews: EntityMergeReview[];
};

type EntityRegistrySnapshot = EntityRegistryLedger;
type EntitySqlClient = ReturnType<typeof getSql>;

const emptyLedger: EntityRegistryLedger = {
  schemaVersion: 1,
  entities: [],
  aliases: [],
  resolutions: [],
  mergeReviews: [],
};

export async function saveEntityRecord(input: {
  entity: EntityRecord;
  executionScope: ExecutionScope;
}): Promise<EntityRecord> {
  const entity = parseEntityRecord(input.entity);
  const scope = assertEntityScope(
    input.executionScope,
    entity.accessBinding,
    "entity.write.v1",
  );
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(scope.tenantId, [scope.initiatingActorId], () =>
      getSql().transaction(async (sql: EntitySqlClient) => {
        const rows = await sql`
          INSERT INTO omni_entity_records (
            tenant_id, id, owner_actor_id, ontology_version_id,
            entity_type_id, canonical_label, normalized_label_sha256,
            state, merged_into_entity_id, access_scope_sha256, contract,
            entity_sha256, created_at, updated_at
          ) VALUES (
            ${scope.tenantId}, ${entity.entityId}, ${scope.initiatingActorId},
            ${entity.ontologyVersionId}, ${entity.entityTypeId},
            ${entity.canonicalLabel}, ${entity.normalizedLabelSha256},
            ${entity.state}, ${entity.mergedIntoEntityId},
            ${entity.accessBinding.accessScopeSha256}, ${entity}::jsonb,
            ${entity.entitySha256}, ${entity.createdAt}, ${entity.updatedAt}
          )
          ON CONFLICT (tenant_id, id) DO NOTHING
          RETURNING contract
        `;
        const stored = rows[0]
          ? parseEntityRecord(rows[0].contract)
          : await loadEntityRecord(sql, scope.tenantId, entity.entityId);
        assertSameDigest(stored?.entitySha256, entity.entitySha256, "entity");
        if (rows[0]) {
          await appendRegistryEvent({
            id: `entity-created:${entity.entitySha256}`,
            type: "entity.created",
            streamId: `entity:${entity.entityId}`,
            executionScope: scope,
            payload: {
              schemaVersion: 1,
              entityId: entity.entityId,
              entityTypeId: entity.entityTypeId,
              entitySha256: entity.entitySha256,
              accessScopeSha256: entity.accessBinding.accessScopeSha256,
            },
          }, sql);
        }
        return stored!;
      }) as Promise<EntityRecord>,
    );
  }

  let created = false;
  let stored = entity;
  await updateLedger((ledger) => {
    const existing = ledger.entities.find((candidate) =>
      candidate.accessBinding.tenantId === scope.tenantId &&
      candidate.entityId === entity.entityId
    );
    if (existing) {
      stored = parseEntityRecord(existing);
      assertSameDigest(stored.entitySha256, entity.entitySha256, "entity");
      return ledger;
    }
    created = true;
    return { ...ledger, entities: [...ledger.entities, entity] };
  });
  if (created) {
    await appendRegistryEvent({
      id: `entity-created:${entity.entitySha256}`,
      type: "entity.created",
      streamId: `entity:${entity.entityId}`,
      executionScope: scope,
      payload: {
        schemaVersion: 1,
        entityId: entity.entityId,
        entityTypeId: entity.entityTypeId,
        entitySha256: entity.entitySha256,
        accessScopeSha256: entity.accessBinding.accessScopeSha256,
      },
    });
  }
  return stored;
}

export async function saveEntityAlias(input: {
  entity: EntityRecord;
  alias: EntityAlias;
  executionScope: ExecutionScope;
}): Promise<EntityAlias> {
  const entity = parseEntityRecord(input.entity);
  const alias = parseEntityAlias(input.alias);
  const scope = assertEntityScope(
    input.executionScope,
    entity.accessBinding,
    "entity.write.v1",
  );
  assertAliasEntity(alias, entity);
  if (entity.state !== "active") {
    throw new Error("Entity aliases can only be attached to an active entity.");
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(scope.tenantId, [scope.initiatingActorId], () =>
      getSql().transaction(async (sql: EntitySqlClient) => {
        const parent = await loadEntityRecord(sql, scope.tenantId, entity.entityId);
        assertSameDigest(parent?.entitySha256, entity.entitySha256, "entity");
        const rows = await sql`
          INSERT INTO omni_entity_aliases (
            tenant_id, id, owner_actor_id, entity_id,
            normalized_alias_sha256, access_scope_sha256, state,
            contract, alias_sha256, created_at
          ) VALUES (
            ${scope.tenantId}, ${alias.aliasId}, ${scope.initiatingActorId},
            ${alias.entityId}, ${alias.normalizedAliasSha256},
            ${alias.accessScopeSha256}, ${alias.state}, ${alias}::jsonb,
            ${alias.aliasSha256}, ${alias.createdAt}
          )
          ON CONFLICT (tenant_id, id) DO NOTHING
          RETURNING contract
        `;
        const stored = rows[0]
          ? parseEntityAlias(rows[0].contract)
          : await loadEntityAlias(sql, scope.tenantId, alias.aliasId);
        assertSameDigest(stored?.aliasSha256, alias.aliasSha256, "entity alias");
        if (rows[0]) {
          await appendRegistryEvent({
            id: `entity-alias-created:${alias.aliasSha256}`,
            type: "entity.alias.created",
            streamId: `entity:${entity.entityId}`,
            executionScope: scope,
            payload: {
              schemaVersion: 1,
              entityId: entity.entityId,
              aliasId: alias.aliasId,
              aliasSha256: alias.aliasSha256,
              accessScopeSha256: alias.accessScopeSha256,
            },
          }, sql);
        }
        return stored!;
      }) as Promise<EntityAlias>,
    );
  }

  let created = false;
  let stored = alias;
  await updateLedger((ledger) => {
    const parent = ledger.entities.find((candidate) =>
      candidate.accessBinding.tenantId === scope.tenantId &&
      candidate.entityId === entity.entityId
    );
    assertSameDigest(parent?.entitySha256, entity.entitySha256, "entity");
    const existing = ledger.aliases.find((candidate) =>
      candidate.aliasId === alias.aliasId && parent
    );
    if (existing) {
      stored = parseEntityAlias(existing);
      assertSameDigest(stored.aliasSha256, alias.aliasSha256, "entity alias");
      return ledger;
    }
    created = true;
    return { ...ledger, aliases: [...ledger.aliases, alias] };
  });
  if (created) {
    await appendRegistryEvent({
      id: `entity-alias-created:${alias.aliasSha256}`,
      type: "entity.alias.created",
      streamId: `entity:${entity.entityId}`,
      executionScope: scope,
      payload: {
        schemaVersion: 1,
        entityId: entity.entityId,
        aliasId: alias.aliasId,
        aliasSha256: alias.aliasSha256,
        accessScopeSha256: alias.accessScopeSha256,
      },
    });
  }
  return stored;
}

export async function resolveAndRecordEntityIdentity(input: {
  entityTypeId: EntityTypeId;
  label: string;
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  decidedAt?: string;
}): Promise<EntityResolutionDecision> {
  const accessBinding = parseEntityAccessBinding(input.accessBinding);
  const scope = assertEntityScope(
    input.executionScope,
    accessBinding,
    "entity.resolve.v1",
  );
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(scope.tenantId, [scope.initiatingActorId], () =>
      getSql().transaction(async (sql: EntitySqlClient) => {
        const candidates = await loadCandidates(sql, input.entityTypeId, accessBinding);
        const resolution = resolveEntityIdentity({ ...input, accessBinding, candidates });
        const rows = await sql`
          INSERT INTO omni_entity_resolutions (
            tenant_id, id, owner_actor_id, entity_type_id,
            access_scope_sha256, decision, selected_entity_id,
            contract, decision_sha256, decided_at
          ) VALUES (
            ${scope.tenantId}, ${resolution.resolutionId},
            ${scope.initiatingActorId}, ${resolution.entityTypeId},
            ${resolution.accessScopeSha256}, ${resolution.decision},
            ${resolution.selectedEntityId}, ${resolution}::jsonb,
            ${resolution.decisionSha256}, ${resolution.decidedAt}
          )
          ON CONFLICT (tenant_id, id) DO NOTHING
          RETURNING contract
        `;
        const stored = rows[0]
          ? parseEntityResolutionDecision(rows[0].contract)
          : await loadResolution(sql, scope.tenantId, resolution.resolutionId);
        assertSameDigest(
          stored?.decisionSha256,
          resolution.decisionSha256,
          "entity resolution",
        );
        if (rows[0]) await appendResolutionEvent(stored!, scope, sql);
        return stored!;
      }) as Promise<EntityResolutionDecision>,
    );
  }

  let created = false;
  let stored: EntityResolutionDecision | undefined;
  await updateLedger((ledger) => {
    const candidates = candidatesFromLedger(
      ledger,
      input.entityTypeId,
      accessBinding,
    );
    const resolution = resolveEntityIdentity({ ...input, accessBinding, candidates });
    const existing = ledger.resolutions.find((candidate) =>
      candidate.tenantId === scope.tenantId &&
      candidate.resolutionId === resolution.resolutionId
    );
    if (existing) {
      stored = parseEntityResolutionDecision(existing);
      assertSameDigest(
        stored.decisionSha256,
        resolution.decisionSha256,
        "entity resolution",
      );
      return ledger;
    }
    stored = resolution;
    created = true;
    return { ...ledger, resolutions: [...ledger.resolutions, resolution] };
  });
  if (created) await appendResolutionEvent(stored!, scope);
  return stored!;
}

export async function reviewEntityMerge(input: {
  resolutionId: string;
  sourceEntityId: string;
  targetEntityId: string;
  decision: "approved" | "rejected" | "reversed";
  previousReviewId?: string;
  executionScope: ExecutionScope;
  reviewedAt?: string;
}): Promise<EntityMergeReview> {
  const scope = assertBasicScope(input.executionScope, "entity.review.v1");
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(scope.tenantId, [scope.initiatingActorId], () =>
      getSql().transaction(async (sql: EntitySqlClient) => {
        const resolution = await loadResolution(sql, scope.tenantId, input.resolutionId);
        const source = await loadEntityRecord(
          sql,
          scope.tenantId,
          input.sourceEntityId,
          true,
        );
        const target = await loadEntityRecord(
          sql,
          scope.tenantId,
          input.targetEntityId,
          true,
        );
        if (!resolution || !source || !target) {
          throw new Error("Entity merge review target was not found in scope.");
        }
        assertEntityScope(scope, source.accessBinding, "entity.review.v1");
        assertEntityScope(scope, target.accessBinding, "entity.review.v1");
        const previousReview = input.previousReviewId
          ? await loadMergeReview(sql, scope.tenantId, input.previousReviewId)
          : undefined;
        const review = buildEntityMergeReview({
          resolution,
          sourceEntity: source,
          targetEntity: target,
          reviewerActorId: scope.initiatingActorId,
          decision: input.decision,
          previousReview,
          reviewedAt: input.reviewedAt,
        });
        const rows = await sql`
          INSERT INTO omni_entity_merge_reviews (
            tenant_id, id, owner_actor_id, resolution_id, source_entity_id,
            target_entity_id, access_scope_sha256, decision,
            previous_review_id, reviewer_actor_id, contract,
            review_sha256, reviewed_at
          ) VALUES (
            ${scope.tenantId}, ${review.reviewId}, ${scope.initiatingActorId},
            ${review.resolutionId}, ${review.sourceEntityId},
            ${review.targetEntityId}, ${review.accessScopeSha256},
            ${review.decision}, ${review.previousReviewId},
            ${review.reviewerActorId}, ${review}::jsonb,
            ${review.reviewSha256}, ${review.reviewedAt}
          )
          ON CONFLICT DO NOTHING
          RETURNING contract
        `;
        if (!rows[0]) {
          const stored = await loadMergeReview(sql, scope.tenantId, review.reviewId);
          assertSameDigest(stored?.reviewSha256, review.reviewSha256, "entity merge review");
          return stored!;
        }
        if (review.decision !== "rejected") {
          const next = transitionEntityRecord({
            entity: source,
            state: review.decision === "approved" ? "merged" : "active",
            mergedIntoEntityId:
              review.decision === "approved" ? target.entityId : null,
            updatedAt: review.reviewedAt,
          });
          const updated = await sql`
            UPDATE omni_entity_records
            SET state = ${next.state},
                merged_into_entity_id = ${next.mergedIntoEntityId},
                contract = ${next}::jsonb,
                entity_sha256 = ${next.entitySha256},
                updated_at = ${next.updatedAt}
            WHERE tenant_id = ${scope.tenantId}
              AND id = ${source.entityId}
              AND entity_sha256 = ${source.entitySha256}
            RETURNING id
          `;
          if (!updated[0]) throw new Error("Entity merge state changed concurrently.");
        }
        await appendMergeReviewEvent(review, scope, sql);
        return review;
      }) as Promise<EntityMergeReview>,
    );
  }

  let created = false;
  let stored: EntityMergeReview | undefined;
  await updateLedger((ledger) => {
    const resolution = ledger.resolutions.find((candidate) =>
      candidate.tenantId === scope.tenantId &&
      candidate.resolutionId === input.resolutionId &&
      candidate.ownerActorId === scope.initiatingActorId
    );
    const sourceIndex = ledger.entities.findIndex((candidate) =>
      candidate.accessBinding.tenantId === scope.tenantId &&
      candidate.accessBinding.ownerActorId === scope.initiatingActorId &&
      candidate.entityId === input.sourceEntityId
    );
    const target = ledger.entities.find((candidate) =>
      candidate.accessBinding.tenantId === scope.tenantId &&
      candidate.accessBinding.ownerActorId === scope.initiatingActorId &&
      candidate.entityId === input.targetEntityId
    );
    if (!resolution || sourceIndex < 0 || !target) {
      throw new Error("Entity merge review target was not found in scope.");
    }
    const source = parseEntityRecord(ledger.entities[sourceIndex]);
    assertEntityScope(scope, source.accessBinding, "entity.review.v1");
    assertEntityScope(scope, target.accessBinding, "entity.review.v1");
    const previousReview = input.previousReviewId
      ? ledger.mergeReviews.find((candidate) =>
          candidate.tenantId === scope.tenantId &&
          candidate.reviewId === input.previousReviewId
        )
      : undefined;
    const review = buildEntityMergeReview({
      resolution: parseEntityResolutionDecision(resolution),
      sourceEntity: source,
      targetEntity: parseEntityRecord(target),
      reviewerActorId: scope.initiatingActorId,
      decision: input.decision,
      previousReview: previousReview
        ? parseEntityMergeReview(previousReview)
        : undefined,
      reviewedAt: input.reviewedAt,
    });
    const existing = ledger.mergeReviews.find((candidate) =>
      candidate.reviewId === review.reviewId && candidate.tenantId === scope.tenantId
    );
    if (existing) {
      stored = parseEntityMergeReview(existing);
      assertSameDigest(stored.reviewSha256, review.reviewSha256, "entity merge review");
      return ledger;
    }
    if (
      review.decision === "reversed" &&
      ledger.mergeReviews.some((candidate) =>
        candidate.decision === "reversed" &&
        candidate.previousReviewId === review.previousReviewId
      )
    ) {
      throw new Error("Entity merge approval was already reversed.");
    }
    const entities = [...ledger.entities];
    if (review.decision !== "rejected") {
      entities[sourceIndex] = transitionEntityRecord({
        entity: source,
        state: review.decision === "approved" ? "merged" : "active",
        mergedIntoEntityId:
          review.decision === "approved" ? target.entityId : null,
        updatedAt: review.reviewedAt,
      });
    }
    created = true;
    stored = review;
    return {
      ...ledger,
      entities,
      mergeReviews: [...ledger.mergeReviews, review],
    };
  });
  if (created) await appendMergeReviewEvent(stored!, scope);
  return stored!;
}

export async function readEntityRegistry(input: {
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  entityTypeId?: EntityTypeId;
}): Promise<EntityRegistrySnapshot> {
  const accessBinding = parseEntityAccessBinding(input.accessBinding);
  const scope = assertEntityScope(
    input.executionScope,
    accessBinding,
    "entity.read.v1",
  );
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(scope.tenantId, [scope.initiatingActorId], async () => {
      const sql = getSql();
      const entityRows = input.entityTypeId
        ? await sql`
            SELECT contract FROM omni_entity_records
            WHERE tenant_id = ${scope.tenantId}
              AND owner_actor_id = ${scope.initiatingActorId}
              AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
              AND entity_type_id = ${input.entityTypeId}
            ORDER BY id COLLATE "C"
          `
        : await sql`
            SELECT contract FROM omni_entity_records
            WHERE tenant_id = ${scope.tenantId}
              AND owner_actor_id = ${scope.initiatingActorId}
              AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
            ORDER BY id COLLATE "C"
          `;
      const entities = entityRows.map((row) => parseEntityRecord(row.contract));
      const entityIds = new Set(entities.map((entity) => entity.entityId));
      const [aliasRows, resolutionRows, reviewRows] = await Promise.all([
        sql`
          SELECT contract FROM omni_entity_aliases
          WHERE tenant_id = ${scope.tenantId}
            AND owner_actor_id = ${scope.initiatingActorId}
            AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
          ORDER BY id COLLATE "C"
        `,
        sql`
          SELECT contract FROM omni_entity_resolutions
          WHERE tenant_id = ${scope.tenantId}
            AND owner_actor_id = ${scope.initiatingActorId}
            AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
          ORDER BY decided_at, id COLLATE "C"
        `,
        sql`
          SELECT contract FROM omni_entity_merge_reviews
          WHERE tenant_id = ${scope.tenantId}
            AND owner_actor_id = ${scope.initiatingActorId}
            AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
          ORDER BY reviewed_at, id COLLATE "C"
        `,
      ]);
      return {
        schemaVersion: 1,
        entities,
        aliases: aliasRows
          .map((row) => parseEntityAlias(row.contract))
          .filter((alias) => entityIds.has(alias.entityId)),
        resolutions: resolutionRows
          .map((row) => parseEntityResolutionDecision(row.contract))
          .filter((resolution) =>
            !input.entityTypeId || resolution.entityTypeId === input.entityTypeId
          ),
        mergeReviews: reviewRows
          .map((row) => parseEntityMergeReview(row.contract))
          .filter((review) =>
            entityIds.has(review.sourceEntityId) || entityIds.has(review.targetEntityId)
          ),
      };
    });
  }
  const ledger = await readLedger();
  const entities = ledger.entities
    .map(parseEntityRecord)
    .filter((entity) =>
      entity.accessBinding.tenantId === scope.tenantId &&
      entity.accessBinding.ownerActorId === scope.initiatingActorId &&
      entity.accessBinding.accessScopeSha256 === accessBinding.accessScopeSha256 &&
      (!input.entityTypeId || entity.entityTypeId === input.entityTypeId)
    );
  const entityIds = new Set(entities.map((entity) => entity.entityId));
  return {
    schemaVersion: 1,
    entities,
    aliases: ledger.aliases.map(parseEntityAlias).filter((alias) =>
      entityIds.has(alias.entityId)
    ),
    resolutions: ledger.resolutions.map(parseEntityResolutionDecision).filter((resolution) =>
      resolution.tenantId === scope.tenantId &&
      resolution.ownerActorId === scope.initiatingActorId &&
      resolution.accessScopeSha256 === accessBinding.accessScopeSha256 &&
      (!input.entityTypeId || resolution.entityTypeId === input.entityTypeId)
    ),
    mergeReviews: ledger.mergeReviews.map(parseEntityMergeReview).filter((review) =>
      review.tenantId === scope.tenantId &&
      review.ownerActorId === scope.initiatingActorId &&
      review.accessScopeSha256 === accessBinding.accessScopeSha256 &&
      (entityIds.has(review.sourceEntityId) || entityIds.has(review.targetEntityId))
    ),
  };
}

function assertBasicScope(value: ExecutionScope, purpose: string) {
  const scope = parsePersistedExecutionScope(value);
  if (
    !scope?.initiatingActorId ||
    scope.purpose !== purpose ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== scope.initiatingActorId
  ) {
    throw new Error("Entity registry mutation requires an exact user execution scope.");
  }
  return scope as ExecutionScope & { initiatingActorId: string };
}

function assertEntityScope(
  value: ExecutionScope,
  binding: EntityAccessBinding,
  purpose: string,
) {
  const scope = assertBasicScope(value, purpose);
  if (
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
    throw new Error("Entity registry execution scope does not match its access binding.");
  }
  return scope;
}

function assertAliasEntity(alias: EntityAlias, entity: EntityRecord) {
  if (
    alias.entityId !== entity.entityId ||
    alias.accessScopeSha256 !== entity.accessBinding.accessScopeSha256
  ) {
    throw new Error("Entity alias does not match its parent entity scope.");
  }
}

function assertSameDigest(
  actual: string | undefined,
  expected: string,
  recordType: string,
) {
  if (!actual) throw new Error(`${recordType} was not found in scope.`);
  if (actual !== expected) {
    throw new Error(`${recordType} id is already bound to a different contract.`);
  }
}

async function loadEntityRecord(
  sql: EntitySqlClient,
  tenantId: string,
  entityId: string,
  forUpdate = false,
) {
  const rows = await sql.query(
    `SELECT contract FROM omni_entity_records
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, entityId],
  );
  return rows[0] ? parseEntityRecord(rows[0].contract) : undefined;
}

async function loadEntityAlias(
  sql: EntitySqlClient,
  tenantId: string,
  aliasId: string,
) {
  const rows = await sql`
    SELECT contract FROM omni_entity_aliases
    WHERE tenant_id = ${tenantId} AND id = ${aliasId}
    LIMIT 1
  `;
  return rows[0] ? parseEntityAlias(rows[0].contract) : undefined;
}

async function loadResolution(
  sql: EntitySqlClient,
  tenantId: string,
  resolutionId: string,
) {
  const rows = await sql`
    SELECT contract FROM omni_entity_resolutions
    WHERE tenant_id = ${tenantId} AND id = ${resolutionId}
    LIMIT 1
  `;
  return rows[0]
    ? parseEntityResolutionDecision(rows[0].contract)
    : undefined;
}

async function loadMergeReview(
  sql: EntitySqlClient,
  tenantId: string,
  reviewId: string,
) {
  const rows = await sql`
    SELECT contract FROM omni_entity_merge_reviews
    WHERE tenant_id = ${tenantId} AND id = ${reviewId}
    LIMIT 1
  `;
  return rows[0] ? parseEntityMergeReview(rows[0].contract) : undefined;
}

async function loadCandidates(
  sql: EntitySqlClient,
  entityTypeId: EntityTypeId,
  accessBinding: EntityAccessBinding,
) {
  const entityRows = await sql`
    SELECT contract FROM omni_entity_records
    WHERE tenant_id = ${accessBinding.tenantId}
      AND owner_actor_id = ${accessBinding.ownerActorId}
      AND entity_type_id = ${entityTypeId}
      AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
      AND state = 'active'
    ORDER BY id COLLATE "C"
  `;
  const entities = entityRows.map((row) => parseEntityRecord(row.contract));
  const aliasRows = await sql`
    SELECT contract FROM omni_entity_aliases
    WHERE tenant_id = ${accessBinding.tenantId}
      AND owner_actor_id = ${accessBinding.ownerActorId}
      AND access_scope_sha256 = ${accessBinding.accessScopeSha256}
      AND state = 'active'
    ORDER BY id COLLATE "C"
  `;
  const aliases = aliasRows.map((row) => parseEntityAlias(row.contract));
  return entities.map((entity) => ({
    entity,
    aliases: aliases.filter((alias) => alias.entityId === entity.entityId),
  }));
}

function candidatesFromLedger(
  ledger: EntityRegistryLedger,
  entityTypeId: EntityTypeId,
  accessBinding: EntityAccessBinding,
) {
  const entities = ledger.entities.map(parseEntityRecord).filter((entity) =>
    entity.entityTypeId === entityTypeId &&
    entity.accessBinding.tenantId === accessBinding.tenantId &&
    entity.accessBinding.ownerActorId === accessBinding.ownerActorId &&
    entity.accessBinding.accessScopeSha256 === accessBinding.accessScopeSha256 &&
    entity.state === "active"
  );
  const aliases = ledger.aliases.map(parseEntityAlias);
  return entities.map((entity) => ({
    entity,
    aliases: aliases.filter((alias) => alias.entityId === entity.entityId),
  }));
}

async function appendResolutionEvent(
  resolution: EntityResolutionDecision,
  executionScope: ExecutionScope,
  sql?: EntitySqlClient,
) {
  return appendRegistryEvent({
    id: `entity-resolution:${resolution.decisionSha256}`,
    type: "entity.resolution.recorded",
    streamId: `entity-resolution:${resolution.resolutionId}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      resolutionId: resolution.resolutionId,
      decision: resolution.decision,
      candidateCount: resolution.candidateEntityIds.length,
      matchMethod: resolution.matchMethod,
      decisionSha256: resolution.decisionSha256,
      accessScopeSha256: resolution.accessScopeSha256,
    },
  }, sql);
}

async function appendMergeReviewEvent(
  review: EntityMergeReview,
  executionScope: ExecutionScope,
  sql?: EntitySqlClient,
) {
  return appendRegistryEvent({
    id: `entity-merge-review:${review.reviewSha256}`,
    type: "entity.merge.reviewed",
    streamId: `entity:${review.sourceEntityId}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      reviewId: review.reviewId,
      resolutionId: review.resolutionId,
      decision: review.decision,
      reviewSha256: review.reviewSha256,
      accessScopeSha256: review.accessScopeSha256,
    },
  }, sql);
}

function appendRegistryEvent(
  input: Parameters<typeof appendScopedDomainEvent>[0],
  sql?: EntitySqlClient,
) {
  return appendScopedDomainEvent(input, sql ? { sql } : {});
}

function getEntityRegistryFile() {
  return getDataPath("entity-registry.json");
}

function readLedger() {
  return readJsonFile<EntityRegistryLedger>(getEntityRegistryFile(), emptyLedger);
}

function updateLedger(
  mutate: (ledger: EntityRegistryLedger) => EntityRegistryLedger,
) {
  return updateJsonFile<EntityRegistryLedger>(
    getEntityRegistryFile(),
    emptyLedger,
    mutate,
  );
}
