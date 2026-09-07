import {
  buildBuiltInAgentIdentityV1,
  isBuiltInAgentIdentityId,
  type AgentDefinitionV1,
} from "@/lib/agents/identity-contracts";
import { resolveCustomAgentDefinitionVersionWithSql } from "@/lib/agents/identity-store";
import type {
  AgentCouncilChannelSource,
  AgentCouncilIdentitySource,
  AgentCouncilMapSource,
  AgentCouncilMemberEventSource,
  AgentCouncilRunSource,
  AgentCouncilUsageSource,
} from "@/lib/agents/council-map";
import { parseDelegationAuthorityReceiptV1 } from "@/lib/delegation/authority-receipt";
import {
  listDelegationChannelForOwner,
} from "@/lib/delegation/channel-store";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import {
  delegationTaskPersistenceAvailable,
  listDelegationTasksForOwner,
} from "@/lib/delegation/store";
import { ensureDatabaseSchema, getSql } from "@/lib/db/client";
import { listRecentEvents, type DomainEvent } from "@/lib/events/store";
import type { RunStatus } from "@/lib/runs/types";

type Row = Record<string, unknown>;

export async function loadAgentCouncilMapSource(input: {
  tenantId: string;
  ownerActorIds: readonly string[];
  limit: number;
}): Promise<AgentCouncilMapSource> {
  const ownerActorIds = uniqueIds(input.ownerActorIds).slice(0, 4);
  if (!delegationTaskPersistenceAvailable() || !ownerActorIds.length) {
    return unavailableSource();
  }
  await ensureDatabaseSchema();
  const taskLists = await Promise.all(ownerActorIds.map((ownerActorId) =>
    listDelegationTasksForOwner({
      tenantId: input.tenantId,
      ownerActorId,
      limit: input.limit,
    })
  ));
  const tasks = taskLists.flat()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, input.limit);
  if (!tasks.length) return availableEmptySource();

  const parentExecutionIds = uniqueIds(tasks.map((task) => task.parentExecutionId));
  const delegationIds = uniqueIds(tasks.map((task) => task.delegationId));
  const [runs, authorityEventLists, memberEvents, memberUsage, verifierUsage] = await Promise.all([
    loadRuns(input.tenantId, ownerActorIds, parentExecutionIds),
    Promise.all(ownerActorIds.map((actorId) => listRecentEvents({
      tenantId: input.tenantId,
      actorId,
      type: "delegation.task.proposed",
      limit: 500,
    }))),
    loadMemberEvents(input.tenantId, ownerActorIds, parentExecutionIds),
    loadMemberUsage(input.tenantId, ownerActorIds, delegationIds),
    loadVerifierUsage(input.tenantId, ownerActorIds, parentExecutionIds),
  ]);
  const authorityEvents = authorityEventLists.flat();
  const [identities, channels] = await Promise.all([
    loadIdentities(input.tenantId, tasks),
    loadChannels(input.tenantId, tasks, authorityEvents),
  ]);
  return Object.freeze({
    state: "available" as const,
    tasks: Object.freeze(tasks),
    runs: Object.freeze(runs),
    authorityEvents: Object.freeze(authorityEvents),
    identities: Object.freeze(identities),
    memberEvents: Object.freeze(memberEvents),
    channels: Object.freeze(channels),
    memberUsage: Object.freeze(memberUsage),
    verifierUsage: Object.freeze(verifierUsage),
  });
}

async function loadRuns(
  tenantId: string,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return [];
  const rows = await getSql().query(
    `SELECT id, owner_actor_id, status, prompt, started_at, completed_at
     FROM omni_agent_runs
     WHERE tenant_id = $1
       AND owner_actor_id = ANY($2::text[])
       AND id = ANY($3::text[])
     ORDER BY started_at DESC, id ASC
     LIMIT $4`,
    [tenantId, ownerActorIds, runIds, runIds.length],
  );
  return rows.flatMap((row): AgentCouncilRunSource[] => {
    const status = runStatus(row.status);
    if (!status) return [];
    return [{
      id: String(row.id),
      ownerActorId: String(row.owner_actor_id),
      status,
      prompt: String(row.prompt || ""),
      startedAt: date(row.started_at),
      ...(row.completed_at ? { completedAt: date(row.completed_at) } : {}),
    }];
  });
}

async function loadMemberEvents(
  tenantId: string,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return [];
  const rows = await getSql().query(
    `SELECT event.id, event.run_id, event.payload, event.created_at
     FROM omni_agent_events event
     JOIN omni_agent_runs run
       ON run.tenant_id = event.tenant_id
      AND run.id = event.run_id
     WHERE event.tenant_id = $1
       AND run.owner_actor_id = ANY($2::text[])
       AND event.run_id = ANY($3::text[])
       AND event.type = 'council_member'
     ORDER BY event.created_at DESC, event.id ASC
     LIMIT $4`,
    [tenantId, ownerActorIds, runIds, Math.min(runIds.length * 30, 1_500)],
  );
  return rows.flatMap(parseMemberEvent);
}

function parseMemberEvent(row: Row): AgentCouncilMemberEventSource[] {
  const payload = record(row.payload);
  const taskId = text(payload.taskId);
  const agentId = text(payload.agentId);
  const status = councilStatus(payload.status);
  if (!taskId || !agentId || !status) return [];
  const confidence = finiteNumber(payload.confidence);
  return [{
    id: String(row.id),
    runId: String(row.run_id),
    taskId,
    agentId,
    status,
    ...(typeof payload.summary === "string" && payload.summary.trim()
      ? { summary: payload.summary }
      : {}),
    ...(confidence !== undefined && confidence >= 0 && confidence <= 1
      ? { confidence }
      : {}),
    createdAt: date(row.created_at),
  }];
}

async function loadIdentities(
  tenantId: string,
  tasks: readonly DelegationTaskV1[],
) {
  const requests = new Map<string, {
    ownerActorId: string;
    agentId: string;
    definitionVersion: number;
  }>();
  for (const task of tasks) {
    for (const item of [
      {
        ownerActorId: task.ownerActorId,
        agentId: task.delegateAgentId,
        definitionVersion: task.delegateDefinitionVersion,
      },
      {
        ownerActorId: task.ownerActorId,
        agentId: task.verifierAgentId,
        definitionVersion: task.verifierDefinitionVersion,
      },
    ]) requests.set(identityKey(item), item);
  }
  const results = await Promise.all([...requests.values()].map(async (request) => {
    try {
      let definition: AgentDefinitionV1;
      if (isBuiltInAgentIdentityId(request.agentId)) {
        definition = buildBuiltInAgentIdentityV1({
          agentId: request.agentId,
          tenantId,
          controllerActorId: request.ownerActorId,
        }).definition;
        if (definition.definitionVersion !== request.definitionVersion) return undefined;
      } else {
        definition = await resolveCustomAgentDefinitionVersionWithSql({
          tenantId,
          agentId: request.agentId,
          ownerActorId: request.ownerActorId,
          definitionVersion: request.definitionVersion,
          sql: getSql(),
        });
      }
      return {
        ownerActorId: request.ownerActorId,
        definition,
      } satisfies AgentCouncilIdentitySource;
    } catch {
      return undefined;
    }
  }));
  return results.filter((value): value is AgentCouncilIdentitySource => Boolean(value));
}

async function loadChannels(
  tenantId: string,
  tasks: readonly DelegationTaskV1[],
  authorityEvents: readonly DomainEvent[],
) {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const requests = new Map<string, { ownerActorId: string; missionId: string }>();
  for (const event of authorityEvents) {
    const task = tasksById.get(text(event.payload.taskId) || "");
    if (!task) continue;
    const missionId = verifiedMissionReference(task, event);
    if (!missionId) continue;
    const request = { ownerActorId: task.ownerActorId, missionId };
    requests.set(channelKey(request), request);
  }
  return Promise.all([...requests.values()].map(async (request): Promise<AgentCouncilChannelSource> => {
    try {
      const records = await listDelegationChannelForOwner({ tenantId, ...request });
      return { ...request, state: "available", records };
    } catch {
      return { ...request, state: "unavailable", records: [] };
    }
  }));
}

function verifiedMissionReference(task: DelegationTaskV1, event: DomainEvent) {
  try {
    const authority = parseDelegationAuthorityReceiptV1(event.payload.authority);
    const scope = event.executionScope;
    if (
      !scope ||
      event.tenantId !== task.tenantId ||
      event.actorId !== task.ownerActorId ||
      authority.taskId !== task.taskId ||
      authority.delegationId !== task.delegationId ||
      authority.contractId !== task.contractId ||
      authority.contractSha256 !== task.contractSha256 ||
      scope.initiatingActorId !== task.ownerActorId ||
      scope.executingPrincipalId !== task.delegatePrincipalId ||
      scope.delegationId !== task.delegationId ||
      scope.missionId !== authority.scope.missionId
    ) return undefined;
    return authority.scope.missionId || undefined;
  } catch {
    return undefined;
  }
}

async function loadMemberUsage(
  tenantId: string,
  ownerActorIds: readonly string[],
  delegationIds: readonly string[],
) {
  if (!delegationIds.length) return [];
  const rows = await getSql().query(
    `SELECT execution_scope ->> 'delegationId' AS usage_key,
            COUNT(*)::integer AS receipt_count,
            COUNT(*) FILTER (WHERE estimated_cost_microusd IS NULL)::integer AS unknown_cost_receipt_count,
            COALESCE(SUM(COALESCE(
              NULLIF(usage ->> 'totalTokens', '')::bigint,
              COALESCE(NULLIF(usage ->> 'inputTokens', '')::bigint, 0) +
              COALESCE(NULLIF(usage ->> 'outputTokens', '')::bigint, 0)
            )), 0)::bigint AS total_tokens,
            COALESCE(SUM(estimated_cost_microusd), 0)::bigint AS known_cost_microusd
     FROM omni_ai_usage
     WHERE tenant_id = $1
       AND actor_id = ANY($2::text[])
       AND execution_scope ->> 'delegationId' = ANY($3::text[])
     GROUP BY execution_scope ->> 'delegationId'`,
    [tenantId, ownerActorIds, delegationIds],
  );
  return rows.map(usageSource);
}

async function loadVerifierUsage(
  tenantId: string,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return [];
  const streamIds = runIds.map((runId) => `run:${runId}`);
  const rows = await getSql().query(
    `SELECT SUBSTRING(source_stream_id FROM 5) AS usage_key,
            COUNT(*)::integer AS receipt_count,
            COUNT(*) FILTER (WHERE estimated_cost_microusd IS NULL)::integer AS unknown_cost_receipt_count,
            COALESCE(SUM(COALESCE(
              NULLIF(usage ->> 'totalTokens', '')::bigint,
              COALESCE(NULLIF(usage ->> 'inputTokens', '')::bigint, 0) +
              COALESCE(NULLIF(usage ->> 'outputTokens', '')::bigint, 0)
            )), 0)::bigint AS total_tokens,
            COALESCE(SUM(estimated_cost_microusd), 0)::bigint AS known_cost_microusd
     FROM omni_ai_usage
     WHERE tenant_id = $1
       AND actor_id = ANY($2::text[])
       AND source_stream_id = ANY($3::text[])
       AND purpose IN ('council.review', 'council.revise')
     GROUP BY source_stream_id`,
    [tenantId, ownerActorIds, streamIds],
  );
  return rows.map(usageSource);
}

function usageSource(row: Row): AgentCouncilUsageSource {
  return {
    key: String(row.usage_key),
    receiptCount: safeInteger(row.receipt_count),
    unknownCostReceiptCount: safeInteger(row.unknown_cost_receipt_count),
    totalTokens: safeInteger(row.total_tokens),
    knownEstimatedCostMicrousd: safeInteger(row.known_cost_microusd),
  };
}

function availableEmptySource(): AgentCouncilMapSource {
  return Object.freeze({
    state: "available",
    tasks: [], runs: [], authorityEvents: [], identities: [], memberEvents: [],
    channels: [], memberUsage: [], verifierUsage: [],
  });
}

function unavailableSource(): AgentCouncilMapSource {
  return Object.freeze({ ...availableEmptySource(), state: "unavailable" });
}

function runStatus(value: unknown): RunStatus | undefined {
  return [
    "queued", "running", "waiting_clarification", "waiting_approval",
    "resuming", "completed", "failed", "canceled",
  ].find((status) => status === value) as RunStatus | undefined;
}

function councilStatus(value: unknown) {
  return ["thinking", "completed", "failed"].find((status) => status === value) as
    AgentCouncilMemberEventSource["status"] | undefined;
}

function identityKey(value: { ownerActorId: string; agentId: string; definitionVersion: number }) {
  return `${value.ownerActorId}\0${value.agentId}\0${value.definitionVersion}`;
}

function channelKey(value: { ownerActorId: string; missionId: string }) {
  return `${value.ownerActorId}\0${value.missionId}`;
}

function uniqueIds(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function safeInteger(value: unknown) {
  const number = Math.round(Number(value) || 0);
  return Math.min(Math.max(number, 0), Number.MAX_SAFE_INTEGER);
}

function date(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
