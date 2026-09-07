import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  buildA2ASafetyReservationV1,
  parseA2ASafetyReservationV1,
  type A2ASafetyLineageV1,
  type A2ASafetyReservationV1,
} from "@/lib/a2a/safety";
import type { A2APeerRolloutV1 } from "@/lib/a2a/rollout";
import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type A2ASafetySql = ReturnType<typeof getSql>;

export type A2ASafetyStatus =
  | "active"
  | "completed"
  | "challenged"
  | "canceled"
  | "expired";

export type A2ASafetyStateV1 = Readonly<{
  reservation: A2ASafetyReservationV1;
  status: A2ASafetyStatus;
  toolCallsUsed: number;
  progressRevision: number;
  lastProgressAt: string;
  terminalAt: string | null;
}>;

export class A2ASafetyStoreError extends Error {
  readonly code = "a2a_safety_store_denied";

  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 503 = 409,
  ) {
    super(message);
    this.name = "A2ASafetyStoreError";
  }
}

export async function reserveExternalA2ASafety(input: {
  contract: DelegationContractV1;
  internalTask: DelegationTaskV1;
  rollout: A2APeerRolloutV1;
  executionScope: ExecutionScope;
  now?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReservationScope(input);
  const now = input.now || new Date().toISOString();
  return getSql().transaction(async (sql: A2ASafetySql) => {
    const existing = await readStateByTask(sql, {
      tenantId: input.contract.scope.tenantId,
      ownerActorId: input.contract.scope.initiatingActorId,
      internalTaskId: input.internalTask.taskId,
    }, false);
    if (existing) {
      assertSameAuthority(existing, input.contract, input.rollout);
      return existing;
    }
    const initial = await loadLineage(sql, input.contract);
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`${input.contract.scope.tenantId}:${initial.rootDelegationId}`}, 0
      ))
    `;
    const lineage = await loadLineage(sql, input.contract);
    const counts = await activeCounts(sql, input.contract, lineage.rootDelegationId);
    const reservation = buildA2ASafetyReservationV1({
      contract: input.contract,
      internalTaskId: input.internalTask.taskId,
      rollout: input.rollout,
      lineage: { ...lineage, ...counts },
      createdAt: now,
    });
    const rows = await sql`
      INSERT INTO omni_a2a_safety_reservations (
        schema_version, tenant_id, owner_actor_id, safety_id, safety_sha256,
        internal_task_id, delegation_id, parent_execution_id,
        parent_delegation_id, root_delegation_id, peer_id, rollout_id,
        rollout_sha256, contract_sha256, recursion_depth,
        reserved_cost_microusd, max_tool_calls, progress_timeout_ms,
        deadline_at, reservation, status, tool_calls_used,
        progress_revision, last_progress_at, created_at, terminal_at
      ) VALUES (
        1, ${reservation.tenantId}, ${reservation.ownerActorId},
        ${reservation.safetyId}, ${reservation.safetySha256},
        ${reservation.internalTaskId}, ${reservation.delegationId},
        ${input.contract.scope.parentExecutionId},
        ${reservation.parentDelegationId}, ${reservation.rootDelegationId},
        ${reservation.peerId}, ${reservation.rolloutId},
        ${reservation.rolloutSha256}, ${reservation.contractSha256},
        ${reservation.recursionDepth}, ${reservation.budgets.costMicrousd},
        ${reservation.maxToolCalls}, ${reservation.progressTimeoutMs},
        ${reservation.deadlineAt}, ${reservation}::jsonb, 'active', 0, 0,
        ${now}, ${now}, NULL
      )
      ON CONFLICT (tenant_id, internal_task_id) DO NOTHING
      RETURNING reservation, status, tool_calls_used, progress_revision,
                last_progress_at, terminal_at
    `;
    const state = rows[0]
      ? stateFromRow(rows[0])
      : await requireStateByTask(sql, {
          tenantId: reservation.tenantId,
          ownerActorId: reservation.ownerActorId,
          internalTaskId: reservation.internalTaskId,
        }, true);
    assertSameAuthority(state, input.contract, input.rollout);
    if (rows[0]) {
      await appendSafetyEvent(sql, state, input.executionScope, "reserved");
    }
    return state;
  }) as Promise<A2ASafetyStateV1>;
}

export async function getExternalA2ASafety(input: {
  tenantId: string;
  ownerActorId: string;
  internalTaskId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return requireStateByTask(getSql(), input, false);
}

export async function claimExternalA2AToolCall(input: {
  tenantId: string;
  ownerActorId: string;
  internalTaskId: string;
  toolId: string;
  idempotencyKey: string;
  executionScope: ExecutionScope;
  now?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertOwnerScope(input.executionScope, input.tenantId, input.ownerActorId);
  const now = input.now || new Date().toISOString();
  return getSql().transaction(async (sql: A2ASafetySql) => {
    const current = await requireStateByTask(sql, input, true);
    assertLiveSafety(current, now);
    const claimSha256 = canonicalJsonSha256({
      safetyId: current.reservation.safetyId,
      toolId: input.toolId,
      idempotencyKey: input.idempotencyKey,
    });
    const claimId = `a2a-tool-claim:${claimSha256}`;
    const duplicate = await sql`
      SELECT claim_id FROM omni_a2a_tool_call_claims
      WHERE tenant_id = ${input.tenantId} AND claim_id = ${claimId}
      LIMIT 1
    `;
    if (duplicate.length) return { state: current, charged: false } as const;
    if (current.toolCallsUsed >= current.reservation.maxToolCalls) {
      throw new A2ASafetyStoreError(
        "The external delegation tool-call budget is exhausted.",
        409,
      );
    }
    await sql`
      INSERT INTO omni_a2a_tool_call_claims (
        schema_version, tenant_id, owner_actor_id, claim_id, claim_sha256,
        safety_id, internal_task_id, tool_id, created_at
      ) VALUES (
        1, ${input.tenantId}, ${input.ownerActorId}, ${claimId},
        ${claimSha256}, ${current.reservation.safetyId},
        ${input.internalTaskId}, ${input.toolId}, ${now}
      )
    `;
    const rows = await sql`
      UPDATE omni_a2a_safety_reservations
      SET tool_calls_used = tool_calls_used + 1,
          progress_revision = progress_revision + 1,
          last_progress_at = ${now}
      WHERE tenant_id = ${input.tenantId}
        AND internal_task_id = ${input.internalTaskId}
        AND owner_actor_id = ${input.ownerActorId}
        AND status = 'active'
        AND tool_calls_used < max_tool_calls
      RETURNING reservation, status, tool_calls_used, progress_revision,
                last_progress_at, terminal_at
    `;
    if (rows.length !== 1) {
      throw new A2ASafetyStoreError(
        "The external delegation tool-call claim lost its authority race.",
        409,
      );
    }
    const state = stateFromRow(rows[0]);
    await appendSafetyEvent(sql, state, input.executionScope, "tool_claimed", {
      claimId,
      claimSha256,
      toolId: input.toolId,
      toolCallsUsed: state.toolCallsUsed,
    });
    return { state, charged: true } as const;
  }) as Promise<Readonly<{ state: A2ASafetyStateV1; charged: boolean }>>;
}

export async function touchExternalA2ASafety(input: {
  tenantId: string;
  ownerActorId: string;
  internalTaskId: string;
  executionScope: ExecutionScope;
  status?: A2ASafetyStatus;
  now?: string;
  reason?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertOwnerScope(input.executionScope, input.tenantId, input.ownerActorId);
  const status = input.status || "active";
  const now = input.now || new Date().toISOString();
  return getSql().transaction(async (sql: A2ASafetySql) => {
    const current = await requireStateByTask(sql, input, true);
    if (current.status !== "active") {
      if (current.status === status) return current;
      throw new A2ASafetyStoreError("The external delegation safety state is terminal.", 409);
    }
    if (status === "active") assertLiveSafety(current, now);
    const terminalAt = status === "active" ? null : now;
    const rows = await sql`
      UPDATE omni_a2a_safety_reservations
      SET status = ${status},
          progress_revision = progress_revision + 1,
          last_progress_at = ${now},
          terminal_at = ${terminalAt}
      WHERE tenant_id = ${input.tenantId}
        AND internal_task_id = ${input.internalTaskId}
        AND owner_actor_id = ${input.ownerActorId}
        AND status = 'active'
      RETURNING reservation, status, tool_calls_used, progress_revision,
                last_progress_at, terminal_at
    `;
    if (rows.length !== 1) {
      throw new A2ASafetyStoreError("The external delegation safety state changed.", 409);
    }
    const state = stateFromRow(rows[0]);
    await appendSafetyEvent(sql, state, input.executionScope,
      status === "active" ? "progressed" : status,
      input.reason ? { reasonSha256: canonicalJsonSha256(input.reason) } : undefined,
    );
    return state;
  }) as Promise<A2ASafetyStateV1>;
}

export async function listAbandonedExternalA2ASafety(input: {
  tenantId: string;
  limit?: number;
  now?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const limit = Math.max(1, Math.min(input.limit || 10, 25));
  const now = input.now || new Date().toISOString();
  const rows = await getSql()`
    SELECT reservation, status, tool_calls_used, progress_revision,
           last_progress_at, terminal_at
    FROM omni_a2a_safety_reservations
    WHERE tenant_id = ${input.tenantId}
      AND status = 'active'
      AND (
        deadline_at <= ${now}
        OR last_progress_at + progress_timeout_ms * INTERVAL '1 millisecond' <= ${now}
      )
    ORDER BY deadline_at ASC, last_progress_at ASC, safety_id ASC
    LIMIT ${limit}
  `;
  return rows.map(stateFromRow);
}

async function loadLineage(
  sql: A2ASafetySql,
  contract: DelegationContractV1,
): Promise<Pick<A2ASafetyLineageV1,
  "ancestorDelegationIds" | "ancestorPeerIds" | "rootDelegationId">> {
  const chain: Array<{ delegationId: string; peerId?: string }> = [];
  const seen = new Set<string>();
  let cursor = contract.scope.parentDelegationId;
  for (let index = 0; cursor && index < 32; index += 1) {
    if (seen.has(cursor)) {
      throw new A2ASafetyStoreError("The canonical delegation lineage contains a cycle.", 409);
    }
    seen.add(cursor);
    const rows = await sql`
      SELECT task.delegation_id, task.parent_delegation_id, mapping.peer_id
      FROM omni_delegation_tasks task
      LEFT JOIN omni_a2a_task_mappings mapping
        ON mapping.tenant_id = task.tenant_id
       AND mapping.owner_actor_id = task.owner_actor_id
       AND mapping.internal_delegation_id = task.delegation_id
      WHERE task.tenant_id = ${contract.scope.tenantId}
        AND task.owner_actor_id = ${contract.scope.initiatingActorId}
        AND task.delegation_id = ${cursor}
      LIMIT 1
    `;
    if (rows.length !== 1) {
      throw new A2ASafetyStoreError(
        "The parent delegation lineage is unavailable.",
        409,
      );
    }
    chain.push({
      delegationId: String(rows[0].delegation_id),
      ...(rows[0].peer_id ? { peerId: String(rows[0].peer_id) } : {}),
    });
    cursor = rows[0].parent_delegation_id
      ? String(rows[0].parent_delegation_id)
      : null;
  }
  if (cursor) {
    throw new A2ASafetyStoreError("The canonical delegation lineage is unbounded.", 409);
  }
  const rootDelegationId = chain.at(-1)?.delegationId || contract.delegationId;
  const externalAncestors = chain.filter((item) => item.peerId).reverse();
  return {
    ancestorDelegationIds: externalAncestors.map((item) => item.delegationId),
    ancestorPeerIds: externalAncestors.map((item) => item.peerId as string),
    rootDelegationId,
  };
}

async function activeCounts(
  sql: A2ASafetySql,
  contract: DelegationContractV1,
  rootDelegationId: string,
): Promise<Pick<A2ASafetyLineageV1,
  "activeSiblingCount" | "activeRootTaskCount" | "activeRootReservedCostMicrousd">> {
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE
        CASE
          WHEN ${contract.scope.parentDelegationId}::text IS NULL
            THEN parent_delegation_id IS NULL
              AND parent_execution_id = ${contract.scope.parentExecutionId}
          ELSE parent_delegation_id = ${contract.scope.parentDelegationId}
        END
      ) AS active_sibling_count,
      count(*) AS active_root_task_count,
      COALESCE(sum(reserved_cost_microusd), 0) AS active_root_reserved_cost
    FROM omni_a2a_safety_reservations
    WHERE tenant_id = ${contract.scope.tenantId}
      AND owner_actor_id = ${contract.scope.initiatingActorId}
      AND root_delegation_id = ${rootDelegationId}
      AND status = 'active'
  `;
  return {
    activeSiblingCount: Number(rows[0]?.active_sibling_count || 0),
    activeRootTaskCount: Number(rows[0]?.active_root_task_count || 0),
    activeRootReservedCostMicrousd: Number(rows[0]?.active_root_reserved_cost || 0),
  };
}

async function readStateByTask(
  sql: A2ASafetySql,
  input: { tenantId: string; ownerActorId: string; internalTaskId: string },
  forUpdate: boolean,
) {
  const rows = forUpdate
    ? await sql`
        SELECT reservation, status, tool_calls_used, progress_revision,
               last_progress_at, terminal_at
        FROM omni_a2a_safety_reservations
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id = ${input.ownerActorId}
          AND internal_task_id = ${input.internalTaskId}
        LIMIT 1 FOR UPDATE
      `
    : await sql`
        SELECT reservation, status, tool_calls_used, progress_revision,
               last_progress_at, terminal_at
        FROM omni_a2a_safety_reservations
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id = ${input.ownerActorId}
          AND internal_task_id = ${input.internalTaskId}
        LIMIT 1
      `;
  return rows[0] ? stateFromRow(rows[0]) : undefined;
}

async function requireStateByTask(
  sql: A2ASafetySql,
  input: { tenantId: string; ownerActorId: string; internalTaskId: string },
  forUpdate: boolean,
) {
  const state = await readStateByTask(sql, input, forUpdate);
  if (!state) {
    throw new A2ASafetyStoreError("The external delegation safety reservation was not found.", 404);
  }
  return state;
}

function stateFromRow(row: Record<string, unknown>): A2ASafetyStateV1 {
  const status = String(row.status) as A2ASafetyStatus;
  if (!["active", "completed", "challenged", "canceled", "expired"].includes(status)) {
    throw new A2ASafetyStoreError("The external delegation safety state is invalid.", 409);
  }
  return Object.freeze({
    reservation: parseA2ASafetyReservationV1(row.reservation),
    status,
    toolCallsUsed: Number(row.tool_calls_used),
    progressRevision: Number(row.progress_revision),
    lastProgressAt: new Date(String(row.last_progress_at)).toISOString(),
    terminalAt: row.terminal_at ? new Date(String(row.terminal_at)).toISOString() : null,
  });
}

function assertLiveSafety(state: A2ASafetyStateV1, now: string) {
  const nowMs = Date.parse(now);
  if (
    state.status !== "active" ||
    !Number.isFinite(nowMs) ||
    nowMs >= Date.parse(state.reservation.deadlineAt) ||
    nowMs >= Date.parse(state.lastProgressAt) + state.reservation.progressTimeoutMs
  ) {
    throw new A2ASafetyStoreError(
      "The external delegation safety lease is expired or inactive.",
      409,
    );
  }
}

function assertReservationScope(input: {
  contract: DelegationContractV1;
  internalTask: DelegationTaskV1;
  rollout: A2APeerRolloutV1;
  executionScope: ExecutionScope;
}) {
  const { contract, internalTask, rollout } = input;
  assertOwnerScope(
    input.executionScope,
    contract.scope.tenantId,
    contract.scope.initiatingActorId,
  );
  if (
    input.executionScope.executingPrincipalId !== contract.scope.parentPrincipalId ||
    input.executionScope.delegationId !== contract.scope.parentDelegationId ||
    internalTask.tenantId !== contract.scope.tenantId ||
    internalTask.ownerActorId !== contract.scope.initiatingActorId ||
    internalTask.delegationId !== contract.delegationId ||
    internalTask.contractSha256 !== contract.contractSha256 ||
    rollout.tenantId !== contract.scope.tenantId ||
    rollout.ownerActorId !== contract.scope.initiatingActorId
  ) {
    throw new A2ASafetyStoreError(
      "The external delegation safety authority does not match its canonical scope.",
      403,
    );
  }
}

function assertOwnerScope(scope: ExecutionScope, tenantId: string, actorId: string) {
  if (scope.tenantId !== tenantId || scope.initiatingActorId !== actorId) {
    throw new A2ASafetyStoreError(
      "The external delegation safety operation is outside its owner scope.",
      403,
    );
  }
}

function assertSameAuthority(
  state: A2ASafetyStateV1,
  contract: DelegationContractV1,
  rollout: A2APeerRolloutV1,
) {
  if (
    state.reservation.contractSha256 !== contract.contractSha256 ||
    state.reservation.rolloutId !== rollout.rolloutId ||
    state.reservation.rolloutSha256 !== rollout.rolloutSha256 ||
    state.reservation.peerId !== rollout.peerId
  ) {
    throw new A2ASafetyStoreError(
      "The canonical task is already bound to different external safety authority.",
      409,
    );
  }
}

function appendSafetyEvent(
  sql: A2ASafetySql,
  state: A2ASafetyStateV1,
  executionScope: ExecutionScope,
  action: string,
  detail: Record<string, unknown> = {},
) {
  const eventSha256 = canonicalJsonSha256({
    safetySha256: state.reservation.safetySha256,
    status: state.status,
    progressRevision: state.progressRevision,
    toolCallsUsed: state.toolCallsUsed,
    lastProgressAt: state.lastProgressAt,
    action,
    detail,
  });
  return appendScopedDomainEvent({
    id: `a2a-safety-event:${eventSha256}`,
    streamId: `a2a-safety:${state.reservation.delegationId}`,
    type: `a2a.safety.${action}`,
    payload: {
      version: state.reservation.version,
      eventSha256,
      safetyId: state.reservation.safetyId,
      safetySha256: state.reservation.safetySha256,
      internalTaskId: state.reservation.internalTaskId,
      delegationId: state.reservation.delegationId,
      rootDelegationId: state.reservation.rootDelegationId,
      peerId: state.reservation.peerId,
      trustTier: state.reservation.trustTier,
      forceMutationApproval: state.reservation.forceMutationApproval,
      status: state.status,
      progressRevision: state.progressRevision,
      toolCallsUsed: state.toolCallsUsed,
      lastProgressAt: state.lastProgressAt,
      ...detail,
    },
    executionScope,
  }, { sql });
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new A2ASafetyStoreError(
      "External delegation safety requires the canonical database authority.",
      503,
    );
  }
}
