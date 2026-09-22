import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  resolveAgentIdentityForExecution,
} from "@/lib/agents/identity-store";
import type { ResolvedAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import {
  PROMPT_QUEUE_MAX_ITEMS,
  promptQueueAgentPinV1Schema,
  promptQueueCreateRequestSchema,
  promptQueueItemV1Schema,
  promptQueueModelPinV1Schema,
  promptQueueTargetV1Schema,
  type PromptQueueAgentPinV1,
  type PromptQueueCreateRequest,
  type PromptQueueItemV1,
} from "@/lib/command/prompt-queue-contracts";
import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { modelAssignmentScopeForAgent } from "@/lib/orchestration/computer-use-routing";
import { selectAgentModel } from "@/lib/openai/model-router";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";
import { runtimeModelRoutingPolicySha256 } from "@/lib/settings/runtime-model-routing-pin";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type QueueSql = ReturnType<typeof getSql>;

const PROMPT_QUEUE_DISPATCH_LEASE_MS = 6 * 60_000;
const PROMPT_QUEUE_ORPHAN_CONFIRMATION_MAX_AGE_MS = 15 * 60_000;

export class PromptQueueStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "capacity"
      | "identity_drift"
      | "model_drift"
      | "invalid_state",
    message: string,
    readonly status = code === "not_found" ? 404 : code === "capacity" ? 429 : 409,
  ) {
    super(message);
    this.name = "PromptQueueStoreError";
  }
}

export type PromptQueueAuthority = Readonly<{
  tenantId: string;
  /** Canonical auth-user actor persisted as queue ownership. */
  ownerActorId: string;
  /** Request actor retained for legacy Settings/model-assignment lookup. */
  requestActorId: string;
  sessionId: string;
  executionScope: ExecutionScope;
}>;

export type ClaimedPromptQueueDispatch = Readonly<{
  item: PromptQueueItemV1;
  dispatchToken: string;
}>;

export type PromptQueueDispatchProgressResult = Readonly<
  | { status: "applied" }
  | { status: "stale" }
>;

export type PromptQueueDispatchReceiptInspection = Readonly<
  | { status: "applied" }
  | { status: "retryable" }
  | { status: "stale" }
>;

export async function listPromptQueueItems(
  authority: PromptQueueAuthority,
): Promise<PromptQueueItemV1[]> {
  await reconcileExpiredPromptQueueDispatches(authority);
  const rows = await getSql()`
    SELECT *
    FROM omni_prompt_queue_items
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${authority.ownerActorId}
      AND state <> 'deleted'
    ORDER BY
      CASE WHEN state IN ('queued', 'paused', 'dispatching') THEN 0 ELSE 1 END,
      position_key,
      created_at,
      id
    LIMIT ${PROMPT_QUEUE_MAX_ITEMS}
  `;
  return rows.map(publicItemFromRow);
}

export async function createPromptQueueItem(input: {
  request: PromptQueueCreateRequest;
  authority: PromptQueueAuthority;
}): Promise<{ item: PromptQueueItemV1; created: boolean }> {
  const request = promptQueueCreateRequestSchema.parse(input.request);
  const promptSha256 = sha256(request.prompt);
  const target = promptQueueTargetV1Schema.parse(request.target);
  const targetSha256 = canonicalJsonSha256(target);
  const now = new Date().toISOString();
  const id = randomUUID();
  const sealedPrompt = sealJsonPayload(
    { prompt: request.prompt },
    promptBinding(
      input.authority.tenantId,
      input.authority.ownerActorId,
      id,
      promptSha256,
    ),
  );
  let existing: PromptQueueItemV1 | undefined;
  let preflightClosedGenerationRetries = 0;
  while (true) {
    try {
      existing = await preflightPromptQueueCreate({
        authority: input.authority,
        request,
        promptSha256,
        targetSha256,
      });
      break;
    } catch (error) {
      if (
        databaseFailureCode(error) === "DATABASE_CONNECTION_CLOSED" &&
        preflightClosedGenerationRetries === 0
      ) {
        // This transaction is database-only and read-only. The reservation
        // manager emits this exact code only before COMMIT, so no database
        // effect survived and one attempt on the replacement is safe. Unknown
        // COMMIT outcomes and every other failure remain non-replayable.
        preflightClosedGenerationRetries += 1;
        continue;
      }
      throw error;
    }
  }
  if (existing) return { item: existing, created: false };

  // Pin resolution may perform tenant-scoped database reads. Resolve and freeze
  // these values before reserving the queue transaction so a single-connection
  // runtime cannot deadlock itself. A pre-commit generation retry must also use
  // exactly the same routing decision.
  const resolvedPins = await resolvePins({
    tenantId: input.authority.tenantId,
    actorId: input.authority.requestActorId,
    prompt: request.prompt,
    mode: request.mode,
    agentId: request.agentId,
    executionTarget: target.executionTarget,
  });
  const pins = Object.freeze({
    agent: Object.freeze({ ...resolvedPins.agent }),
    model: Object.freeze({ ...resolvedPins.model }),
  });
  const createOnce = () => getSql().transaction(async (sql: QueueSql) => {
      // A row lock cannot protect an empty actor queue. Serialize the actor's
      // capacity check, position allocation, and insert so two devices cannot
      // both observe slot 40 as available.
      await lockActorPromptQueue(sql, input.authority);
      const existingRows = await sql`
        SELECT * FROM omni_prompt_queue_items
        WHERE tenant_id = ${input.authority.tenantId}
          AND owner_actor_id = ${input.authority.ownerActorId}
          AND client_correlation_id = ${request.clientCorrelationId}
        LIMIT 1
        FOR UPDATE
      `;
      if (existingRows[0]) {
        return {
          item: validateExistingPromptQueueCorrelation(
            existingRows[0],
            request,
            promptSha256,
            targetSha256,
          ),
          created: false,
        };
      }
      const countRows = await sql`
        SELECT COUNT(*)::INTEGER AS count
        FROM omni_prompt_queue_items
        WHERE tenant_id = ${input.authority.tenantId}
          AND owner_actor_id = ${input.authority.ownerActorId}
          AND state IN ('queued', 'paused', 'dispatching')
      `;
      if (Number(countRows[0]?.count || 0) >= PROMPT_QUEUE_MAX_ITEMS) {
        throw new PromptQueueStoreError(
          "capacity",
          "The prompt queue is full. Finish or remove an item before adding another.",
        );
      }
      const positionRows = await sql`
        SELECT COALESCE(MAX(position_key), 0)::BIGINT AS position
        FROM omni_prompt_queue_items
        WHERE tenant_id = ${input.authority.tenantId}
          AND owner_actor_id = ${input.authority.ownerActorId}
          AND state IN ('queued', 'paused', 'dispatching')
      `;
      const position = Number(positionRows[0]?.position || 0) + 1024;
      const rows = await sql`
        INSERT INTO omni_prompt_queue_items (
          schema_version, id, tenant_id, owner_actor_id,
          origin_session_id, last_modified_session_id, client_correlation_id,
          sealed_prompt, prompt_sha256, prompt_characters,
          mode, strategy, target, target_sha256, agent_pin, model_pin,
          state, position_key, lifecycle_revision,
          queue_grants_authority, created_at, updated_at
        ) VALUES (
          1, ${id}, ${input.authority.tenantId}, ${input.authority.ownerActorId},
          ${input.authority.sessionId}, ${input.authority.sessionId},
          ${request.clientCorrelationId}, ${sealedPrompt}::jsonb,
          ${promptSha256}, ${request.prompt.length}, ${request.mode},
          ${request.strategy}, ${target}::jsonb, ${targetSha256},
          ${pins.agent}::jsonb, ${pins.model}::jsonb,
          'queued', ${position}, 0, FALSE, ${now}, ${now}
        )
        RETURNING *
      `;
      const item = publicItemFromRow(rows[0]);
      await appendQueueEvent(
        sql,
        item,
        "command.prompt_queue.item.created",
        input.authority.executionScope,
      );
      return { item, created: true };
    }) as Promise<{ item: PromptQueueItemV1; created: boolean }>;

  let closedGenerationRetries = 0;
  while (true) {
    try {
      return await createOnce();
    } catch (error) {
      const code = databaseFailureCode(error);
      if (code === "DATABASE_CONNECTION_CLOSED" && closedGenerationRetries === 0) {
        // The reservation manager emits this code only while the transaction is
        // still active, before COMMIT. The dead connection rolls that attempt
        // back, so this actor-bound, correlation-idempotent create may make one
        // bounded attempt on the fresh exact pool generation.
        closedGenerationRetries += 1;
        continue;
      }
      if (code === "DATABASE_COMMIT_OUTCOME_UNKNOWN") {
        // Never replay an indeterminate COMMIT. Read the idempotency identity on
        // the fresh generation and acknowledge only an exact durable match.
        const reconciled = await reconcileUnknownPromptQueueCreate({
          authority: input.authority,
          request,
          promptSha256,
          targetSha256,
        });
        if (reconciled) return { item: reconciled, created: false };
      }
      throw error;
    }
  }
}

async function preflightPromptQueueCreate(input: {
  authority: PromptQueueAuthority;
  request: PromptQueueCreateRequest;
  promptSha256: string;
  targetSha256: string;
}) {
  return getSql().transaction(async (sql: QueueSql) => {
    // Serialize this cheap database-only check with creators for the same
    // actor. Correlation wins over capacity, including when a concurrent exact
    // duplicate is the item that fills the final queue slot.
    await lockActorPromptQueue(sql, input.authority);
    const existingRows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND client_correlation_id = ${input.request.clientCorrelationId}
      LIMIT 1
      FOR UPDATE
    `;
    if (existingRows[0]) {
      return validateExistingPromptQueueCorrelation(
        existingRows[0],
        input.request,
        input.promptSha256,
        input.targetSha256,
      );
    }
    const countRows = await sql`
      SELECT COUNT(*)::INTEGER AS count
      FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND state IN ('queued', 'paused', 'dispatching')
    `;
    if (Number(countRows[0]?.count || 0) >= PROMPT_QUEUE_MAX_ITEMS) {
      throw new PromptQueueStoreError(
        "capacity",
        "The prompt queue is full. Finish or remove an item before adding another.",
      );
    }
    return undefined;
  }) as Promise<PromptQueueItemV1 | undefined>;
}

async function readPromptQueueCorrelation(input: {
  authority: PromptQueueAuthority;
  request: PromptQueueCreateRequest;
  promptSha256: string;
  targetSha256: string;
}) {
  const rows = await getSql()`
    SELECT * FROM omni_prompt_queue_items
    WHERE tenant_id = ${input.authority.tenantId}
      AND owner_actor_id = ${input.authority.ownerActorId}
      AND client_correlation_id = ${input.request.clientCorrelationId}
    LIMIT 1
  `;
  return rows[0]
    ? validateExistingPromptQueueCorrelation(
        rows[0],
        input.request,
        input.promptSha256,
        input.targetSha256,
      )
    : undefined;
}

function validateExistingPromptQueueCorrelation(
  row: Record<string, unknown>,
  request: PromptQueueCreateRequest,
  promptSha256: string,
  targetSha256: string,
) {
  if (row.state === "deleted") {
    throw new PromptQueueStoreError(
      "conflict",
      "This offline queue identity belongs to a removed prompt. Create a new queue item instead.",
    );
  }
  const existing = publicItemFromRow(row);
  if (
    existing.promptSha256 !== promptSha256 ||
    existing.targetSha256 !== targetSha256 ||
    existing.mode !== request.mode ||
    existing.strategy !== request.strategy ||
    existing.agent.logicalAgentId !== request.agentId
  ) {
    throw new PromptQueueStoreError(
      "conflict",
      "This offline queue identity is already bound to different work.",
    );
  }
  return existing;
}

async function reconcileUnknownPromptQueueCreate(input: {
  authority: PromptQueueAuthority;
  request: PromptQueueCreateRequest;
  promptSha256: string;
  targetSha256: string;
}) {
  try {
    return await readPromptQueueCorrelation(input);
  } catch (error) {
    if (error instanceof PromptQueueStoreError) throw error;
    return undefined;
  }
}

function databaseFailureCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export async function updatePromptQueueItem(input: {
  itemId: string;
  expectedRevision: number;
  prompt?: string;
  state?: "queued" | "paused";
  authority: PromptQueueAuthority;
}): Promise<PromptQueueItemV1> {
  let replacementPins: Awaited<ReturnType<typeof resolvePins>> | undefined;
  let promptSha256: string | undefined;
  let sealedPrompt: ReturnType<typeof sealJsonPayload> | undefined;
  if (input.prompt !== undefined) {
    promptSha256 = sha256(input.prompt);
    const current = await readPromptQueueItem(input.itemId, input.authority);
    replacementPins = await resolvePins({
      tenantId: input.authority.tenantId,
      actorId: input.authority.requestActorId,
      prompt: input.prompt,
      mode: current.mode,
      agentId: current.agent.logicalAgentId,
      executionTarget: current.target.executionTarget,
    });
    sealedPrompt = sealJsonPayload(
      { prompt: input.prompt },
      promptBinding(
        input.authority.tenantId,
        input.authority.ownerActorId,
        input.itemId,
        promptSha256,
      ),
    );
  }
  return getSql().transaction(async (sql: QueueSql) => {
    await lockActorPromptQueue(sql, input.authority);
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
      LIMIT 1 FOR UPDATE
    `;
    if (!rows[0] || rows[0].state === "deleted") notFound();
    const current = publicItemFromRow(rows[0]);
    assertRevision(current, input.expectedRevision);
    if (!new Set(["queued", "paused", "failed"]).has(current.state)) {
      throw new PromptQueueStoreError(
        "invalid_state",
        "A dispatching or completed prompt cannot be edited.",
      );
    }
    if (input.state === "paused" && current.state !== "queued") {
      throw new PromptQueueStoreError("invalid_state", "Only a queued prompt can be paused.");
    }
    if (input.state === "queued" && current.state !== "paused" && current.state !== "failed") {
      throw new PromptQueueStoreError("invalid_state", "Only a paused or failed prompt can be resumed.");
    }
    const nextState = input.prompt !== undefined && current.state === "failed"
      ? "queued"
      : input.state || current.state;
    if (current.state === "failed" && nextState === "queued") {
      const countRows = await sql`
        SELECT COUNT(*)::INTEGER AS count
        FROM omni_prompt_queue_items
        WHERE tenant_id = ${input.authority.tenantId}
          AND owner_actor_id = ${input.authority.ownerActorId}
          AND state IN ('queued', 'paused', 'dispatching')
      `;
      if (Number(countRows[0]?.count || 0) >= PROMPT_QUEUE_MAX_ITEMS) {
        throw new PromptQueueStoreError(
          "capacity",
          "The prompt queue is full. Finish or remove an item before resuming this prompt.",
        );
      }
    }
    const now = new Date().toISOString();
    const changed = await sql`
      UPDATE omni_prompt_queue_items
      SET sealed_prompt = COALESCE(${sealedPrompt || null}::jsonb, sealed_prompt),
          prompt_sha256 = COALESCE(${promptSha256 || null}, prompt_sha256),
          prompt_characters = COALESCE(${input.prompt?.length || null}, prompt_characters),
          agent_pin = COALESCE(${replacementPins?.agent || null}::jsonb, agent_pin),
          model_pin = COALESCE(${replacementPins?.model || null}::jsonb, model_pin),
          state = ${nextState},
          run_id = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE run_id END,
          result_thread_id = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE result_thread_id END,
          progress_label = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE progress_label END,
          dispatch_token_sha256 = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE dispatch_token_sha256 END,
          dispatch_lease_expires_at = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE dispatch_lease_expires_at END,
          dispatched_at = CASE WHEN ${nextState} = 'queued' THEN NULL ELSE dispatched_at END,
          failure_code = NULL,
          terminal_at = CASE WHEN ${nextState} IN ('completed', 'deleted') THEN terminal_at ELSE NULL END,
          last_modified_session_id = ${input.authority.sessionId},
          lifecycle_revision = lifecycle_revision + 1,
          updated_at = ${now}
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
        AND lifecycle_revision = ${input.expectedRevision}
      RETURNING *
    `;
    if (!changed[0]) stale();
    const item = publicItemFromRow(changed[0]);
    await appendQueueEvent(sql, item, "command.prompt_queue.item.updated", input.authority.executionScope);
    return item;
  }) as Promise<PromptQueueItemV1>;
}

export async function deletePromptQueueItem(input: {
  itemId: string;
  expectedRevision: number;
  authority: PromptQueueAuthority;
}): Promise<void> {
  await getSql().transaction(async (sql: QueueSql) => {
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
      LIMIT 1 FOR UPDATE
    `;
    if (!rows[0] || rows[0].state === "deleted") notFound();
    const current = publicItemFromRow(rows[0]);
    assertRevision(current, input.expectedRevision);
    if (!new Set(["queued", "paused", "failed", "completed"]).has(current.state)) {
      throw new PromptQueueStoreError(
        "invalid_state",
        "A prompt already being dispatched cannot be removed.",
      );
    }
    const now = new Date().toISOString();
    const changed = await sql`
      UPDATE omni_prompt_queue_items
      SET state = 'deleted', sealed_prompt = NULL,
          dispatch_token_sha256 = NULL, dispatch_lease_expires_at = NULL,
          failure_code = NULL,
          last_modified_session_id = ${input.authority.sessionId},
          lifecycle_revision = lifecycle_revision + 1,
          updated_at = ${now}, terminal_at = COALESCE(terminal_at, ${now})
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
        AND lifecycle_revision = ${input.expectedRevision}
      RETURNING *
    `;
    if (!changed[0]) stale();
    await appendQueueEventFromRow(
      sql,
      changed[0],
      "command.prompt_queue.item.deleted",
      input.authority.executionScope,
    );
  });
}

export async function reorderPromptQueueItems(input: {
  items: readonly { id: string; expectedRevision: number }[];
  authority: PromptQueueAuthority;
}): Promise<PromptQueueItemV1[]> {
  return getSql().transaction(async (sql: QueueSql) => {
    // Share the actor-scoped allocator lock with creation so a new offline
    // item cannot appear between the exact-set check and the atomic reorder.
    await lockActorPromptQueue(sql, input.authority);
    const requestedIds = input.items.map((item) => item.id);
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND state IN ('queued', 'paused')
      ORDER BY position_key, created_at, id
      FOR UPDATE
    `;
    const active = rows.map(publicItemFromRow);
    if (
      active.length !== requestedIds.length ||
      active.some((item) => !requestedIds.includes(item.id))
    ) {
      throw new PromptQueueStoreError(
        "conflict",
        "The queue changed before this reorder. Refresh and try again.",
      );
    }
    const byId = new Map(active.map((item) => [item.id, item]));
    for (const requested of input.items) {
      const current = byId.get(requested.id);
      if (!current || current.lifecycleRevision !== requested.expectedRevision) stale();
    }
    const now = new Date().toISOString();
    const result: PromptQueueItemV1[] = [];
    for (let index = 0; index < input.items.length; index += 1) {
      const requested = input.items[index];
      const changed = await sql`
        UPDATE omni_prompt_queue_items
        SET position_key = ${(index + 1) * 1024},
            last_modified_session_id = ${input.authority.sessionId},
            lifecycle_revision = lifecycle_revision + 1,
            updated_at = ${now}
        WHERE tenant_id = ${input.authority.tenantId}
          AND owner_actor_id = ${input.authority.ownerActorId}
          AND id = ${requested.id}
          AND lifecycle_revision = ${requested.expectedRevision}
        RETURNING *
      `;
      if (!changed[0]) stale();
      const item = publicItemFromRow(changed[0]);
      result.push(item);
      await appendQueueEvent(
        sql,
        item,
        "command.prompt_queue.item.reordered",
        input.authority.executionScope,
      );
    }
    return result;
  }) as Promise<PromptQueueItemV1[]>;
}

export async function claimPromptQueueDispatch(input: {
  itemId: string;
  expectedRevision: number;
  force: boolean;
  authority: PromptQueueAuthority;
}): Promise<ClaimedPromptQueueDispatch> {
  const current = await readPromptQueueItem(input.itemId, input.authority);
  assertRevision(current, input.expectedRevision);
  if (current.state !== "queued" && !(input.force && current.state === "paused")) {
    throw new PromptQueueStoreError(
      "invalid_state",
      input.force
        ? "Only a queued or paused prompt can run now."
        : "Automatic dispatch requires a queued prompt.",
    );
  }
  await assertCurrentPins(current, input.authority);
  const dispatchToken = randomBytes(32).toString("base64url");
  const tokenSha256 = sha256(dispatchToken);
  const now = new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + PROMPT_QUEUE_DISPATCH_LEASE_MS,
  ).toISOString();
  return getSql().transaction(async (sql: QueueSql) => {
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
      LIMIT 1 FOR UPDATE
    `;
    if (!rows[0] || rows[0].state === "deleted") notFound();
    const locked = publicItemFromRow(rows[0]);
    assertRevision(locked, input.expectedRevision);
    if (locked.state !== "queued" && !(input.force && locked.state === "paused")) {
      throw new PromptQueueStoreError("invalid_state", "This prompt is no longer ready to dispatch.");
    }
    if (
      locked.agent.definitionSha256 !== current.agent.definitionSha256 ||
      locked.agent.principalSha256 !== current.agent.principalSha256 ||
      locked.model.routingPolicySha256 !== current.model.routingPolicySha256 ||
      locked.promptSha256 !== current.promptSha256
    ) stale();
    const changed = await sql`
      UPDATE omni_prompt_queue_items
      SET state = 'dispatching',
          run_id = NULL,
          result_thread_id = NULL,
          failure_code = NULL,
          terminal_at = NULL,
          dispatch_token_sha256 = ${tokenSha256},
          dispatch_lease_expires_at = ${leaseExpiresAt},
          dispatched_at = ${now.toISOString()},
          progress_label = 'Entering governed execution',
          last_modified_session_id = ${input.authority.sessionId},
          lifecycle_revision = lifecycle_revision + 1,
          updated_at = ${now.toISOString()}
      WHERE tenant_id = ${input.authority.tenantId}
        AND owner_actor_id = ${input.authority.ownerActorId}
        AND id = ${input.itemId}
        AND lifecycle_revision = ${input.expectedRevision}
      RETURNING *
    `;
    if (!changed[0]) stale();
    const item = publicItemFromRow(changed[0]);
    await appendQueueEvent(sql, item, "command.prompt_queue.item.dispatching", input.authority.executionScope);
    return { item, dispatchToken };
  }) as Promise<ClaimedPromptQueueDispatch>;
}

export async function validatePromptQueueDispatch(input: {
  itemId: string;
  dispatchToken: string;
  tenantId: string;
  ownerActorId: string;
  sessionId: string;
  request: {
    message: string;
    mode?: string;
    strategy?: string;
    agentId?: string;
    threadId?: string;
    missionId?: string;
    projectId?: string;
    computerUseTarget?: string;
  };
}): Promise<PromptQueueItemV1> {
  const candidateRows = await getSql()`
    SELECT * FROM omni_prompt_queue_items
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND id = ${input.itemId}
      AND state = 'dispatching'
      AND dispatch_token_sha256 = ${sha256(input.dispatchToken)}
      AND dispatch_lease_expires_at > NOW()
      AND last_modified_session_id = ${input.sessionId}
      AND progress_label = 'Entering governed execution'
    LIMIT 1
  `;
  if (!candidateRows[0]) {
    throw new PromptQueueStoreError(
      "conflict",
      "This queue dispatch is no longer current.",
    );
  }
  const candidate = publicItemFromRow(candidateRows[0]);
  const exactRequest = {
    message: input.request.message,
    mode: input.request.mode || "orchestrate",
    strategy: input.request.strategy || "direct",
    agentId: input.request.agentId || "atlas",
    threadId: input.request.threadId || null,
    missionId: input.request.missionId || null,
    projectId: input.request.projectId || null,
    computerUseTarget: input.request.computerUseTarget || null,
  };
  const expectedRequest = {
    message: candidate.prompt,
    mode: candidate.mode,
    strategy: candidate.strategy,
    agentId: candidate.agent.logicalAgentId,
    threadId: candidate.target.threadId,
    missionId: candidate.target.missionId,
    projectId: candidate.target.projectId,
    computerUseTarget: candidate.target.executionTarget === "local_macos"
      ? "local_macos"
      : null,
  };
  if (canonicalJsonSha256(exactRequest) !== canonicalJsonSha256(expectedRequest)) {
    throw new PromptQueueStoreError(
      "conflict",
      "The governed command no longer matches its queued intent.",
    );
  }
  // The admission marker is consumed exactly once only after the request has
  // matched its sealed intent. The hashed token remains for progress receipts;
  // concurrent or replayed internal headers cannot start a second run.
  const admissionLeaseExpiresAt = new Date(
    Date.now() + PROMPT_QUEUE_DISPATCH_LEASE_MS,
  ).toISOString();
  const admittedRows = await getSql()`
    UPDATE omni_prompt_queue_items
    SET progress_label = 'Governed execution admitted',
        dispatch_lease_expires_at = ${admissionLeaseExpiresAt},
        lifecycle_revision = lifecycle_revision + 1,
        updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND id = ${input.itemId}
      AND state = 'dispatching'
      AND dispatch_token_sha256 = ${sha256(input.dispatchToken)}
      AND dispatch_lease_expires_at > NOW()
      AND last_modified_session_id = ${input.sessionId}
      AND progress_label = 'Entering governed execution'
    RETURNING *
  `;
  if (!admittedRows[0]) {
    throw new PromptQueueStoreError(
      "conflict",
      "This queue dispatch was already admitted or is no longer current.",
    );
  }
  return publicItemFromRow(admittedRows[0]);
}

/**
 * Reconcile an interrupted dispatch without replaying its command. A run id is
 * durable proof that normal governed execution accepted the command, but is
 * not proof that the run finished. Active, waiting, or temporarily unreadable
 * runs retain a bounded dispatch lease; only a terminal run closes the queue
 * item. A lease with no run id fails closed and may be explicitly resumed.
 */
export async function reconcileExpiredPromptQueueDispatches(
  authority: PromptQueueAuthority,
): Promise<number> {
  return getSql().transaction(async (sql: QueueSql) => {
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.ownerActorId}
        AND state = 'dispatching'
        AND dispatch_lease_expires_at <= NOW()
      ORDER BY dispatch_lease_expires_at, id
      LIMIT ${PROMPT_QUEUE_MAX_ITEMS}
      FOR UPDATE
    `;
    let reconciled = 0;
    for (const row of rows) {
      const accepted = Boolean(row.run_id);
      const runRows = accepted
        ? await sql`
            SELECT status, thread_id
            FROM omni_agent_runs
            WHERE tenant_id = ${authority.tenantId}
              AND owner_actor_id IN (
                ${authority.ownerActorId},
                ${authority.requestActorId}
              )
              AND id = ${String(row.run_id)}
            LIMIT 1
          `
        : [];
      const runStatus = typeof runRows[0]?.status === "string"
        ? String(runRows[0].status)
        : undefined;
      const now = new Date().toISOString();
      const waitingAccepted =
        runStatus === "waiting_approval" ||
        runStatus === "waiting_clarification";
      const terminalRun =
        runStatus === "completed" ||
        runStatus === "failed" ||
        runStatus === "canceled";
      const orphanConfirmationExpired = accepted && !waitingAccepted &&
        !terminalRun &&
        dispatchAgeMs(row, now) >=
          PROMPT_QUEUE_ORPHAN_CONFIRMATION_MAX_AGE_MS;
      if (
        accepted &&
        !terminalRun &&
        !waitingAccepted &&
        !orphanConfirmationExpired
      ) {
        const leaseExpiresAt = new Date(
          Date.parse(now) + PROMPT_QUEUE_DISPATCH_LEASE_MS,
        ).toISOString();
        const changed = await sql`
          UPDATE omni_prompt_queue_items
          SET result_thread_id = COALESCE(
                ${runRows[0]?.thread_id ? String(runRows[0].thread_id) : null},
                result_thread_id
              ),
              progress_label = ${runStatus
                ? "Governed run is still active"
                : "Verifying governed run status"},
              dispatch_lease_expires_at = ${leaseExpiresAt},
              lifecycle_revision = lifecycle_revision + 1,
              updated_at = ${now}
          WHERE tenant_id = ${authority.tenantId}
            AND owner_actor_id = ${authority.ownerActorId}
            AND id = ${String(row.id)}
            AND state = 'dispatching'
            AND dispatch_lease_expires_at <= NOW()
          RETURNING *
        `;
        if (!changed[0]) continue;
        reconciled += 1;
        await appendQueueEventFromRow(
          sql,
          changed[0],
          "command.prompt_queue.item.progressed",
          authority.executionScope,
        );
        continue;
      }
      const terminalState = runStatus === "completed" || waitingAccepted
        ? "completed"
        : "failed";
      const changed = await sql`
        UPDATE omni_prompt_queue_items
        SET state = ${terminalState},
            result_thread_id = COALESCE(
              ${runRows[0]?.thread_id ? String(runRows[0].thread_id) : null},
              result_thread_id
            ),
            progress_label = ${runStatus === "completed"
              ? "Governed run completed"
              : runStatus === "waiting_approval"
                ? "Accepted and waiting for approval"
                : runStatus === "waiting_clarification"
                  ? "Accepted and waiting for clarification"
                  : orphanConfirmationExpired
                    ? "Governed run outcome could not be confirmed"
              : accepted
                ? "Governed run failed"
              : "Dispatch expired before a governed run was accepted"},
            failure_code = ${terminalState === "completed"
              ? null
              : orphanConfirmationExpired
                ? "run_outcome_unconfirmed"
              : accepted
                ? runStatus === "canceled" ? "run_canceled" : "run_failed"
              : "dispatch_lease_expired_before_acceptance"},
            dispatch_token_sha256 = NULL,
            dispatch_lease_expires_at = NULL,
            terminal_at = ${now},
            lifecycle_revision = lifecycle_revision + 1,
            updated_at = ${now}
        WHERE tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.ownerActorId}
          AND id = ${String(row.id)}
          AND state = 'dispatching'
          AND dispatch_lease_expires_at <= NOW()
        RETURNING *
      `;
      if (!changed[0]) continue;
      reconciled += 1;
      await appendQueueEventFromRow(
        sql,
        changed[0],
        terminalState === "completed"
          ? "command.prompt_queue.item.completed"
          : "command.prompt_queue.item.failed",
        authority.executionScope,
      );
    }
    return reconciled;
  }) as Promise<number>;
}

export async function recordPromptQueueDispatchProgress(input: {
  itemId: string;
  dispatchToken: string;
  tenantId: string;
  ownerActorId: string;
  runId?: string;
  threadId?: string;
  progressLabel?: string;
  terminal?: "completed" | "failed";
  failureCode?: string;
  executionScope: ExecutionScope;
}): Promise<PromptQueueDispatchProgressResult> {
  return getSql().transaction(async (sql: QueueSql) => {
    const rows = await sql`
      SELECT * FROM omni_prompt_queue_items
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.ownerActorId}
        AND id = ${input.itemId}
        AND state = 'dispatching'
        AND dispatch_token_sha256 = ${sha256(input.dispatchToken)}
      LIMIT 1 FOR UPDATE
    `;
    if (!rows[0]) return { status: "stale" as const };
    const now = new Date().toISOString();
    const refreshedLeaseExpiresAt = new Date(
      Date.parse(now) + PROMPT_QUEUE_DISPATCH_LEASE_MS,
    ).toISOString();
    const terminal = input.terminal || null;
    const changed = await sql`
      UPDATE omni_prompt_queue_items
      SET run_id = COALESCE(${input.runId || null}, run_id),
          result_thread_id = COALESCE(${input.threadId || null}, result_thread_id),
          progress_label = COALESCE(${input.progressLabel?.slice(0, 160) || null}, progress_label),
          state = COALESCE(${terminal}, state),
          failure_code = CASE
            WHEN ${terminal} = 'failed'
              THEN ${input.failureCode?.slice(0, 240) || "dispatch_failed"}
            WHEN ${terminal} = 'completed' THEN NULL
            ELSE failure_code
          END,
          dispatch_token_sha256 = CASE WHEN ${terminal} IS NULL THEN dispatch_token_sha256 ELSE NULL END,
          dispatch_lease_expires_at = CASE
            WHEN ${terminal} IS NULL THEN ${refreshedLeaseExpiresAt}::timestamptz
            ELSE NULL
          END,
          terminal_at = CASE WHEN ${terminal} IS NULL THEN terminal_at ELSE ${now} END,
          lifecycle_revision = lifecycle_revision + 1,
          updated_at = ${now}
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.ownerActorId}
        AND id = ${input.itemId}
      RETURNING *
    `;
    if (!changed[0]) return { status: "stale" as const };
    await appendQueueEventFromRow(
      sql,
      changed[0],
      terminal
        ? `command.prompt_queue.item.${terminal}`
        : "command.prompt_queue.item.progressed",
      input.executionScope,
    );
    return { status: "applied" as const };
  }) as Promise<PromptQueueDispatchProgressResult>;
}

/**
 * Read the exact queue fence after an indeterminate receipt write. This helper
 * never mutates or broadens authority: it acknowledges an already-matching
 * receipt, or proves that one bounded retry is safe because the same raw-token
 * capability still owns an unchanged dispatching row.
 */
export async function inspectPromptQueueDispatchReceipt(input: {
  itemId: string;
  dispatchToken: string;
  tenantId: string;
  ownerActorId: string;
  runId?: string;
  threadId?: string;
  progressLabel?: string;
  terminal?: "completed" | "failed";
  failureCode?: string;
}): Promise<PromptQueueDispatchReceiptInspection> {
  const rows = await getSql()`
    SELECT state, dispatch_token_sha256, run_id, result_thread_id,
           progress_label, failure_code
    FROM omni_prompt_queue_items
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND id = ${input.itemId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { status: "stale" };

  if (dispatchReceiptMatches(row, input)) {
    return { status: "applied" };
  }
  if (
    String(row.state) === "dispatching" &&
    String(row.dispatch_token_sha256 || "") === sha256(input.dispatchToken) &&
    dispatchReceiptCoordinatesAreCompatible(row, input)
  ) {
    return { status: "retryable" };
  }
  return { status: "stale" };
}

async function readPromptQueueItem(
  itemId: string,
  authority: Pick<PromptQueueAuthority, "tenantId" | "ownerActorId">,
) {
  const rows = await getSql()`
    SELECT * FROM omni_prompt_queue_items
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${authority.ownerActorId}
      AND id = ${itemId}
      AND state <> 'deleted'
    LIMIT 1
  `;
  if (!rows[0]) notFound();
  return publicItemFromRow(rows[0]);
}

async function resolvePins(input: {
  tenantId: string;
  actorId: string;
  prompt: string;
  mode: "orchestrate" | "research" | "execute" | "learn";
  agentId: string;
  executionTarget: "asael" | "local_macos";
}) {
  const identity = await resolveAgentIdentityForExecution({
    tenantId: input.tenantId,
    actorId: input.actorId,
    agentId: input.agentId,
  });
  const computerUse = input.executionTarget === "local_macos";
  const deployment = selectAgentModel({
    message: input.prompt,
    mode: input.mode,
    modelPolicy: identity.definition.modelPolicy,
  });
  const runtime = await resolveRuntimeModelAssignment({
    tenantId: input.tenantId,
    actorId: input.actorId,
    scope: modelAssignmentScopeForAgent(input.agentId, computerUse),
    tier: deployment.tier,
    requiredFeature: "tools",
    requiredFeatures: computerUse ? ["vision"] : undefined,
    deploymentFallback: {
      provider: deployment.provider,
      model: deployment.model,
      fallbackModel: deployment.fallbackModel,
      reason: deployment.reason,
    },
  });
  if (!runtime.configured || !runtime.provider || !runtime.model) {
    throw new PromptQueueStoreError(
      "model_drift",
      "The configured model route is unavailable, so this prompt was not queued.",
    );
  }
  const agent = agentPin(identity);
  const modelBase = {
    providerId: runtime.provider,
    modelId: runtime.model,
    tier: deployment.tier,
    assignmentId: runtime.assignmentId || null,
    assignmentRevision: runtime.assignmentRevision || null,
    assignmentConfigurationSha256: runtime.assignmentConfigurationSha256 || null,
  };
  const model = promptQueueModelPinV1Schema.parse({
    ...modelBase,
    routingPolicySha256: runtimeModelRoutingPolicySha256({
      scope: runtime.scope,
      source: runtime.source,
      ...modelBase,
    }),
  });
  return { agent, model };
}

async function assertCurrentPins(
  item: PromptQueueItemV1,
  authority: Pick<PromptQueueAuthority, "tenantId" | "requestActorId">,
) {
  const current = await resolvePins({
    tenantId: authority.tenantId,
    actorId: authority.requestActorId,
    prompt: item.prompt,
    mode: item.mode,
    agentId: item.agent.logicalAgentId,
    executionTarget: item.target.executionTarget,
  });
  if (
    current.agent.definitionVersionId !== item.agent.definitionVersionId ||
    current.agent.definitionSha256 !== item.agent.definitionSha256 ||
    current.agent.principalVersionId !== item.agent.principalVersionId ||
    current.agent.principalSha256 !== item.agent.principalSha256
  ) {
    throw new PromptQueueStoreError(
      "identity_drift",
      "The assigned Agent changed after this prompt was queued. Edit the prompt to review and pin the current Agent.",
    );
  }
  if (current.model.routingPolicySha256 !== item.model.routingPolicySha256) {
    throw new PromptQueueStoreError(
      "model_drift",
      "The configured model route changed after this prompt was queued. Edit the prompt to review and pin the current route.",
    );
  }
}

function publicItemFromRow(row: Record<string, unknown>): PromptQueueItemV1 {
  const id = String(row.id || "");
  const promptSha256 = String(row.prompt_sha256 || "");
  const opened = openJsonPayload(
    row.sealed_prompt,
    promptBinding(
      String(row.tenant_id || ""),
      String(row.owner_actor_id || ""),
      id,
      promptSha256,
    ),
  );
  const prompt = typeof opened === "object" && opened &&
      typeof (opened as { prompt?: unknown }).prompt === "string"
    ? (opened as { prompt: string }).prompt
    : "";
  return promptQueueItemV1Schema.parse({
    schemaVersion: Number(row.schema_version),
    id,
    clientCorrelationId: row.client_correlation_id,
    originSessionId: row.origin_session_id,
    lastModifiedSessionId: row.last_modified_session_id,
    prompt,
    promptSha256,
    mode: row.mode,
    strategy: row.strategy,
    target: row.target,
    targetSha256: row.target_sha256,
    agent: row.agent_pin,
    model: row.model_pin,
    state: row.state,
    position: Number(row.position_key),
    lifecycleRevision: Number(row.lifecycle_revision),
    runId: row.run_id || null,
    resultThreadId: row.result_thread_id || null,
    progressLabel: row.progress_label || null,
    failureCode: row.failure_code || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    dispatchedAt: nullableIso(row.dispatched_at),
    terminalAt: nullableIso(row.terminal_at),
    queueGrantsAuthority: Boolean(row.queue_grants_authority),
  });
}

function agentPin(identity: ResolvedAgentIdentityV1): PromptQueueAgentPinV1 {
  return promptQueueAgentPinV1Schema.parse({
    logicalAgentId: identity.definition.logicalAgentId,
    definitionId: identity.definition.definitionId,
    definitionVersion: identity.definition.definitionVersion,
    definitionVersionId: identity.definition.definitionVersionId,
    definitionSha256: identity.definition.definitionSha256,
    principalId: identity.principal.principalId,
    principalGeneration: identity.principal.principalGeneration,
    principalVersionId: identity.principal.principalVersionId,
    principalSha256: identity.principal.principalSha256,
  });
}

function promptBinding(
  tenantId: string,
  actorId: string,
  itemId: string,
  promptSha256: string,
) {
  return `prompt-queue:v1:${tenantId}:${actorId}:${itemId}:${promptSha256}`;
}

async function lockActorPromptQueue(
  sql: QueueSql,
  authority: Pick<PromptQueueAuthority, "tenantId" | "ownerActorId">,
) {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`prompt-queue:v1:${authority.tenantId}:${authority.ownerActorId}`},
        0
      )
    )
  `;
}

async function appendQueueEvent(
  sql: QueueSql,
  item: PromptQueueItemV1,
  type: string,
  executionScope: ExecutionScope,
) {
  return appendScopedDomainEvent({
    id: `${type}:${item.id}:${item.lifecycleRevision}`,
    streamId: `prompt-queue:${item.id}`,
    type,
    executionScope,
    payload: eventPayload(item),
  }, { sql });
}

async function appendQueueEventFromRow(
  sql: QueueSql,
  row: Record<string, unknown>,
  type: string,
  executionScope: ExecutionScope,
) {
  const target = promptQueueTargetV1Schema.parse(row.target);
  const agent = promptQueueAgentPinV1Schema.parse(row.agent_pin);
  const model = promptQueueModelPinV1Schema.parse(row.model_pin);
  return appendScopedDomainEvent({
    id: `${type}:${String(row.id)}:${Number(row.lifecycle_revision)}`,
    streamId: `prompt-queue:${String(row.id)}`,
    type,
    executionScope,
    payload: {
      schemaVersion: 1,
      queueItemId: String(row.id),
      lifecycleRevision: Number(row.lifecycle_revision),
      state: String(row.state),
      promptSha256: String(row.prompt_sha256),
      targetSha256: String(row.target_sha256),
      agentDefinitionVersionId: agent.definitionVersionId,
      agentPrincipalVersionId: agent.principalVersionId,
      modelRoutingPolicySha256: model.routingPolicySha256,
      executionTarget: target.executionTarget,
      runId: row.run_id ? String(row.run_id) : null,
      queueGrantsAuthority: false,
    },
  }, { sql });
}

function eventPayload(item: PromptQueueItemV1) {
  return {
    schemaVersion: 1,
    queueItemId: item.id,
    lifecycleRevision: item.lifecycleRevision,
    state: item.state,
    promptSha256: item.promptSha256,
    targetSha256: item.targetSha256,
    agentDefinitionVersionId: item.agent.definitionVersionId,
    agentPrincipalVersionId: item.agent.principalVersionId,
    modelRoutingPolicySha256: item.model.routingPolicySha256,
    executionTarget: item.target.executionTarget,
    runId: item.runId,
    queueGrantsAuthority: false,
  };
}

function assertRevision(item: PromptQueueItemV1, expectedRevision: number) {
  if (item.lifecycleRevision !== expectedRevision) stale();
}

function notFound(): never {
  throw new PromptQueueStoreError("not_found", "Prompt queue item not found.");
}

function stale(): never {
  throw new PromptQueueStoreError(
    "conflict",
    "The prompt queue changed on another device. Refresh and review the latest order.",
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dispatchAgeMs(row: Record<string, unknown>, now: string) {
  const startedAt = Date.parse(String(row.dispatched_at || row.created_at || ""));
  const current = Date.parse(now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(current)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, current - startedAt);
}

function dispatchReceiptMatches(
  row: Record<string, unknown>,
  input: {
    runId?: string;
    threadId?: string;
    progressLabel?: string;
    terminal?: "completed" | "failed";
    failureCode?: string;
  },
) {
  const expectedState = input.terminal || "dispatching";
  if (String(row.state || "") !== expectedState) return false;
  if (nullableString(row.run_id) !== (input.runId || null)) return false;
  if (nullableString(row.result_thread_id) !== (input.threadId || null)) {
    return false;
  }
  if (
    input.progressLabel !== undefined &&
    nullableString(row.progress_label) !== input.progressLabel.slice(0, 160)
  ) {
    return false;
  }
  if (input.terminal === "completed") {
    return nullableString(row.failure_code) === null;
  }
  if (input.terminal === "failed") {
    return nullableString(row.failure_code) ===
      (input.failureCode?.slice(0, 240) || "dispatch_failed");
  }
  return true;
}

function dispatchReceiptCoordinatesAreCompatible(
  row: Record<string, unknown>,
  input: { runId?: string; threadId?: string },
) {
  const storedRunId = nullableString(row.run_id);
  const storedThreadId = nullableString(row.result_thread_id);
  return (
    (!storedRunId || storedRunId === (input.runId || null)) &&
    (!storedThreadId || storedThreadId === (input.threadId || null))
  );
}

function nullableString(value: unknown) {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function iso(value: unknown) {
  return new Date(String(value)).toISOString();
}

function nullableIso(value: unknown) {
  return value ? iso(value) : null;
}
