import {
  type ConversationCanvasDelegationSource,
  type ConversationCanvasForkSource,
  type ConversationCanvasRunSource,
  type ConversationCanvasSharedArtifactSource,
  type ConversationCanvasSource,
} from "@/lib/conversations/canvas";
import { parseSharedMissionArtifactV1 } from "@/lib/delegation/channel";
import { parseDelegationTaskV1 } from "@/lib/delegation/lifecycle";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { listProjectCollections, listProjectSummaries } from "@/lib/projects/store";
import { parseRunForkLineageV1 } from "@/lib/runs/forks";
import {
  getAgentRunExecutionScope,
  listAgentRuns,
} from "@/lib/runs/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { getOwnedThread, listThreads } from "@/lib/threads/store";

type CanvasStoreInput = Readonly<{
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  threadId?: string;
  threadLimit: number;
  runLimit: number;
  artifactLimit: number;
}>;

type Row = Record<string, unknown>;

export class ConversationCanvasNotFoundError extends Error {
  constructor() {
    super("Conversation not found.");
    this.name = "ConversationCanvasNotFoundError";
  }
}

export async function loadConversationCanvasSource(
  input: CanvasStoreInput,
): Promise<ConversationCanvasSource> {
  const ownerActorIds = ownerIds(input);
  const threads = input.threadId
    ? await loadExactThread(input)
    : await listThreads(input.threadLimit, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        requestActorBinding: input.requestActorBinding,
      });
  const threadIds = threads.map((thread) => thread.id);
  const runResult = hasDatabaseUrl()
    ? await loadDatabaseRuns(input, ownerActorIds, threadIds)
    : await loadFileRuns(input, ownerActorIds, threadIds);
  const runIds = runResult.items.map((run) => run.id);
  const [forkResult, delegationResult, sharedArtifactResult] = hasDatabaseUrl()
    ? await Promise.all([
        loadDatabaseForks(input, ownerActorIds, runIds),
        loadDatabaseDelegations(input, ownerActorIds, runIds),
        loadDatabaseSharedArtifacts(input, ownerActorIds, runIds),
      ])
    : [emptyLimited<ConversationCanvasForkSource>(), emptyLimited<ConversationCanvasDelegationSource>(), emptyLimited<ConversationCanvasSharedArtifactSource>()];

  const requestedProjectIds = new Set(
    threads.flatMap((thread) => thread.projectId ? [thread.projectId] : []),
  );
  const projects = (await listProjectSummaries(100, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    requestActorBinding: input.requestActorBinding,
  })).filter((project) => requestedProjectIds.has(project.id));
  const projectIds = projects.map((project) => project.id);
  const projectCollections = await listProjectCollections(projectIds, {
    tenantId: input.tenantId,
  });
  const projectArtifacts = projectIds.flatMap((projectId) =>
    (projectCollections.artifactsByProject.get(projectId) || [])
      .slice(0, input.artifactLimit)
      .map((artifact) => ({
        id: artifact.id,
        projectId: artifact.projectId,
        title: artifact.title,
        status: artifact.status,
        agentId: artifact.agentId,
        updatedAt: artifact.updatedAt,
      })),
  ).slice(0, input.artifactLimit);

  return Object.freeze({
    threads: Object.freeze(threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      mode: thread.mode,
      projectId: thread.projectId,
      updatedAt: thread.updatedAt,
    }))),
    runs: Object.freeze(runResult.items),
    forks: Object.freeze(forkResult.items),
    delegations: Object.freeze(delegationResult.items),
    projects: Object.freeze(projects.map((project) => ({
      id: project.id,
      title: project.title,
      status: project.status,
      artifactCount: project.artifactCount,
      updatedAt: project.updatedAt,
    }))),
    projectArtifacts: Object.freeze(projectArtifacts),
    sharedArtifacts: Object.freeze(sharedArtifactResult.items),
    truncated: Object.freeze({
      runs: runResult.truncated,
      forks: forkResult.truncated,
      delegations: delegationResult.truncated,
      sharedArtifacts: sharedArtifactResult.truncated,
    }),
  });
}

async function loadExactThread(input: CanvasStoreInput) {
  const thread = await getOwnedThread(input.threadId!, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    requestActorBinding: input.requestActorBinding,
  });
  if (!thread) throw new ConversationCanvasNotFoundError();
  return [thread];
}

async function loadDatabaseRuns(
  input: CanvasStoreInput,
  ownerActorIds: readonly string[],
  threadIds: readonly string[],
) {
  if (!threadIds.length) return emptyLimited<ConversationCanvasRunSource>();
  await ensureDatabaseSchema();
  const rows = await getSql().query(
    `SELECT id, thread_id, mode, status, agent_id, started_at, completed_at
     FROM omni_agent_runs
     WHERE tenant_id = $1
       AND owner_actor_id = ANY($2::text[])
       AND thread_id = ANY($3::text[])
     ORDER BY started_at ASC, id ASC
     LIMIT $4`,
    [input.tenantId, ownerActorIds, threadIds, input.runLimit + 1],
  );
  const selected = rows.slice(0, input.runLimit);
  const grantCounts = await loadRunContextGrantCounts(
    input.tenantId,
    ownerActorIds,
    selected.map((row) => String(row.id)),
  );
  return {
    items: selected.map((row) => runSource(row, grantCounts.get(String(row.id)) ?? null)),
    truncated: rows.length > input.runLimit,
  };
}

async function loadRunContextGrantCounts(
  tenantId: string,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  const counts = new Map<string, number>();
  if (!runIds.length) return counts;
  const streamIds = runIds.map((runId) => `run:${runId}`);
  const rows = await getSql().query(
    `SELECT stream_id, actor_id, correlation_id, payload
     FROM omni_events
     WHERE tenant_id = $1
       AND actor_id = ANY($2::text[])
       AND stream_id = ANY($3::text[])
       AND type = 'run.scope_bound'
     ORDER BY stream_id ASC, seq ASC
     LIMIT $4`,
    [tenantId, ownerActorIds, streamIds, runIds.length * 4],
  );
  for (const row of rows) {
    const runId = String(row.stream_id).replace(/^run:/, "");
    if (!runIds.includes(runId) || counts.has(runId)) continue;
    const scope = parsePersistedExecutionScope(record(row.payload)._executionScope);
    if (
      !scope ||
      scope.tenantId !== tenantId ||
      !scope.initiatingActorId ||
      !ownerActorIds.includes(scope.initiatingActorId) ||
      scope.correlationId !== optionalString(row.correlation_id)
    ) continue;
    counts.set(runId, scope.contextGrantIds.length);
  }
  return counts;
}

async function loadFileRuns(
  input: CanvasStoreInput,
  ownerActorIds: readonly string[],
  threadIds: readonly string[],
) {
  const candidates = (await listAgentRuns(500, { tenantId: input.tenantId }))
    .filter((run) =>
      ownerActorIds.includes(run.ownerActorId) &&
      Boolean(run.threadId) &&
      threadIds.includes(run.threadId!)
    )
    .slice(0, input.runLimit + 1);
  const selected = candidates.slice(0, input.runLimit);
  const items: ConversationCanvasRunSource[] = [];
  for (const run of selected) {
    const scope = await getAgentRunExecutionScope(run.id, { tenantId: input.tenantId });
    items.push({
      id: run.id,
      threadId: run.threadId!,
      mode: run.mode,
      status: run.status,
      agentId: run.agentId || "agent",
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      contextGrantCount: scope?.contextGrantIds.length ?? null,
    });
  }
  return { items, truncated: candidates.length > input.runLimit };
}

async function loadDatabaseForks(
  input: CanvasStoreInput,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return emptyLimited<ConversationCanvasForkSource>();
  const limit = Math.min(input.runLimit, 200);
  const rows = await getSql().query(
    `SELECT lineage_json
     FROM omni_run_forks
     WHERE tenant_id = $1
       AND initiating_actor_id = ANY($2::text[])
       AND source_run_id = ANY($3::text[])
       AND fork_run_id = ANY($3::text[])
     ORDER BY created_at ASC, fork_id ASC
     LIMIT $4`,
    [input.tenantId, ownerActorIds, runIds, limit + 1],
  );
  return {
    items: rows.slice(0, limit).flatMap((row) => {
      try {
        const lineage = parseRunForkLineageV1(row.lineage_json);
        if (!ownerActorIds.includes(lineage.initiatingActorId)) return [];
        return [{
          forkId: lineage.forkId,
          sourceRunId: lineage.source.runId,
          targetRunId: lineage.target.runId,
          checkpointId: lineage.source.checkpointId,
          checkpointSequence: lineage.source.checkpointSequence,
          boundaryKind: lineage.source.boundaryKind,
          createdAt: lineage.createdAt,
        }];
      } catch {
        return [];
      }
    }),
    truncated: rows.length > limit,
  };
}

async function loadDatabaseDelegations(
  input: CanvasStoreInput,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return emptyLimited<ConversationCanvasDelegationSource>();
  const limit = Math.min(input.runLimit * 2, 300);
  const rows = await getSql().query(
    `SELECT task
     FROM omni_delegation_tasks
     WHERE tenant_id = $1
       AND owner_actor_id = ANY($2::text[])
       AND parent_execution_id = ANY($3::text[])
     ORDER BY created_at ASC, task_id ASC
     LIMIT $4`,
    [input.tenantId, ownerActorIds, runIds, limit + 1],
  );
  return {
    items: rows.slice(0, limit).flatMap((row) => {
      try {
        const task = parseDelegationTaskV1(row.task);
        if (!ownerActorIds.includes(task.ownerActorId)) return [];
        return [{
          taskId: task.taskId,
          parentExecutionId: task.parentExecutionId,
          parentDelegationId: task.parentDelegationId,
          delegationId: task.delegationId,
          delegateAgentId: task.delegateAgentId,
          delegateDefinitionVersion: task.delegateDefinitionVersion,
          state: task.state,
          lifecycleRevision: task.lifecycleRevision,
          updatedAt: task.updatedAt,
        }];
      } catch {
        return [];
      }
    }),
    truncated: rows.length > limit,
  };
}

async function loadDatabaseSharedArtifacts(
  input: CanvasStoreInput,
  ownerActorIds: readonly string[],
  runIds: readonly string[],
) {
  if (!runIds.length) return emptyLimited<ConversationCanvasSharedArtifactSource>();
  const limit = Math.min(input.artifactLimit, 200);
  const rows = await getSql().query(
    `SELECT actor_id, data
     FROM omni_mission_artifacts
     WHERE tenant_id = $1
       AND actor_id = ANY($2::text[])
       AND kind = 'delegation_shared_artifact'
       AND data -> 'protocol' ->> 'parentExecutionId' = ANY($3::text[])
     ORDER BY created_at ASC, id ASC
     LIMIT $4`,
    [input.tenantId, ownerActorIds, runIds, limit + 1],
  );
  return {
    items: rows.slice(0, limit).flatMap((row) => {
      try {
        if (!ownerActorIds.includes(String(row.actor_id))) return [];
        const artifact = parseSharedMissionArtifactV1(record(row.data).protocol);
        if (!runIds.includes(artifact.parentExecutionId)) return [];
        return [{
          artifactId: artifact.artifactId,
          artifactSha256: artifact.artifactSha256,
          missionId: artifact.missionId,
          parentExecutionId: artifact.parentExecutionId,
          senderTaskId: artifact.sender.taskId,
          recipientTaskIds: artifact.recipients.delegationTaskIds,
          kind: artifact.kind,
          title: artifact.title,
          createdAt: artifact.createdAt,
        }];
      } catch {
        return [];
      }
    }),
    truncated: rows.length > limit,
  };
}

function runSource(row: Row, contextGrantCount: number | null): ConversationCanvasRunSource {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    mode: String(row.mode),
    status: String(row.status),
    agentId: String(row.agent_id || "agent"),
    startedAt: dateValue(row.started_at),
    completedAt: optionalDateValue(row.completed_at),
    contextGrantCount,
  };
}

function ownerIds(input: CanvasStoreInput) {
  const values = input.requestActorBinding?.readableOwnerActorIds || [input.actorId];
  return Object.freeze([...new Set(values.map(String).filter((value) =>
    value.length > 0 && value.length <= 320
  ))].slice(0, 2));
}

function emptyLimited<T>() {
  return { items: [] as T[], truncated: false };
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function dateValue(value: unknown) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Canvas source date is invalid.");
  return date.toISOString();
}

function optionalDateValue(value: unknown) {
  return value === null || value === undefined ? undefined : dateValue(value);
}
