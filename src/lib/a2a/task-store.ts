import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  buildA2AExchangeV1,
  parseA2AExchangeV1,
  type A2AExchangeV1,
} from "@/lib/a2a/exchange";
import {
  buildA2ATaskMappingV1,
  parseA2ATaskMappingV1,
  type A2ATaskMappingV1,
} from "@/lib/a2a/task-mapping";
import type { A2APeerRolloutV1 } from "@/lib/a2a/rollout";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { getDelegationTask } from "@/lib/delegation/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";

type A2ASql = ReturnType<typeof getSql>;

export class A2ATaskStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "A2ATaskStoreError";
  }
}

export async function createA2ATaskMapping(input: {
  rollout: A2APeerRolloutV1;
  direction: A2ATaskMappingV1["direction"];
  externalTaskId: string;
  externalContextId: string;
  internalTask: DelegationTaskV1;
  localAgentId: A2ATaskMappingV1["localAgentId"];
  localAgentDefinitionVersion: number;
  negotiatedSkillId: string;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertScope(input.executionScope, input.rollout.tenantId, input.rollout.ownerActorId);
  if (
    input.internalTask.tenantId !== input.rollout.tenantId ||
    input.internalTask.ownerActorId !== input.rollout.ownerActorId ||
    (input.direction === "inbound" && (
      input.internalTask.delegateAgentId !== input.localAgentId ||
      input.internalTask.delegateDefinitionVersion !== input.localAgentDefinitionVersion
    )) ||
    (input.direction === "outbound" &&
      !input.rollout.allowedSkillIds.includes(input.negotiatedSkillId))
  ) {
    throw new A2ATaskStoreError("The A2A mapping does not match its canonical delegation task.", 409);
  }
  const mapping = buildA2ATaskMappingV1({
    tenantId: input.rollout.tenantId,
    ownerActorId: input.rollout.ownerActorId,
    peerId: input.rollout.peerId,
    rolloutId: input.rollout.rolloutId,
    rolloutSha256: input.rollout.rolloutSha256,
    direction: input.direction,
    externalTaskId: input.externalTaskId,
    externalContextId: input.externalContextId,
    internalTaskId: input.internalTask.taskId,
    internalDelegationId: input.internalTask.delegationId,
    internalContractSha256: input.internalTask.contractSha256,
    localAgentId: input.localAgentId,
    localAgentDefinitionVersion: input.localAgentDefinitionVersion,
    negotiatedSkillId: input.negotiatedSkillId,
    createdAt: new Date().toISOString(),
  });
  return getSql().transaction(async (sql: A2ASql) => {
    const rows = await sql`
      INSERT INTO omni_a2a_task_mappings (
        schema_version, tenant_id, owner_actor_id, mapping_id,
        mapping_sha256, peer_id, rollout_id, rollout_sha256, direction,
        external_task_id, external_context_id, internal_task_id,
        internal_delegation_id, internal_contract_sha256, local_agent_id,
        local_agent_definition_version, negotiated_skill_id, mapping, created_at
      ) VALUES (
        1, ${mapping.tenantId}, ${mapping.ownerActorId}, ${mapping.mappingId},
        ${mapping.mappingSha256}, ${mapping.peerId}, ${mapping.rolloutId},
        ${mapping.rolloutSha256}, ${mapping.direction},
        ${mapping.externalTaskId}, ${mapping.externalContextId},
        ${mapping.internalTaskId}, ${mapping.internalDelegationId},
        ${mapping.internalContractSha256}, ${mapping.localAgentId},
        ${mapping.localAgentDefinitionVersion}, ${mapping.negotiatedSkillId},
        ${mapping}::jsonb, ${mapping.createdAt}
      )
      ON CONFLICT (tenant_id, mapping_id) DO NOTHING
      RETURNING mapping
    `;
    const saved = rows[0]
      ? parseA2ATaskMappingV1(rows[0].mapping)
      : await readMapping(sql, {
          tenantId: mapping.tenantId,
          ownerActorId: mapping.ownerActorId,
          peerId: mapping.peerId,
          externalTaskId: mapping.externalTaskId,
        });
    if (saved.mappingSha256 !== mapping.mappingSha256) {
      throw new A2ATaskStoreError("The A2A task mapping is already bound to different work.", 409);
    }
    await appendMappingEvent(sql, saved, input.executionScope);
    return saved;
  }) as Promise<A2ATaskMappingV1>;
}

export async function appendA2AExchange(input: {
  mapping: A2ATaskMappingV1;
  direction: A2AExchangeV1["direction"];
  payload: A2AExchangeV1["payload"];
  executionScope: ExecutionScope;
  createdAt?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertScope(input.executionScope, input.mapping.tenantId, input.mapping.ownerActorId);
  const exchange = buildA2AExchangeV1({
    tenantId: input.mapping.tenantId,
    ownerActorId: input.mapping.ownerActorId,
    peerId: input.mapping.peerId,
    mappingId: input.mapping.mappingId,
    externalTaskId: input.mapping.externalTaskId,
    direction: input.direction,
    payload: input.payload,
    createdAt: input.createdAt || new Date().toISOString(),
  });
  return getSql().transaction(async (sql: A2ASql) => {
    const rows = await sql`
      INSERT INTO omni_a2a_exchanges (
        schema_version, tenant_id, owner_actor_id, exchange_id,
        exchange_sha256, mapping_id, peer_id, external_task_id,
        direction, payload_type, payload_sha256, payload, exchange, created_at
      ) VALUES (
        1, ${exchange.tenantId}, ${exchange.ownerActorId},
        ${exchange.exchangeId}, ${exchange.exchangeSha256},
        ${exchange.mappingId}, ${exchange.peerId}, ${exchange.externalTaskId},
        ${exchange.direction}, ${exchange.payload.type},
        ${exchange.payloadSha256}, ${exchange.payload}::jsonb,
        ${exchange}::jsonb, ${exchange.createdAt}
      )
      ON CONFLICT (tenant_id, exchange_id) DO NOTHING
      RETURNING exchange
    `;
    let saved = exchange;
    if (rows[0]) saved = parseA2AExchangeV1(rows[0].exchange);
    await appendExchangeEvent(sql, saved, input.executionScope);
    return saved;
  }) as Promise<A2AExchangeV1>;
}

export async function getA2ATaskMapping(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  externalTaskId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return readMapping(getSql(), input);
}

export async function listA2ATaskMappings(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  contextId?: string;
  limit?: number;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const limit = Math.max(1, Math.min(input.limit || 50, 100));
  const rows = input.contextId
    ? await getSql()`
        SELECT mapping FROM omni_a2a_task_mappings
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id = ${input.ownerActorId}
          AND peer_id = ${input.peerId}
          AND external_context_id = ${input.contextId}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    : await getSql()`
        SELECT mapping FROM omni_a2a_task_mappings
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id = ${input.ownerActorId}
          AND peer_id = ${input.peerId}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
  return rows.map((row) => parseA2ATaskMappingV1(row.mapping));
}

export async function readA2ATaskProjection(input: {
  mapping: A2ATaskMappingV1;
  historyLength?: number;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const [task, rows] = await Promise.all([
    getDelegationTask({
      tenantId: input.mapping.tenantId,
      ownerActorId: input.mapping.ownerActorId,
      taskId: input.mapping.internalTaskId,
    }),
    getSql()`
      SELECT exchange FROM omni_a2a_exchanges
      WHERE tenant_id = ${input.mapping.tenantId}
        AND owner_actor_id = ${input.mapping.ownerActorId}
        AND mapping_id = ${input.mapping.mappingId}
      ORDER BY created_at ASC, exchange_id ASC
      LIMIT 200
    `,
  ]);
  const exchanges = rows.map((row) => parseA2AExchangeV1(row.exchange));
  const history = exchanges
    .filter((exchange) => exchange.payload.type === "message")
    .map((exchange) => exchange.payload.type === "message" ? exchange.payload.message : neverValue())
    .slice(-Math.max(0, Math.min(input.historyLength ?? 50, 50)));
  const artifacts = exchanges
    .filter((exchange) => exchange.payload.type === "artifact")
    .map((exchange) => exchange.payload.type === "artifact" ? exchange.payload.artifact : neverValue())
    .slice(-32);
  return { task, history, artifacts, exchanges } as const;
}

async function readMapping(
  sql: A2ASql,
  input: { tenantId: string; ownerActorId: string; peerId: string; externalTaskId: string },
) {
  const rows = await sql`
    SELECT mapping FROM omni_a2a_task_mappings
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND peer_id = ${input.peerId}
      AND external_task_id = ${input.externalTaskId}
    LIMIT 1
  `;
  if (rows.length !== 1) throw new A2ATaskStoreError("The A2A task was not found.", 404);
  return parseA2ATaskMappingV1(rows[0].mapping);
}

function appendMappingEvent(sql: A2ASql, mapping: A2ATaskMappingV1, executionScope: ExecutionScope) {
  return appendScopedDomainEvent({
    id: `a2a-task-mapped:${mapping.mappingSha256}`,
    streamId: `a2a-task:${mapping.externalTaskId}`,
    type: "a2a.task.mapped",
    payload: {
      version: mapping.version,
      mappingId: mapping.mappingId,
      mappingSha256: mapping.mappingSha256,
      peerId: mapping.peerId,
      rolloutId: mapping.rolloutId,
      rolloutSha256: mapping.rolloutSha256,
      direction: mapping.direction,
      externalTaskId: mapping.externalTaskId,
      externalContextId: mapping.externalContextId,
      internalTaskId: mapping.internalTaskId,
      internalDelegationId: mapping.internalDelegationId,
      internalContractSha256: mapping.internalContractSha256,
      localAgentId: mapping.localAgentId,
      localAgentDefinitionVersion: mapping.localAgentDefinitionVersion,
      negotiatedSkillId: mapping.negotiatedSkillId,
    },
    executionScope,
  }, { sql });
}

function appendExchangeEvent(sql: A2ASql, exchange: A2AExchangeV1, executionScope: ExecutionScope) {
  return appendScopedDomainEvent({
    id: `a2a-exchange-recorded:${exchange.exchangeSha256}`,
    streamId: `a2a-task:${exchange.externalTaskId}`,
    type: `a2a.${exchange.payload.type}.recorded`,
    payload: {
      version: exchange.version,
      exchangeId: exchange.exchangeId,
      exchangeSha256: exchange.exchangeSha256,
      mappingId: exchange.mappingId,
      peerId: exchange.peerId,
      externalTaskId: exchange.externalTaskId,
      direction: exchange.direction,
      payloadType: exchange.payload.type,
      payloadSha256: exchange.payloadSha256,
      untrusted: exchange.untrusted,
      authorityImpact: exchange.authorityImpact,
    },
    executionScope,
  }, { sql });
}

function assertScope(scope: ExecutionScope, tenantId: string, ownerActorId: string) {
  if (scope.tenantId !== tenantId || scope.initiatingActorId !== ownerActorId) {
    throw new A2ATaskStoreError("The A2A task operation is outside its owner scope.", 403);
  }
}

function neverValue(): never {
  throw new Error("Unreachable A2A exchange branch.");
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new A2ATaskStoreError("A2A tasks require the canonical database authority.", 503);
  }
}
