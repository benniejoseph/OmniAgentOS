import { randomUUID } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { rebuildTemporalRelationProjection } from "@/lib/entities/relation-projector";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type RelationProjectionQueueSqlClient = ReturnType<typeof getSql>;

export async function queueTemporalRelationProjection(input: {
  tenantId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
  sql?: RelationProjectionQueueSqlClient;
}) {
  const scope = assertQueueScope(input);
  if (!hasDatabaseUrl() && !input.sql) {
    return Object.freeze({
      queued: false,
      tenantId: input.tenantId,
      ownerActorId: input.ownerActorId,
      generation: "0",
    });
  }
  if (!input.sql) await ensureDatabaseSchema();
  const operation = async (sql: RelationProjectionQueueSqlClient) => {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.tenantId}),
        hashtext(${`entity-relations:${input.ownerActorId}`})
      )
    `;
    const rows = await sql`
      INSERT INTO omni_entity_relation_projection_queue AS queue (
        tenant_id, owner_actor_id, requested_at, attempts, last_error,
        lease_owner, lease_expires_at, updated_at, generation
      ) VALUES (
        ${input.tenantId}, ${input.ownerActorId}, NOW(), 0, NULL,
        NULL, NULL, NOW(), 1
      )
      ON CONFLICT (tenant_id, owner_actor_id) DO UPDATE SET
        requested_at = NOW(),
        attempts = 0,
        last_error = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = NOW(),
        generation = queue.generation + 1
      RETURNING tenant_id, owner_actor_id, generation, requested_at
    `;
    if (!rows[0]) throw new Error("Relation projection could not be queued.");
    const result = Object.freeze({
      queued: true,
      tenantId: String(rows[0].tenant_id),
      ownerActorId: String(rows[0].owner_actor_id),
      generation: String(rows[0].generation),
      requestedAt: new Date(rows[0].requested_at as string | number | Date)
        .toISOString(),
    });
    await appendScopedDomainEvent({
      id: `entity-relation-projection-requested:${sourceContractSha256(result)}`,
      streamId: `entity-relations:${input.ownerActorId}`,
      type: "entity.relation_projection.requested",
      executionScope: scope,
      payload: {
        schemaVersion: 1,
        generation: result.generation,
        requestedAt: result.requestedAt,
        status: "queued",
      },
    }, { sql });
    return result;
  };
  if (input.sql) return operation(input.sql);
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    () => getSql().transaction(operation),
  ) as ReturnType<typeof operation>;
}

export async function processPendingTemporalRelationProjections({
  limit = 3,
}: { limit?: number } = {}) {
  if (!hasDatabaseUrl()) {
    return Object.freeze({
      processed: 0,
      completed: 0,
      failed: 0,
      activeClaims: 0,
      owners: Object.freeze([] as string[]),
    });
  }
  await ensureDatabaseSchema();
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 10);
  const claims = await claimProjectionJobs(boundedLimit);
  let completed = 0;
  let failed = 0;
  let activeClaims = 0;

  for (const claim of claims) {
    try {
      const report = await rebuildTemporalRelationProjection({
        tenantId: claim.tenantId,
        ownerActorId: claim.ownerActorId,
        correlationId: `entity_relation_queue_${claim.leaseOwner}`,
      });
      activeClaims += report.activeClaimCount;
      await runWithDatabaseSystemScope(
        "Acknowledge a completed temporal relation projection generation.",
        async () => {
          const deleted = await getSql()`
            DELETE FROM omni_entity_relation_projection_queue
            WHERE tenant_id = ${claim.tenantId}
              AND owner_actor_id = ${claim.ownerActorId}
              AND generation = ${claim.generation}::bigint
              AND lease_owner = ${claim.leaseOwner}
            RETURNING tenant_id
          `;
          if (!deleted[0]) {
            await getSql()`
              UPDATE omni_entity_relation_projection_queue
              SET lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
              WHERE tenant_id = ${claim.tenantId}
                AND owner_actor_id = ${claim.ownerActorId}
                AND lease_owner = ${claim.leaseOwner}
            `;
          }
        },
      );
      completed += 1;
    } catch (error) {
      failed += 1;
      const message = (
        error instanceof Error
          ? error.message
          : "Temporal relation projection failed."
      ).slice(0, 1_000);
      await runWithDatabaseSystemScope(
        "Release a failed temporal relation projection lease for retry.",
        () => getSql()`
          UPDATE omni_entity_relation_projection_queue
          SET attempts = CASE
                WHEN generation = ${claim.generation}::bigint
                THEN attempts + 1
                ELSE 0
              END,
              last_error = CASE
                WHEN generation = ${claim.generation}::bigint
                THEN ${message}
                ELSE NULL
              END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE tenant_id = ${claim.tenantId}
            AND owner_actor_id = ${claim.ownerActorId}
            AND lease_owner = ${claim.leaseOwner}
        `,
      ).catch(() => undefined);
    }
  }

  return Object.freeze({
    processed: claims.length,
    completed,
    failed,
    activeClaims,
    owners: Object.freeze(claims.map((claim) =>
      `${claim.tenantId}:${claim.ownerActorId}`
    )),
  });
}

async function claimProjectionJobs(limit: number) {
  const leaseOwner = randomUUID();
  return runWithDatabaseSystemScope(
    "Lease actor-owned temporal relation projection work.",
    () => getSql().transaction(async (sql: RelationProjectionQueueSqlClient) => {
      const rows = await sql`
        WITH candidates AS (
          SELECT tenant_id, owner_actor_id
          FROM omni_entity_relation_projection_queue
          WHERE lease_expires_at IS NULL OR lease_expires_at <= NOW()
          ORDER BY attempts, requested_at, tenant_id, owner_actor_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE omni_entity_relation_projection_queue queue
        SET lease_owner = ${leaseOwner},
            lease_expires_at = NOW() + (900 * INTERVAL '1 second'),
            updated_at = NOW()
        FROM candidates
        WHERE queue.tenant_id = candidates.tenant_id
          AND queue.owner_actor_id = candidates.owner_actor_id
        RETURNING queue.tenant_id, queue.owner_actor_id, queue.generation
      `;
      return rows.map((row) => ({
        tenantId: String(row.tenant_id),
        ownerActorId: String(row.owner_actor_id),
        generation: String(row.generation),
        leaseOwner,
      }));
    }) as Promise<Array<{
      tenantId: string;
      ownerActorId: string;
      generation: string;
      leaseOwner: string;
    }>>,
  );
}

function assertQueueScope(input: {
  tenantId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
  sql?: RelationProjectionQueueSqlClient;
}) {
  const scope = parsePersistedExecutionScope(input.executionScope);
  const userOwner =
    scope?.executingPrincipalType === "user" &&
    scope.executingPrincipalId === input.ownerActorId;
  const governedTransaction =
    Boolean(input.sql) &&
    scope?.executingPrincipalType === "system" &&
    Boolean(scope.executingPrincipalId);
  if (
    !scope ||
    scope.tenantId !== input.tenantId ||
    scope.initiatingActorId !== input.ownerActorId ||
    (!userOwner && !governedTransaction) ||
    scope.workspaceId !== null ||
    scope.projectId !== null ||
    scope.missionId !== null
  ) {
    throw new Error("Relation projection queue requires an exact owner scope.");
  }
  return scope;
}
