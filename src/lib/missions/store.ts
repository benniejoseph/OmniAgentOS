import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendDomainEventSafely } from "@/lib/events/store";
import { missionActorReadOrder } from "@/lib/missions/actor-scope";
import type {
  Mission,
  MissionArtifact,
  MissionAttempt,
  MissionAttemptStatus,
  MissionDetail,
  MissionLedger,
  MissionPriority,
  RequestMissionSummary,
  MissionStatus,
  MissionTask,
  MissionTaskBlockerKind,
  MissionTaskStatus,
} from "@/lib/missions/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { canonicalStatusForMission } from "@/lib/status/canonical";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type MissionOwner = { tenantId?: string; actorId: string };

type MissionRequestOwner = MissionOwner & {
  requestActorBinding?: CanonicalRequestActorBindingV1;
};

export type MissionTaskUpdate = {
  expectedUpdatedAt?: string;
  title?: string;
  instructions?: string;
  definitionOfDone?: string;
  priority?: MissionPriority;
  dependencyIds?: string[];
  position?: number;
  metadata?: Record<string, unknown>;
};

export type MissionTaskReviewResult = {
  task: MissionTask;
  review: MissionArtifact;
};

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>([
  "succeeded",
  "failed",
  "canceled",
  "archived",
]);
const TERMINAL_TASK_STATUSES = new Set<MissionTaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
const TERMINAL_ATTEMPT_STATUSES = new Set<MissionAttemptStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

export class MissionNotFoundError extends Error {}
export class MissionConflictError extends Error {}
export class MissionTransitionError extends Error {}
export class MissionReadConflictError extends Error {
  constructor(message = "Mission request ownership is ambiguous.") {
    super(message);
    this.name = "MissionReadConflictError";
  }
}

export async function createMission(input: {
  tenantId?: string;
  actorId: string;
  title: string;
  objective: string;
  priority?: MissionPriority;
  source?: string;
  sourceKey?: string;
  metadata?: Record<string, unknown>;
}) {
  const owner = normalizeOwner(input);
  const now = new Date().toISOString();
  const id = randomUUID();
  const mission: Mission = {
    id,
    ...owner,
    title: requiredText(input.title, 240, "Mission title"),
    objective: requiredTextBlock(input.objective, 4_000, "Mission objective"),
    status: "draft",
    priority: input.priority || "normal",
    source: safeText(input.source || "user", 80) || "user",
    sourceKey: input.sourceKey
      ? requiredKey(input.sourceKey, "Mission source key")
      : `mission:${id}`,
    metadata: boundedObject(input.metadata, 64_000),
    createdAt: now,
    updatedAt: now,
  };
  let created = false;
  let saved: Mission;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_missions (
        id, tenant_id, actor_id, title, objective, status, priority, source,
        source_key, metadata, created_at, updated_at
      ) VALUES (
        ${mission.id}, ${mission.tenantId}, ${mission.actorId}, ${mission.title},
        ${mission.objective}, ${mission.status}, ${mission.priority}, ${mission.source},
        ${mission.sourceKey}, ${mission.metadata}::jsonb, ${now}, ${now}
      )
      ON CONFLICT (tenant_id, actor_id, source_key) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) {
      created = true;
      saved = missionFromRow(rows[0]);
    } else {
      const existing = await getSql()`
        SELECT * FROM omni_missions
        WHERE tenant_id = ${mission.tenantId} AND actor_id = ${mission.actorId}
          AND source_key = ${mission.sourceKey}
        LIMIT 1
      `;
      if (!existing[0]) throw new MissionConflictError("Mission source key collided.");
      saved = missionFromRow(existing[0]);
    }
  } else {
    saved = mission;
    await updateLedger((ledger) => {
      const existing = ledger.missions.find((item) =>
        item.tenantId === mission.tenantId &&
        item.actorId === mission.actorId &&
        item.sourceKey === mission.sourceKey
      );
      if (existing) {
        saved = existing;
        return ledger;
      }
      created = true;
      return { ...ledger, missions: [mission, ...ledger.missions] };
    });
  }

  if (created) {
    await appendMissionLifecycleEvent(saved, "mission.created", {
      status: saved.status,
      source: saved.source,
    });
  }
  return saved;
}

export async function listMissions(
  limit = 50,
  options: MissionOwner,
): Promise<Mission[]> {
  const owner = normalizeOwner(options);
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_missions
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      ORDER BY
        CASE status
          WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'queued' THEN 2
          WHEN 'draft' THEN 3 ELSE 4
        END,
        updated_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(missionFromRow);
  }
  const ledger = await readLedger();
  return ledger.missions
    .filter((mission) => owns(mission, owner))
    .sort(compareMissions)
    .slice(0, bounded);
}

/**
 * Returns the request-readable Mission catalog without widening any exact
 * Mission detail, mutation, event, or execution path.
 */
export async function listMissionSummariesForRequest(
  limit: number,
  options: MissionRequestOwner,
): Promise<RequestMissionSummary[]> {
  const owner = normalizeOwner(options);
  const bounded = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 200)
    : 50;

  if (!hasDatabaseUrl()) {
    const ledger = await readLedger();
    const exactMissions = ledger.missions
      .filter((mission) => owns(mission, owner));
    assertExactFileMissionSourceKeys(exactMissions);
    const summaries = exactMissions
      .map(missionPhysicalSummaryFromMission);
    assertRequestMissionSummaries(
      summaries,
      owner.tenantId,
      owner.actorId,
      owner.actorId,
    );
    return summaries
      .sort(compareRequestMissionSummaries)
      .slice(0, bounded)
      .map((summary) => requestMissionSummary(summary, owner.actorId));
  }

  const [canonicalActorId, exactActorId] = missionActorReadOrder(
    options.actorId,
    options.requestActorBinding,
    owner.actorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    WITH status_order(status, status_rank) AS (
      VALUES
        ('running'::text, 0),
        ('waiting'::text, 1),
        ('queued'::text, 2),
        ('draft'::text, 3),
        ('succeeded'::text, 4),
        ('failed'::text, 5),
        ('canceled'::text, 6),
        ('archived'::text, 7)
    ), requested_owners(actor_id, owner_rank) AS (
      VALUES (${canonicalActorId}::text, 0), (${exactActorId}::text, 1)
    ), readable_owners AS (
      SELECT actor_id, owner_rank
      FROM requested_owners
      WHERE owner_rank = 0
        OR actor_id COLLATE "C" <> ${canonicalActorId}::text COLLATE "C"
    ), bounded_rows AS (
      SELECT mission.id, mission.tenant_id, mission.actor_id, mission.title,
        mission.objective, mission.status, mission.priority, mission.source,
        mission.started_at, mission.terminal_at, mission.created_at,
        mission.updated_at, status_order.status_rank
      FROM readable_owners
      CROSS JOIN status_order
      CROSS JOIN LATERAL (
        SELECT id, tenant_id, actor_id, title, objective, status, priority,
          source, started_at, terminal_at, created_at, updated_at
        FROM omni_missions
        WHERE tenant_id = ${owner.tenantId}
          AND actor_id = readable_owners.actor_id
          AND status = status_order.status
          AND tenant_id COLLATE "C" = ${owner.tenantId}::text COLLATE "C"
          AND actor_id COLLATE "C" = readable_owners.actor_id COLLATE "C"
          AND status COLLATE "C" = status_order.status COLLATE "C"
        ORDER BY updated_at DESC, id COLLATE "C" ASC
        LIMIT ${bounded}
      ) AS mission
    ), invalid_status_state AS (
      SELECT EXISTS (
        SELECT 1
        FROM readable_owners
        CROSS JOIN LATERAL (
          SELECT 1
          FROM omni_missions AS invalid_mission
          WHERE invalid_mission.tenant_id = ${owner.tenantId}
            AND invalid_mission.actor_id = readable_owners.actor_id
            AND invalid_mission.tenant_id COLLATE "C" =
              ${owner.tenantId}::text COLLATE "C"
            AND invalid_mission.actor_id COLLATE "C" =
              readable_owners.actor_id COLLATE "C"
            AND NOT EXISTS (
              SELECT 1
              FROM status_order AS accepted_status
              WHERE accepted_status.status = invalid_mission.status
                AND accepted_status.status COLLATE "C" =
                  invalid_mission.status COLLATE "C"
            )
          LIMIT 1
        ) AS invalid_status
        LIMIT 1
      ) AS unsupported_status
    ), source_key_state AS (
      SELECT EXISTS (
        SELECT 1
        FROM omni_missions AS canonical_mission
        INNER JOIN omni_missions AS exact_mission
          ON exact_mission.tenant_id = canonical_mission.tenant_id
          AND exact_mission.source_key = canonical_mission.source_key
          AND exact_mission.source_key COLLATE "C" =
            canonical_mission.source_key COLLATE "C"
        WHERE ${exactActorId}::text COLLATE "C" <>
            ${canonicalActorId}::text COLLATE "C"
          AND canonical_mission.tenant_id = ${owner.tenantId}
          AND canonical_mission.actor_id = ${canonicalActorId}
          AND exact_mission.actor_id = ${exactActorId}
          AND canonical_mission.tenant_id COLLATE "C" =
            ${owner.tenantId}::text COLLATE "C"
          AND canonical_mission.actor_id COLLATE "C" =
            ${canonicalActorId}::text COLLATE "C"
          AND exact_mission.tenant_id COLLATE "C" =
            ${owner.tenantId}::text COLLATE "C"
          AND exact_mission.actor_id COLLATE "C" =
            ${exactActorId}::text COLLATE "C"
        LIMIT 1
      ) AS source_key_collision
    )
    SELECT bounded_rows.id, bounded_rows.tenant_id, bounded_rows.actor_id,
      bounded_rows.title, bounded_rows.objective, bounded_rows.status,
      bounded_rows.priority, bounded_rows.source, bounded_rows.started_at,
      bounded_rows.terminal_at, bounded_rows.created_at,
      bounded_rows.updated_at, source_key_state.source_key_collision,
      invalid_status_state.unsupported_status,
      bounded_rows.id IS NOT NULL AS mission_present
    FROM source_key_state
    CROSS JOIN invalid_status_state
    LEFT JOIN bounded_rows ON TRUE
    ORDER BY bounded_rows.status_rank ASC, bounded_rows.updated_at DESC,
      bounded_rows.id COLLATE "C" ASC
    LIMIT ${bounded}
  `;
  if (rows.length > bounded) throw new MissionReadConflictError();
  const summaries = rows
    .filter(requestMissionRowIsPresent)
    .map(missionPhysicalSummaryFromRow);
  assertRequestMissionSummaries(
    summaries,
    owner.tenantId,
    canonicalActorId,
    exactActorId,
  );
  return summaries
    .sort(compareRequestMissionSummaries)
    .map((summary) => requestMissionSummary(summary, exactActorId));
}

export async function getMission(
  missionId: string,
  options: MissionOwner,
): Promise<Mission | undefined> {
  const owner = normalizeOwner(options);
  const id = requiredKey(missionId, "Mission id");
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_missions
      WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      LIMIT 1
    `;
    return rows[0] ? missionFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.missions.find((mission) => mission.id === id && owns(mission, owner));
}

export async function getMissionDetail(
  missionId: string,
  options: MissionOwner,
  limits: { tasks?: number; attempts?: number; artifacts?: number } = {},
): Promise<MissionDetail | undefined> {
  const owner = normalizeOwner(options);
  const mission = await getMission(missionId, owner);
  if (!mission) return undefined;
  if (hasDatabaseUrl()) {
    // The hosted runtime deliberately uses a one-connection pool per isolate.
    // Start these reads serially so sibling acquisitions cannot time out while
    // the first query owns the only connection.
    const tasks = await listMissionTasks(mission.id, owner, limits.tasks);
    const attempts = await listMissionAttempts(mission.id, owner, limits.attempts);
    const artifacts = await listMissionArtifacts(mission.id, owner, limits.artifacts);
    return { mission, tasks, attempts, artifacts };
  }
  const ledger = await readLedger();
  return {
    mission,
    tasks: ledger.tasks.filter((task) => task.missionId === mission.id && owns(task, owner)).sort(compareTasks).slice(0, boundedLimit(limits.tasks, 1_000)),
    attempts: ledger.attempts.filter((attempt) => attempt.missionId === mission.id && owns(attempt, owner)).sort(compareNewest).slice(0, boundedLimit(limits.attempts, 1_000)),
    artifacts: ledger.artifacts.filter((artifact) => artifact.missionId === mission.id && owns(artifact, owner)).sort(compareNewest).slice(0, boundedLimit(limits.artifacts, 1_000)),
  };
}

export async function ensureMissionTask(
  missionId: string,
  input: {
    sourceKey: string;
    title: string;
    instructions?: string;
    definitionOfDone?: string;
    priority?: MissionPriority;
    position?: number;
    parentTaskId?: string;
    dependencyIds?: string[];
    input?: Record<string, unknown>;
    status?: "triage" | "pending";
    metadata?: Record<string, unknown>;
  },
  options: MissionOwner,
): Promise<MissionTask> {
  const owner = normalizeOwner(options);
  const mission = await requireMission(missionId, owner);
  if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
    throw new MissionTransitionError("A terminal mission cannot accept a new task.");
  }
  const now = new Date().toISOString();
  const task: MissionTask = {
    id: randomUUID(),
    ...owner,
    missionId: mission.id,
    parentTaskId: optionalKey(input.parentTaskId),
    title: requiredText(input.title, 280, "Task title"),
    instructions: safeTextBlock(input.instructions, 8_000),
    definitionOfDone: safeTextBlock(input.definitionOfDone, 2_000),
    status: input.status || "pending",
    priority: input.priority || "normal",
    position: boundedInteger(input.position, 0, 0, 100_000),
    sourceKey: requiredKey(input.sourceKey, "Task source key"),
    dependencyIds: sanitizeIds(input.dependencyIds),
    input: boundedObject(input.input, 128_000),
    metadata: sanitizeMissionTaskMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };
  await validateTaskReferences(task, owner);
  let created = false;
  let saved: MissionTask;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const transactionResult = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const lockedMission = await sql`
          SELECT status FROM omni_missions
          WHERE id = ${mission.id} AND tenant_id = ${owner.tenantId}
            AND actor_id = ${owner.actorId}
          FOR UPDATE
        `;
        if (!lockedMission[0]) throw new MissionNotFoundError("Mission not found.");
        if (TERMINAL_MISSION_STATUSES.has(String(lockedMission[0].status) as MissionStatus)) {
          throw new MissionTransitionError("A terminal mission cannot accept a new task.");
        }
        const rows = await sql`
          INSERT INTO omni_mission_tasks (
            id, tenant_id, actor_id, mission_id, parent_task_id, title, instructions,
            definition_of_done, status, priority, position, source_key, dependency_ids,
            input, metadata, created_at, updated_at
          ) VALUES (
            ${task.id}, ${task.tenantId}, ${task.actorId}, ${task.missionId},
            ${task.parentTaskId || null}, ${task.title}, ${task.instructions},
            ${task.definitionOfDone}, ${task.status}, ${task.priority}, ${task.position},
            ${task.sourceKey}, ${task.dependencyIds}, ${task.input}::jsonb,
            ${task.metadata}::jsonb, ${now}, ${now}
          )
          ON CONFLICT (tenant_id, actor_id, mission_id, source_key) DO NOTHING
          RETURNING *
        `;
        if (rows[0]) {
          return { created: true, saved: taskFromRow(rows[0]) };
        }
        const existing = await sql`
          SELECT * FROM omni_mission_tasks
          WHERE tenant_id = ${task.tenantId} AND actor_id = ${task.actorId}
            AND mission_id = ${task.missionId} AND source_key = ${task.sourceKey}
          LIMIT 1
        `;
        if (!existing[0]) throw new MissionConflictError("Task source key collided.");
        return { created: false, saved: taskFromRow(existing[0]) };
      },
    ) as { created: boolean; saved: MissionTask };
    created = transactionResult.created;
    saved = transactionResult.saved;
  } else {
    saved = task;
    await updateLedger((ledger) => {
      const currentMission = ledger.missions.find((item) =>
        item.id === mission.id && owns(item, owner)
      );
      if (!currentMission) {
        throw new MissionNotFoundError("Mission not found.");
      }
      if (TERMINAL_MISSION_STATUSES.has(currentMission.status)) {
        throw new MissionTransitionError("A terminal mission cannot accept a new task.");
      }
      const existing = ledger.tasks.find((item) =>
        item.missionId === mission.id && owns(item, owner) && item.sourceKey === task.sourceKey
      );
      if (existing) {
        saved = existing;
        return ledger;
      }
      created = true;
      return { ...ledger, tasks: [...ledger.tasks, task] };
    });
  }

  if (created) {
    await appendMissionLifecycleEvent(mission, "mission.task.created", {
      taskId: saved.id,
      status: saved.status,
    });
  }
  return saved;
}

export async function listMissionTasks(
  missionId: string,
  options: MissionOwner,
  limit?: number,
): Promise<MissionTask[]> {
  const owner = normalizeOwner(options);
  const id = requiredKey(missionId, "Mission id");
  const bounded = boundedLimit(limit, 1_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_tasks
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND mission_id = ${id}
      ORDER BY position ASC, created_at ASC
      LIMIT ${bounded}
    `;
    return rows.map(taskFromRow);
  }
  const ledger = await readLedger();
  return ledger.tasks
    .filter((task) => task.missionId === id && owns(task, owner))
    .sort(compareTasks)
    .slice(0, bounded);
}

export async function getMissionTask(
  taskId: string,
  options: MissionOwner,
): Promise<MissionTask | undefined> {
  const owner = normalizeOwner(options);
  const id = requiredKey(taskId, "Task id");
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_tasks
      WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      LIMIT 1
    `;
    return rows[0] ? taskFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  const task = ledger.tasks.find((item) => item.id === id && owns(item, owner));
  return task ? normalizeStoredTask(task) : undefined;
}

export async function updateMissionTask(
  taskId: string,
  input: MissionTaskUpdate,
  options: MissionOwner,
): Promise<MissionTask> {
  const owner = normalizeOwner(options);
  const id = requiredKey(taskId, "Task id");
  const changedFields = missionTaskUpdateFields(input);
  if (!changedFields.length) {
    throw new Error("At least one mission task field must be updated.");
  }

  let saved: MissionTask;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    saved = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const targetRows = await sql`
        SELECT mission_id FROM omni_mission_tasks
        WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      `;
      if (!targetRows[0]) throw new MissionNotFoundError("Mission task not found.");
      const missionRows = await sql`
        SELECT * FROM omni_mission_tasks
        WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
          AND mission_id = ${String(targetRows[0].mission_id)}
        ORDER BY id ASC
        FOR UPDATE
      `;
      const currentRow = missionRows.find((row) => String(row.id) === id);
      if (!currentRow) throw new MissionNotFoundError("Mission task not found.");
      const current = taskFromRow(currentRow);
      assertExpectedTaskVersion(current, input.expectedUpdatedAt);
      const now = nextUpdatedAt(current.updatedAt);
      const next = buildMissionTaskUpdate(current, input, now);

      if (input.dependencyIds !== undefined) {
        validateTaskGraph(next, missionRows.map(taskFromRow));
      }

      const updated = await sql`
        UPDATE omni_mission_tasks
        SET title = ${next.title}, instructions = ${next.instructions},
          definition_of_done = ${next.definitionOfDone}, priority = ${next.priority},
          dependency_ids = ${next.dependencyIds}, position = ${next.position},
          metadata = ${next.metadata}::jsonb, updated_at = ${now}
        WHERE id = ${current.id} AND tenant_id = ${owner.tenantId}
          AND actor_id = ${owner.actorId} AND updated_at = ${current.updatedAt}
        RETURNING *
      `;
      if (!updated[0]) {
        throw new MissionConflictError("Mission task changed concurrently.");
      }
      return taskFromRow(updated[0]);
    }) as MissionTask;
  } else {
    let updated: MissionTask | undefined;
    await updateLedger((ledger) => {
      const index = ledger.tasks.findIndex((task) => task.id === id && owns(task, owner));
      if (index < 0) throw new MissionNotFoundError("Mission task not found.");
      const current = normalizeStoredTask(ledger.tasks[index]);
      assertExpectedTaskVersion(current, input.expectedUpdatedAt);
      const next = buildMissionTaskUpdate(current, input, nextUpdatedAt(current.updatedAt));
      if (input.dependencyIds !== undefined) {
        validateTaskGraph(
          next,
          ledger.tasks
            .filter((task) => task.missionId === current.missionId && owns(task, owner))
            .map(normalizeStoredTask),
        );
      }
      updated = next;
      return { ...ledger, tasks: replaceAt(ledger.tasks, index, next) };
    });
    if (!updated) throw new MissionConflictError("Mission task update was not persisted.");
    saved = updated;
  }

  await appendMissionLifecycleEventForOwner(saved.missionId, owner, "mission.task.updated", {
    taskId: saved.id,
    fields: changedFields,
  });
  return saved;
}

export async function appendMissionTaskComment(
  taskId: string,
  input: { body: string; sourceKey?: string },
  options: MissionOwner,
): Promise<MissionArtifact> {
  const owner = normalizeOwner(options);
  const task = await requireMissionTask(taskId, owner);
  const comment = await recordMissionArtifact({
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    sourceKey: optionalKey(input.sourceKey) || `task-comment:${randomUUID()}`,
    kind: "task_comment",
    title: "Task comment",
    data: { body: requiredTextBlock(input.body, 8_000, "Comment") },
  });
  await appendMissionLifecycleEventForOwner(task.missionId, owner, "mission.task.comment.created", {
    taskId: task.id,
    commentId: comment.id,
  });
  return comment;
}

export async function recordMissionTaskHandoff(
  taskId: string,
  input: {
    summary: string;
    verification?: string;
    recovery?: string;
    residualRisk?: string;
    artifactIds?: string[];
    attemptId?: string;
    sourceKey?: string;
  },
  options: MissionOwner,
): Promise<MissionArtifact> {
  const owner = normalizeOwner(options);
  const task = await requireMissionTask(taskId, owner);
  const handoff = await recordMissionArtifact({
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    attemptId: optionalKey(input.attemptId),
    sourceKey: optionalKey(input.sourceKey) || `task-handoff:${randomUUID()}`,
    kind: "task_handoff",
    title: "Task handoff",
    data: compactDefined({
      summary: requiredTextBlock(input.summary, 8_000, "Handoff summary"),
      verification: optionalText(input.verification, 4_000),
      recovery: optionalText(input.recovery, 4_000),
      residualRisk: optionalText(input.residualRisk, 4_000),
      artifactIds: sanitizeIds(input.artifactIds).slice(0, 50),
    }),
  });
  await appendMissionLifecycleEventForOwner(task.missionId, owner, "mission.task.handoff.recorded", {
    taskId: task.id,
    handoffId: handoff.id,
    attemptId: handoff.attemptId,
  });
  return handoff;
}

export async function requestMissionTaskReview(
  taskId: string,
  input: {
    summary?: string;
    reviewerKey?: string;
    reviewerName?: string;
    sourceKey?: string;
  },
  options: MissionOwner,
): Promise<MissionTaskReviewResult> {
  const owner = normalizeOwner(options);
  const current = await requireMissionTask(taskId, owner);
  if (!["pending", "running", "review"].includes(current.status)) {
    throw new MissionTransitionError("Only pending or running work can request review.");
  }
  const requestedAt = new Date().toISOString();
  const updated = await updateMissionTask(current.id, {
    expectedUpdatedAt: current.updatedAt,
    metadata: {
      reviewRequired: true,
      reviewerKey: input.reviewerKey,
      reviewerName: input.reviewerName,
      reviewRequestedAt: requestedAt,
      reviewSummary: input.summary,
      changesRequestedReason: null,
      blocker: null,
    },
  }, owner);
  const task = updated.status === "review"
    ? updated
    : await transitionMissionTask(updated.id, "review", owner);
  const review = await recordMissionArtifact({
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    sourceKey: optionalKey(input.sourceKey) || `review-request:${randomUUID()}`,
    kind: "review_request",
    title: "Review requested",
    data: compactDefined({
      action: "request",
      summary: optionalText(input.summary, 4_000),
      reviewerKey: optionalKey(input.reviewerKey),
      reviewerName: optionalText(input.reviewerName, 160),
      requestedAt,
    }),
  });
  await appendMissionLifecycleEventForOwner(task.missionId, owner, "mission.task.review.requested", {
    taskId: task.id,
    reviewId: review.id,
  });
  return { task, review };
}

export async function approveMissionTaskReview(
  taskId: string,
  input: { summary?: string; sourceKey?: string },
  options: MissionOwner,
): Promise<MissionTaskReviewResult> {
  const owner = normalizeOwner(options);
  const current = await requireMissionTask(taskId, owner);
  if (current.status !== "review") {
    throw new MissionTransitionError("Only a task in review can be approved.");
  }
  const updated = await updateMissionTask(current.id, {
    expectedUpdatedAt: current.updatedAt,
    metadata: {
      reviewSummary: input.summary,
      changesRequestedReason: null,
      blocker: null,
    },
  }, owner);
  const task = await transitionMissionTask(updated.id, "succeeded", owner);
  const review = await recordMissionArtifact({
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    sourceKey: optionalKey(input.sourceKey) || `review-approval:${randomUUID()}`,
    kind: "review_approval",
    title: "Review approved",
    data: compactDefined({ action: "approve", summary: optionalText(input.summary, 4_000) }),
  });
  await appendMissionLifecycleEventForOwner(task.missionId, owner, "mission.task.review.approved", {
    taskId: task.id,
    reviewId: review.id,
  });
  return { task, review };
}

export async function requestMissionTaskChanges(
  taskId: string,
  input: { reason: string; sourceKey?: string },
  options: MissionOwner,
): Promise<MissionTaskReviewResult> {
  const owner = normalizeOwner(options);
  const current = await requireMissionTask(taskId, owner);
  if (current.status !== "review") {
    throw new MissionTransitionError("Changes can only be requested for a task in review.");
  }
  const reason = requiredTextBlock(input.reason, 4_000, "Changes requested reason");
  const updated = await updateMissionTask(current.id, {
    expectedUpdatedAt: current.updatedAt,
    metadata: {
      reviewRequired: true,
      changesRequestedReason: reason,
      blocker: null,
    },
  }, owner);
  const task = await transitionMissionTask(updated.id, "pending", owner);
  const review = await recordMissionArtifact({
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    sourceKey: optionalKey(input.sourceKey) || `review-changes:${randomUUID()}`,
    kind: "review_changes_requested",
    title: "Changes requested",
    data: { action: "request_changes", reason },
  });
  await appendMissionLifecycleEventForOwner(task.missionId, owner, "mission.task.review.changes_requested", {
    taskId: task.id,
    reviewId: review.id,
  });
  return { task, review };
}

export async function startMissionAttempt(
  taskId: string,
  input: {
    executorKey: string;
    executorId: string;
    executorType?: string;
    agentRunId?: string;
    workflowRunId?: string;
    input?: Record<string, unknown>;
  },
  options: MissionOwner,
): Promise<MissionAttempt> {
  const owner = normalizeOwner(options);
  const task = await getMissionTask(taskId, owner);
  if (!task) throw new MissionNotFoundError("Mission task not found.");
  if (task.status === "triage" || task.status === "review") {
    throw new MissionTransitionError(`A task in ${task.status} cannot start an execution attempt.`);
  }
  const executorKey = requiredKey(input.executorKey, "Attempt executor key");
  const existing = await findAttemptByExecutorKey(task.id, executorKey, owner);
  if (existing) return existing;
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new MissionTransitionError("A terminal task cannot start a new attempt.");
  }
  const now = new Date().toISOString();
  const attempt: MissionAttempt = {
    id: randomUUID(),
    ...owner,
    missionId: task.missionId,
    taskId: task.id,
    executorKey,
    executorType: safeText(input.executorType || "agent", 80) || "agent",
    executorId: requiredText(input.executorId, 200, "Attempt executor id"),
    fenceToken: randomUUID(),
    status: "queued",
    agentRunId: optionalKey(input.agentRunId),
    workflowRunId: optionalKey(input.workflowRunId),
    input: boundedObject(input.input, 128_000),
    createdAt: now,
    updatedAt: now,
  };
  let created = false;
  let saved: MissionAttempt;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const transactionResult = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const taskRows = await sql`
          SELECT status FROM omni_mission_tasks
          WHERE id = ${task.id} AND tenant_id = ${owner.tenantId}
            AND actor_id = ${owner.actorId}
          FOR UPDATE
        `;
        if (!taskRows[0]) throw new MissionNotFoundError("Mission task not found.");
        const taskStatus = String(taskRows[0].status) as MissionTaskStatus;
        if (taskStatus === "triage" || taskStatus === "review") {
          throw new MissionTransitionError(
            `A task in ${taskStatus} cannot start an execution attempt.`,
          );
        }
        if (TERMINAL_TASK_STATUSES.has(taskStatus)) {
          throw new MissionTransitionError("A terminal task cannot start a new attempt.");
        }
        const rows = await sql`
          INSERT INTO omni_mission_attempts (
            id, tenant_id, actor_id, mission_id, task_id, executor_key, executor_type,
            executor_id, fence_token, status, agent_run_id, workflow_run_id, input,
            created_at, updated_at
          ) VALUES (
            ${attempt.id}, ${attempt.tenantId}, ${attempt.actorId}, ${attempt.missionId},
            ${attempt.taskId}, ${attempt.executorKey}, ${attempt.executorType},
            ${attempt.executorId}, ${attempt.fenceToken}, ${attempt.status},
            ${attempt.agentRunId || null}, ${attempt.workflowRunId || null},
            ${attempt.input}::jsonb, ${now}, ${now}
          )
          ON CONFLICT (tenant_id, actor_id, task_id, executor_key) DO NOTHING
          RETURNING *
        `;
        if (rows[0]) {
          return { created: true, saved: attemptFromRow(rows[0]) };
        }
        const existing = await sql`
          SELECT * FROM omni_mission_attempts
          WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
            AND task_id = ${task.id} AND executor_key = ${executorKey}
          LIMIT 1
        `;
        if (!existing[0]) throw new MissionConflictError("Attempt executor key collided.");
        return { created: false, saved: attemptFromRow(existing[0]) };
      },
    ) as { created: boolean; saved: MissionAttempt };
    created = transactionResult.created;
    saved = transactionResult.saved;
  } else {
    saved = attempt;
    await updateLedger((ledger) => {
      const raced = ledger.attempts.find((item) =>
        item.taskId === task.id && owns(item, owner) && item.executorKey === executorKey
      );
      if (raced) {
        saved = raced;
        return ledger;
      }
      const currentTask = ledger.tasks.find((item) => item.id === task.id && owns(item, owner));
      if (!currentTask) throw new MissionNotFoundError("Mission task not found.");
      if (currentTask.status === "triage" || currentTask.status === "review") {
        throw new MissionTransitionError(
          `A task in ${currentTask.status} cannot start an execution attempt.`,
        );
      }
      if (TERMINAL_TASK_STATUSES.has(currentTask.status)) {
        throw new MissionTransitionError("A terminal task cannot start a new attempt.");
      }
      created = true;
      return { ...ledger, attempts: [attempt, ...ledger.attempts] };
    });
  }

  if (created) {
    await appendMissionLifecycleEventForOwner(saved.missionId, owner, "mission.attempt.created", {
      taskId: saved.taskId,
      attemptId: saved.id,
      status: saved.status,
      executorType: saved.executorType,
    });
  }
  return saved;
}

export async function getMissionAttempt(
  attemptId: string,
  options: MissionOwner,
): Promise<MissionAttempt | undefined> {
  const owner = normalizeOwner(options);
  const id = requiredKey(attemptId, "Attempt id");
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_attempts
      WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      LIMIT 1
    `;
    return rows[0] ? attemptFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.attempts.find((attempt) => attempt.id === id && owns(attempt, owner));
}

export async function findMissionAttemptByExecutor(
  executorType: string,
  executorId: string,
  options: MissionOwner,
): Promise<MissionAttempt | undefined> {
  const owner = normalizeOwner(options);
  const type = requiredKey(executorType, "Attempt executor type");
  const id = requiredText(executorId, 200, "Attempt executor id");
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_attempts
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND executor_type = ${type} AND executor_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? attemptFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.attempts
    .filter((attempt) =>
      owns(attempt, owner) &&
      attempt.executorType === type &&
      attempt.executorId === id
    )
    .sort(compareNewest)[0];
}

export async function listMissionAttempts(
  missionId: string,
  options: MissionOwner,
  limit?: number,
): Promise<MissionAttempt[]> {
  const owner = normalizeOwner(options);
  const id = requiredKey(missionId, "Mission id");
  const bounded = boundedLimit(limit, 1_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_attempts
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND mission_id = ${id}
      ORDER BY created_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(attemptFromRow);
  }
  const ledger = await readLedger();
  return ledger.attempts
    .filter((attempt) => attempt.missionId === id && owns(attempt, owner))
    .sort(compareNewest)
    .slice(0, bounded);
}

export async function transitionMission(
  missionId: string,
  status: MissionStatus,
  options: MissionOwner,
): Promise<Mission> {
  const owner = normalizeOwner(options);
  const current = await requireMission(missionId, owner);
  assertMissionTransition(current.status, status);
  if (current.status === status) return current;
  const now = new Date().toISOString();
  const next: Mission = {
    ...current,
    status,
    startedAt: status === "running" ? current.startedAt || now : current.startedAt,
    terminalAt: TERMINAL_MISSION_STATUSES.has(status) ? now : undefined,
    updatedAt: now,
  };
  let saved: Mission;
  let transitionedFrom: MissionStatus | undefined;
  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      UPDATE omni_missions SET status = ${next.status}, started_at = ${next.startedAt || null},
        terminal_at = ${next.terminalAt || null}, updated_at = ${now}
      WHERE id = ${current.id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND status = ${current.status}
      RETURNING *
    `;
    if (!rows[0]) return resolveMissionTransitionRace(current.id, status, owner);
    saved = missionFromRow(rows[0]);
    transitionedFrom = current.status;
  } else {
    saved = next;
    await updateLedger((ledger) => {
      const index = ledger.missions.findIndex((item) => item.id === current.id && owns(item, owner));
      if (index < 0) throw new MissionNotFoundError("Mission not found.");
      const latest = ledger.missions[index];
      assertMissionTransition(latest.status, status);
      if (latest.status === status) {
        saved = latest;
        return ledger;
      }
      saved = {
        ...latest,
        status,
        startedAt: status === "running" ? latest.startedAt || now : latest.startedAt,
        terminalAt: TERMINAL_MISSION_STATUSES.has(status) ? now : undefined,
        updatedAt: now,
      };
      transitionedFrom = latest.status;
      return { ...ledger, missions: replaceAt(ledger.missions, index, saved) };
    });
  }
  if (transitionedFrom) {
    await appendMissionLifecycleEvent(saved, "mission.status.changed", {
      from: transitionedFrom,
      to: saved.status,
    });
  }
  return saved;
}

export async function transitionMissionTask(
  taskId: string,
  status: MissionTaskStatus,
  options: MissionOwner,
): Promise<MissionTask> {
  const owner = normalizeOwner(options);
  const current = await getMissionTask(taskId, owner);
  if (!current) throw new MissionNotFoundError("Mission task not found.");
  assertTaskReviewGate(current, status);
  assertTaskTransition(current.status, status);
  if (current.status === status) return current;
  if (status === "running") {
    await assertTaskDependenciesSucceeded(current, owner);
  }
  const now = new Date().toISOString();
  const next: MissionTask = {
    ...current,
    status,
    startedAt: status === "running" ? current.startedAt || now : current.startedAt,
    terminalAt: TERMINAL_TASK_STATUSES.has(status) ? now : undefined,
    updatedAt: now,
  };
  let saved: MissionTask;
  let transitionedFrom: MissionTaskStatus | undefined;
  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      UPDATE omni_mission_tasks SET status = ${next.status}, started_at = ${next.startedAt || null},
        terminal_at = ${next.terminalAt || null}, updated_at = ${now}
      WHERE id = ${current.id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND status = ${current.status}
      RETURNING *
    `;
    if (!rows[0]) return resolveTaskTransitionRace(current.id, status, owner);
    saved = taskFromRow(rows[0]);
    transitionedFrom = current.status;
  } else {
    saved = next;
    await updateLedger((ledger) => {
      const index = ledger.tasks.findIndex((item) => item.id === current.id && owns(item, owner));
      if (index < 0) throw new MissionNotFoundError("Mission task not found.");
      const latest = ledger.tasks[index];
      assertTaskReviewGate(latest, status);
      assertTaskTransition(latest.status, status);
      if (latest.status === status) {
        saved = latest;
        return ledger;
      }
      saved = {
        ...latest,
        status,
        startedAt: status === "running" ? latest.startedAt || now : latest.startedAt,
        terminalAt: TERMINAL_TASK_STATUSES.has(status) ? now : undefined,
        updatedAt: now,
      };
      transitionedFrom = latest.status;
      return { ...ledger, tasks: replaceAt(ledger.tasks, index, saved) };
    });
  }
  if (transitionedFrom) {
    await appendMissionLifecycleEventForOwner(saved.missionId, owner, "mission.task.status.changed", {
      taskId: saved.id,
      from: transitionedFrom,
      to: saved.status,
    });
  }
  return saved;
}

export async function transitionMissionAttempt(
  attemptId: string,
  status: MissionAttemptStatus,
  input: {
    fenceToken: string;
    output?: Record<string, unknown>;
    error?: string;
    agentRunId?: string;
    workflowRunId?: string;
  },
  options: MissionOwner,
): Promise<MissionAttempt> {
  const owner = normalizeOwner(options);
  const current = await getMissionAttempt(attemptId, owner);
  if (!current) throw new MissionNotFoundError("Mission attempt not found.");
  assertFence(current, input.fenceToken);
  assertAttemptTransition(current.status, status);
  assertAttemptTerminalFence(current.status, status, input);
  if (current.status === status && !hasAttemptPatch(input)) return current;
  const now = new Date().toISOString();
  const next: MissionAttempt = {
    ...current,
    status,
    agentRunId: optionalKey(input.agentRunId) || current.agentRunId,
    workflowRunId: optionalKey(input.workflowRunId) || current.workflowRunId,
    output: input.output === undefined ? current.output : boundedObject(input.output, 256_000),
    error: input.error === undefined ? current.error : safeTextBlock(input.error, 8_000) || undefined,
    startedAt: status === "running" ? current.startedAt || now : current.startedAt,
    terminalAt: TERMINAL_ATTEMPT_STATUSES.has(status) ? current.terminalAt || now : undefined,
    updatedAt: now,
  };
  let saved: MissionAttempt;
  let transitionedFrom: MissionAttemptStatus | undefined;
  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      UPDATE omni_mission_attempts SET status = ${next.status},
        agent_run_id = ${next.agentRunId || null}, workflow_run_id = ${next.workflowRunId || null},
        output = ${next.output || null}::jsonb, error = ${next.error || null},
        started_at = ${next.startedAt || null}, terminal_at = ${next.terminalAt || null},
        updated_at = ${now}
      WHERE id = ${current.id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND status = ${current.status} AND fence_token = ${current.fenceToken}
      RETURNING *
    `;
    if (!rows[0]) return resolveAttemptTransitionRace(current.id, status, input.fenceToken, owner);
    saved = attemptFromRow(rows[0]);
    if (current.status !== saved.status) transitionedFrom = current.status;
  } else {
    saved = next;
    await updateLedger((ledger) => {
      const index = ledger.attempts.findIndex((item) => item.id === current.id && owns(item, owner));
      if (index < 0) throw new MissionNotFoundError("Mission attempt not found.");
      const latest = ledger.attempts[index];
      assertFence(latest, input.fenceToken);
      assertAttemptTransition(latest.status, status);
      assertAttemptTerminalFence(latest.status, status, input);
      if (latest.status === status && !hasAttemptPatch(input)) {
        saved = latest;
        return ledger;
      }
      saved = {
        ...latest,
        status,
        agentRunId: optionalKey(input.agentRunId) || latest.agentRunId,
        workflowRunId: optionalKey(input.workflowRunId) || latest.workflowRunId,
        output: input.output === undefined ? latest.output : boundedObject(input.output, 256_000),
        error: input.error === undefined ? latest.error : safeTextBlock(input.error, 8_000) || undefined,
        startedAt: status === "running" ? latest.startedAt || now : latest.startedAt,
        terminalAt: TERMINAL_ATTEMPT_STATUSES.has(status) ? latest.terminalAt || now : undefined,
        updatedAt: now,
      };
      if (latest.status !== saved.status) transitionedFrom = latest.status;
      return { ...ledger, attempts: replaceAt(ledger.attempts, index, saved) };
    });
  }
  if (transitionedFrom) {
    await appendMissionLifecycleEventForOwner(saved.missionId, owner, "mission.attempt.status.changed", {
      taskId: saved.taskId,
      attemptId: saved.id,
      from: transitionedFrom,
      to: saved.status,
    });
  }
  return saved;
}

export async function recordMissionArtifact(
  input: {
    tenantId?: string;
    actorId: string;
    missionId: string;
    sourceKey: string;
    taskId?: string;
    attemptId?: string;
    kind?: string;
    title: string;
    uri?: string;
    mimeType?: string;
    data?: Record<string, unknown>;
  },
): Promise<MissionArtifact> {
  const owner = normalizeOwner(input);
  const mission = await requireMission(input.missionId, owner);
  const task = input.taskId ? await getMissionTask(input.taskId, owner) : undefined;
  const attempt = input.attemptId ? await getMissionAttempt(input.attemptId, owner) : undefined;
  if (input.taskId && (!task || task.missionId !== mission.id)) {
    throw new MissionNotFoundError("Artifact task not found in mission.");
  }
  if (input.attemptId && (!attempt || attempt.missionId !== mission.id)) {
    throw new MissionNotFoundError("Artifact attempt not found in mission.");
  }
  if (attempt && task && attempt.taskId !== task.id) {
    throw new MissionConflictError("Artifact attempt does not belong to the selected task.");
  }
  const now = new Date().toISOString();
  const artifact: MissionArtifact = {
    id: randomUUID(),
    ...owner,
    missionId: mission.id,
    taskId: task?.id || attempt?.taskId,
    attemptId: attempt?.id,
    sourceKey: requiredKey(input.sourceKey, "Artifact source key"),
    kind: safeText(input.kind || "result", 80) || "result",
    title: requiredText(input.title, 280, "Artifact title"),
    uri: optionalText(input.uri, 2_048),
    mimeType: optionalText(input.mimeType, 160),
    data: boundedObject(input.data, 1_000_000),
    createdAt: now,
    updatedAt: now,
  };
  let created = false;
  let saved: MissionArtifact;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_mission_artifacts (
        id, tenant_id, actor_id, mission_id, task_id, attempt_id, source_key,
        kind, title, uri, mime_type, data, created_at, updated_at
      ) VALUES (
        ${artifact.id}, ${artifact.tenantId}, ${artifact.actorId}, ${artifact.missionId},
        ${artifact.taskId || null}, ${artifact.attemptId || null}, ${artifact.sourceKey},
        ${artifact.kind}, ${artifact.title}, ${artifact.uri || null}, ${artifact.mimeType || null},
        ${artifact.data}::jsonb, ${now}, ${now}
      )
      ON CONFLICT (tenant_id, actor_id, mission_id, source_key) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) {
      created = true;
      saved = artifactFromRow(rows[0]);
    } else {
      const existing = await getSql()`
        SELECT * FROM omni_mission_artifacts
        WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
          AND mission_id = ${mission.id} AND source_key = ${artifact.sourceKey}
        LIMIT 1
      `;
      if (!existing[0]) throw new MissionConflictError("Artifact source key collided.");
      saved = artifactFromRow(existing[0]);
    }
  } else {
    saved = artifact;
    await updateLedger((ledger) => {
      const existing = ledger.artifacts.find((item) =>
        item.missionId === mission.id && owns(item, owner) && item.sourceKey === artifact.sourceKey
      );
      if (existing) {
        saved = existing;
        return ledger;
      }
      created = true;
      return { ...ledger, artifacts: [artifact, ...ledger.artifacts] };
    });
  }
  if (created) {
    await appendMissionLifecycleEvent(mission, "mission.artifact.recorded", {
      artifactId: saved.id,
      taskId: saved.taskId,
      attemptId: saved.attemptId,
      kind: saved.kind,
    });
  }
  return saved;
}

export async function listMissionArtifacts(
  missionId: string,
  options: MissionOwner,
  limit?: number,
): Promise<MissionArtifact[]> {
  const owner = normalizeOwner(options);
  const id = requiredKey(missionId, "Mission id");
  const bounded = boundedLimit(limit, 1_000);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_artifacts
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND mission_id = ${id}
      ORDER BY created_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(artifactFromRow);
  }
  const ledger = await readLedger();
  return ledger.artifacts
    .filter((artifact) => artifact.missionId === id && owns(artifact, owner))
    .sort(compareNewest)
    .slice(0, bounded);
}

export async function appendMissionLifecycleEvent(
  mission: Pick<Mission, "id" | "tenantId" | "actorId">,
  type: string,
  payload: Record<string, unknown> = {},
) {
  return appendMissionLifecycleEventForOwner(
    mission.id,
    { tenantId: mission.tenantId, actorId: mission.actorId },
    type,
    payload,
  );
}

async function appendMissionLifecycleEventForOwner(
  missionId: string,
  owner: Required<MissionOwner>,
  type: string,
  payload: Record<string, unknown>,
) {
  return appendDomainEventSafely({
    streamId: `mission:${missionId}`,
    type: safeText(type, 120),
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    payload: compactEventPayload(payload),
  });
}

async function requireMission(missionId: string, owner: Required<MissionOwner>) {
  const mission = await getMission(missionId, owner);
  if (!mission) throw new MissionNotFoundError("Mission not found.");
  return mission;
}

async function requireMissionTask(taskId: string, owner: Required<MissionOwner>) {
  const task = await getMissionTask(taskId, owner);
  if (!task) throw new MissionNotFoundError("Mission task not found.");
  return task;
}

async function findAttemptByExecutorKey(
  taskId: string,
  executorKey: string,
  owner: Required<MissionOwner>,
) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_mission_attempts
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
        AND task_id = ${taskId} AND executor_key = ${executorKey}
      LIMIT 1
    `;
    return rows[0] ? attemptFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.attempts.find((attempt) =>
    attempt.taskId === taskId && owns(attempt, owner) && attempt.executorKey === executorKey
  );
}

async function validateTaskReferences(task: MissionTask, owner: Required<MissionOwner>) {
  const tasks = await listMissionTasks(task.missionId, owner);
  validateTaskGraph(task, [...tasks, task]);
}

function validateTaskGraph(candidate: MissionTask, tasks: MissionTask[]) {
  const byId = new Map(
    tasks
      .filter((task) => task.missionId === candidate.missionId)
      .map((task) => [task.id, task.id === candidate.id ? candidate : normalizeStoredTask(task)]),
  );
  byId.set(candidate.id, candidate);

  const references = [
    ...candidate.dependencyIds,
    ...(candidate.parentTaskId ? [candidate.parentTaskId] : []),
  ];
  if (references.includes(candidate.id)) {
    throw new MissionConflictError("A task cannot depend on or parent itself.");
  }
  if (references.some((id) => !byId.has(id))) {
    throw new MissionNotFoundError("Task dependency not found in mission.");
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) {
      throw new MissionConflictError("Task dependencies cannot contain a cycle.");
    }
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) return;
    visiting.add(taskId);
    for (const linkedId of task.dependencyIds) visit(linkedId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of byId.keys()) visit(taskId);
}

async function assertTaskDependenciesSucceeded(
  task: MissionTask,
  owner: Required<MissionOwner>,
) {
  if (!task.dependencyIds.length) return;
  const tasks = await listMissionTasks(task.missionId, owner);
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const unavailable = task.dependencyIds.filter(
    (dependencyId) => byId.get(dependencyId)?.status !== "succeeded",
  );
  if (unavailable.length) {
    throw new MissionTransitionError(
      `Task dependencies must succeed before execution: ${unavailable.join(", ")}.`,
    );
  }
}

async function resolveMissionTransitionRace(
  missionId: string,
  status: MissionStatus,
  owner: Required<MissionOwner>,
): Promise<Mission> {
  const latest = await getMission(missionId, owner);
  if (!latest) throw new MissionNotFoundError("Mission not found.");
  if (latest.status === status) return latest;
  throw new MissionConflictError("Mission status changed concurrently.");
}

async function resolveTaskTransitionRace(
  taskId: string,
  status: MissionTaskStatus,
  owner: Required<MissionOwner>,
): Promise<MissionTask> {
  const latest = await getMissionTask(taskId, owner);
  if (!latest) throw new MissionNotFoundError("Mission task not found.");
  if (latest.status === status) return latest;
  throw new MissionConflictError("Mission task status changed concurrently.");
}

async function resolveAttemptTransitionRace(
  attemptId: string,
  status: MissionAttemptStatus,
  fenceToken: string,
  owner: Required<MissionOwner>,
): Promise<MissionAttempt> {
  const latest = await getMissionAttempt(attemptId, owner);
  if (!latest) throw new MissionNotFoundError("Mission attempt not found.");
  assertFence(latest, fenceToken);
  if (latest.status === status) return latest;
  throw new MissionConflictError("Mission attempt status changed concurrently.");
}

function assertMissionTransition(from: MissionStatus, to: MissionStatus) {
  const transitions: Record<MissionStatus, MissionStatus[]> = {
    draft: ["queued", "running", "canceled"],
    queued: ["running", "waiting", "failed", "canceled"],
    running: ["waiting", "succeeded", "failed", "canceled"],
    waiting: ["running", "succeeded", "failed", "canceled"],
    succeeded: ["archived"],
    failed: ["archived"],
    canceled: ["archived"],
    archived: [],
  };
  if (from !== to && !transitions[from]?.includes(to)) {
    throw new MissionTransitionError(`Mission cannot move from ${from} to ${to}.`);
  }
}

function assertTaskTransition(from: MissionTaskStatus, to: MissionTaskStatus) {
  const transitions: Record<MissionTaskStatus, MissionTaskStatus[]> = {
    triage: ["pending", "canceled"],
    pending: ["triage", "running", "blocked", "review", "succeeded", "failed", "canceled"],
    running: ["blocked", "review", "succeeded", "failed", "canceled"],
    blocked: ["triage", "pending", "running", "failed", "canceled"],
    review: ["pending", "running", "succeeded", "failed", "canceled"],
    succeeded: [],
    failed: [],
    canceled: [],
  };
  if (from !== to && !transitions[from]?.includes(to)) {
    throw new MissionTransitionError(`Mission task cannot move from ${from} to ${to}.`);
  }
}

function assertTaskReviewGate(task: MissionTask, to: MissionTaskStatus) {
  if (
    to === "succeeded" &&
    task.status !== "review" &&
    task.metadata.reviewRequired === true
  ) {
    throw new MissionTransitionError(
      "A review-required task must enter review before it can succeed.",
    );
  }
}

function assertAttemptTransition(from: MissionAttemptStatus, to: MissionAttemptStatus) {
  const transitions: Record<MissionAttemptStatus, MissionAttemptStatus[]> = {
    queued: ["running", "waiting", "succeeded", "failed", "canceled"],
    running: ["waiting", "succeeded", "failed", "canceled"],
    waiting: ["running", "succeeded", "failed", "canceled"],
    succeeded: [],
    failed: [],
    canceled: [],
  };
  if (from !== to && !transitions[from]?.includes(to)) {
    throw new MissionTransitionError(`Mission attempt cannot move from ${from} to ${to}.`);
  }
}

function assertFence(attempt: MissionAttempt, fenceToken: string) {
  if (!fenceToken || attempt.fenceToken !== fenceToken) {
    throw new MissionConflictError("Mission attempt fencing token is stale.");
  }
}

function assertAttemptTerminalFence(
  from: MissionAttemptStatus,
  to: MissionAttemptStatus,
  patch: {
    output?: Record<string, unknown>;
    error?: string;
    agentRunId?: string;
    workflowRunId?: string;
  },
) {
  if (
    TERMINAL_ATTEMPT_STATUSES.has(from) &&
    (
      from !== to ||
      patch.output !== undefined ||
      patch.error !== undefined ||
      patch.agentRunId !== undefined ||
      patch.workflowRunId !== undefined
    )
  ) {
    throw new MissionTransitionError("A terminal mission attempt is immutable.");
  }
}

function hasAttemptPatch(patch: {
  output?: Record<string, unknown>;
  error?: string;
  agentRunId?: string;
  workflowRunId?: string;
}) {
  return patch.output !== undefined ||
    patch.error !== undefined ||
    patch.agentRunId !== undefined ||
    patch.workflowRunId !== undefined;
}

function missionTaskUpdateFields(input: MissionTaskUpdate) {
  const fields: Array<keyof MissionTaskUpdate> = [
    "title",
    "instructions",
    "definitionOfDone",
    "priority",
    "dependencyIds",
    "position",
    "metadata",
  ];
  return fields.filter((field) => input[field] !== undefined);
}

function buildMissionTaskUpdate(
  current: MissionTask,
  input: MissionTaskUpdate,
  updatedAt: string,
): MissionTask {
  return {
    ...current,
    title: input.title === undefined
      ? current.title
      : requiredText(input.title, 280, "Task title"),
    instructions: input.instructions === undefined
      ? current.instructions
      : safeTextBlock(input.instructions, 8_000),
    definitionOfDone: input.definitionOfDone === undefined
      ? current.definitionOfDone
      : safeTextBlock(input.definitionOfDone, 2_000),
    priority: input.priority === undefined
      ? current.priority
      : normalizeMissionPriority(input.priority),
    dependencyIds: input.dependencyIds === undefined
      ? current.dependencyIds
      : sanitizeIds(input.dependencyIds),
    position: input.position === undefined
      ? current.position
      : boundedInteger(input.position, current.position, 0, 100_000),
    metadata: input.metadata === undefined
      ? sanitizeMissionTaskMetadata(current.metadata)
      : sanitizeMissionTaskMetadata(input.metadata, current.metadata),
    updatedAt,
  };
}

function assertExpectedTaskVersion(task: MissionTask, expectedUpdatedAt?: string) {
  if (!expectedUpdatedAt) return;
  const expected = Date.parse(expectedUpdatedAt);
  const actual = Date.parse(task.updatedAt);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    throw new Error("Mission task version must be an ISO timestamp.");
  }
  if (expected !== actual) {
    throw new MissionConflictError("Mission task changed after it was loaded.");
  }
}

function nextUpdatedAt(previous: string) {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(Number.isFinite(prior) && prior >= now ? prior + 1 : now).toISOString();
}

function normalizeMissionPriority(value: MissionPriority): MissionPriority {
  if (!["low", "normal", "high", "urgent"].includes(value)) {
    throw new Error("Mission task priority is invalid.");
  }
  return value;
}

export function sanitizeMissionTaskMetadata(
  value: unknown,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const result = base === undefined ? {} : sanitizeMissionTaskMetadata(base);
  const patch = boundedObject(value, 32_000);

  applyMetadataText(result, patch, "assigneeKey", 200, false);
  applyMetadataText(result, patch, "assigneeName", 160, false);
  applyMetadataText(result, patch, "reviewerKey", 200, false);
  applyMetadataText(result, patch, "reviewerName", 160, false);
  applyMetadataText(result, patch, "reviewSummary", 4_000, true);
  applyMetadataText(result, patch, "changesRequestedReason", 4_000, true);
  applyMetadataDate(result, patch, "scheduledAt");
  applyMetadataDate(result, patch, "reviewRequestedAt");

  if (Object.hasOwn(patch, "skillIds") && patch.skillIds !== undefined) {
    if (patch.skillIds === null) delete result.skillIds;
    else if (Array.isArray(patch.skillIds)) {
      const skillIds = sanitizeIds(patch.skillIds.map(String)).slice(0, 50);
      if (skillIds.length) result.skillIds = skillIds;
      else delete result.skillIds;
    } else {
      throw new Error("Mission task skillIds must be an array.");
    }
  }

  if (Object.hasOwn(patch, "reviewRequired") && patch.reviewRequired !== undefined) {
    if (patch.reviewRequired === null) delete result.reviewRequired;
    else if (typeof patch.reviewRequired === "boolean") {
      result.reviewRequired = patch.reviewRequired;
    } else {
      throw new Error("Mission task reviewRequired must be boolean.");
    }
  }

  if (Object.hasOwn(patch, "blocker") && patch.blocker !== undefined) {
    if (patch.blocker === null) {
      delete result.blocker;
    } else if (patch.blocker && typeof patch.blocker === "object" && !Array.isArray(patch.blocker)) {
      const blocker = patch.blocker as Record<string, unknown>;
      const kind = safeText(blocker.kind, 40) as MissionTaskBlockerKind;
      const reason = safeTextBlock(blocker.reason, 4_000);
      if (!["dependency", "needs_input", "capability", "transient"].includes(kind) || !reason) {
        throw new Error("Mission task blocker requires a supported kind and reason.");
      }
      result.blocker = { kind, reason };
    } else {
      throw new Error("Mission task blocker is invalid.");
    }
  }

  return boundedObject(result, 32_000);
}

function applyMetadataText(
  result: Record<string, unknown>,
  patch: Record<string, unknown>,
  key: string,
  max: number,
  multiline: boolean,
) {
  if (!Object.hasOwn(patch, key) || patch[key] === undefined) return;
  if (patch[key] === null) {
    delete result[key];
    return;
  }
  const normalized = multiline ? safeTextBlock(patch[key], max) : safeText(patch[key], max);
  if (normalized) result[key] = normalized;
  else delete result[key];
}

function applyMetadataDate(
  result: Record<string, unknown>,
  patch: Record<string, unknown>,
  key: string,
) {
  if (!Object.hasOwn(patch, key) || patch[key] === undefined) return;
  if (patch[key] === null || patch[key] === "") {
    delete result[key];
    return;
  }
  const timestamp = Date.parse(String(patch[key]));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Mission task ${key} must be an ISO timestamp.`);
  }
  result[key] = new Date(timestamp).toISOString();
}

function compactDefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

function normalizeStoredTask(task: MissionTask): MissionTask {
  return {
    ...task,
    dependencyIds: sanitizeIds(task.dependencyIds),
    input: boundedObject(task.input, 128_000),
    metadata: sanitizeMissionTaskMetadata(task.metadata),
  };
}

async function readLedger(): Promise<MissionLedger> {
  const ledger = await readJsonFile<MissionLedger>(getMissionsFile(), emptyLedger());
  return {
    missions: ledger.missions || [],
    tasks: (ledger.tasks || []).map(normalizeStoredTask),
    attempts: ledger.attempts || [],
    artifacts: ledger.artifacts || [],
  };
}

function updateLedger(mutate: (ledger: MissionLedger) => MissionLedger) {
  return updateJsonFile<MissionLedger>(getMissionsFile(), emptyLedger(), async (ledger) => {
    const next = mutate({
      missions: ledger.missions || [],
      tasks: (ledger.tasks || []).map(normalizeStoredTask),
      attempts: ledger.attempts || [],
      artifacts: ledger.artifacts || [],
    });
    return {
      missions: next.missions.slice(0, 500),
      tasks: next.tasks.slice(-10_000),
      attempts: next.attempts.slice(0, 20_000),
      artifacts: next.artifacts.slice(0, 10_000),
    };
  });
}

function emptyLedger(): MissionLedger {
  return { missions: [], tasks: [], attempts: [], artifacts: [] };
}

function getMissionsFile() {
  return getDataPath("missions.json");
}

type MissionPhysicalSummary = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  source: string;
  startedAt?: string;
  terminalAt?: string;
  createdAt: string;
  updatedAt: string;
};

function requestMissionRowIsPresent(row: Record<string, unknown>) {
  if (
    row.source_key_collision !== false ||
    row.unsupported_status !== false ||
    (row.mission_present !== true && row.mission_present !== false)
  ) {
    throw new MissionReadConflictError();
  }
  return row.mission_present;
}

function missionPhysicalSummaryFromRow(
  row: Record<string, unknown>,
): MissionPhysicalSummary {
  if (row.source_key_collision !== false) {
    throw new MissionReadConflictError();
  }
  return missionPhysicalSummaryFromValues({
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    priority: row.priority,
    source: row.source,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function missionPhysicalSummaryFromMission(
  mission: Mission,
): MissionPhysicalSummary {
  return missionPhysicalSummaryFromValues({
    id: mission.id,
    tenantId: mission.tenantId,
    actorId: mission.actorId,
    title: mission.title,
    objective: mission.objective,
    status: mission.status,
    priority: mission.priority,
    source: mission.source,
    startedAt: mission.startedAt,
    terminalAt: mission.terminalAt,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  });
}

function missionPhysicalSummaryFromValues(values: {
  id: unknown;
  tenantId: unknown;
  actorId: unknown;
  title: unknown;
  objective: unknown;
  status: unknown;
  priority: unknown;
  source: unknown;
  startedAt: unknown;
  terminalAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}): MissionPhysicalSummary {
  if (typeof values.tenantId !== "string" || typeof values.actorId !== "string") {
    throw new MissionReadConflictError();
  }
  const status = requestMissionStatus(values.status);
  const startedAt = optionalRequestMissionIso(values.startedAt);
  const terminalAt = optionalRequestMissionIso(values.terminalAt);
  const createdAt = requestMissionIso(values.createdAt);
  const updatedAt = requestMissionIso(values.updatedAt);
  if (
    createdAt > updatedAt ||
    (startedAt !== undefined &&
      (startedAt < createdAt || startedAt > updatedAt)) ||
    (terminalAt !== undefined &&
      (terminalAt < createdAt || terminalAt > updatedAt)) ||
    (startedAt !== undefined && terminalAt !== undefined &&
      startedAt > terminalAt) ||
    (status === "running" && startedAt === undefined) ||
    ((status === "draft" || status === "queued") && startedAt !== undefined) ||
    (TERMINAL_MISSION_STATUSES.has(status)
      ? terminalAt === undefined
      : terminalAt !== undefined)
  ) {
    throw new MissionReadConflictError();
  }
  return {
    id: requestMissionIdentifier(values.id),
    tenantId: values.tenantId,
    actorId: values.actorId,
    title: requestMissionLine(values.title, 240),
    objective: requestMissionTextBlock(values.objective, 4_000),
    status,
    priority: requestMissionPriority(values.priority),
    source: requestMissionLine(values.source, 80),
    startedAt,
    terminalAt,
    createdAt,
    updatedAt,
  };
}

function assertRequestMissionSummaries(
  summaries: MissionPhysicalSummary[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (
      summary.tenantId !== tenantId ||
      (summary.actorId !== canonicalActorId &&
        summary.actorId !== exactActorId) ||
      ids.has(summary.id)
    ) {
      throw new MissionReadConflictError();
    }
    ids.add(summary.id);
  }
}

function assertExactFileMissionSourceKeys(missions: Mission[]) {
  const sourceKeys = new Set<string>();
  for (const mission of missions) {
    if (
      typeof mission.sourceKey !== "string" ||
      mission.sourceKey.length < 1 ||
      mission.sourceKey.length > 240 ||
      safeText(mission.sourceKey, 240) !== mission.sourceKey ||
      sourceKeys.has(mission.sourceKey)
    ) {
      throw new MissionReadConflictError();
    }
    sourceKeys.add(mission.sourceKey);
  }
}

function requestMissionSummary(
  summary: MissionPhysicalSummary,
  exactActorId: string,
): RequestMissionSummary {
  const exactOwner = summary.actorId === exactActorId;
  return {
    id: summary.id,
    title: summary.title,
    objective: summary.objective,
    status: summary.status,
    canonicalStatus: canonicalStatusForMission(summary.status),
    priority: summary.priority,
    source: summary.source,
    startedAt: summary.startedAt,
    terminalAt: summary.terminalAt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    detailAvailable: exactOwner,
    manageable: exactOwner,
    runnable: exactOwner,
  };
}

function compareRequestMissionSummaries(
  left: MissionPhysicalSummary,
  right: MissionPhysicalSummary,
) {
  const order: Record<MissionStatus, number> = {
    running: 0,
    waiting: 1,
    queued: 2,
    draft: 3,
    succeeded: 4,
    failed: 5,
    canceled: 6,
    archived: 7,
  };
  const statusOrder = order[left.status] - order[right.status];
  if (statusOrder) return statusOrder;
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function requestMissionIdentifier(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,240}$/.test(value)
  ) {
    throw new MissionReadConflictError();
  }
  return value;
}

function requestMissionLine(value: unknown, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    safeText(value, maximum) !== value
  ) {
    throw new MissionReadConflictError();
  }
  return value;
}

function requestMissionTextBlock(value: unknown, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    safeTextBlock(value, maximum) !== value
  ) {
    throw new MissionReadConflictError();
  }
  return value;
}

function requestMissionStatus(value: unknown): MissionStatus {
  if (
    value !== "draft" &&
    value !== "queued" &&
    value !== "running" &&
    value !== "waiting" &&
    value !== "succeeded" &&
    value !== "failed" &&
    value !== "canceled" &&
    value !== "archived"
  ) {
    throw new MissionReadConflictError();
  }
  return value;
}

function requestMissionPriority(value: unknown): MissionPriority {
  if (
    value !== "low" &&
    value !== "normal" &&
    value !== "high" &&
    value !== "urgent"
  ) {
    throw new MissionReadConflictError();
  }
  return value;
}

function optionalRequestMissionIso(value: unknown) {
  return value === null || value === undefined
    ? undefined
    : requestMissionIso(value);
}

function requestMissionIso(value: unknown) {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new MissionReadConflictError();
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MissionReadConflictError();
  const normalized = parsed.toISOString();
  if (typeof value === "string" && value !== normalized) {
    throw new MissionReadConflictError();
  }
  return normalized;
}

function missionFromRow(row: Record<string, unknown>): Mission {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    title: String(row.title),
    objective: String(row.objective),
    status: String(row.status) as MissionStatus,
    priority: String(row.priority) as MissionPriority,
    source: String(row.source),
    sourceKey: String(row.source_key),
    metadata: jsonObject(row.metadata),
    startedAt: optionalDateValue(row.started_at),
    terminalAt: optionalDateValue(row.terminal_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function taskFromRow(row: Record<string, unknown>): MissionTask {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    missionId: String(row.mission_id),
    parentTaskId: optionalKey(row.parent_task_id),
    title: String(row.title),
    instructions: String(row.instructions || ""),
    definitionOfDone: String(row.definition_of_done || ""),
    status: String(row.status) as MissionTaskStatus,
    priority: String(row.priority) as MissionPriority,
    position: Number(row.position || 0),
    sourceKey: String(row.source_key),
    dependencyIds: stringArray(row.dependency_ids),
    input: jsonObject(row.input),
    metadata: sanitizeMissionTaskMetadata(jsonObject(row.metadata)),
    startedAt: optionalDateValue(row.started_at),
    terminalAt: optionalDateValue(row.terminal_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function attemptFromRow(row: Record<string, unknown>): MissionAttempt {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    missionId: String(row.mission_id),
    taskId: String(row.task_id),
    executorKey: String(row.executor_key),
    executorType: String(row.executor_type),
    executorId: String(row.executor_id),
    fenceToken: String(row.fence_token),
    status: String(row.status) as MissionAttemptStatus,
    agentRunId: optionalKey(row.agent_run_id),
    workflowRunId: optionalKey(row.workflow_run_id),
    input: jsonObject(row.input),
    output: row.output === null || row.output === undefined ? undefined : jsonObject(row.output),
    error: optionalText(row.error, 8_000),
    startedAt: optionalDateValue(row.started_at),
    terminalAt: optionalDateValue(row.terminal_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function artifactFromRow(row: Record<string, unknown>): MissionArtifact {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    missionId: String(row.mission_id),
    taskId: optionalKey(row.task_id),
    attemptId: optionalKey(row.attempt_id),
    sourceKey: String(row.source_key),
    kind: String(row.kind),
    title: String(row.title),
    uri: optionalText(row.uri, 2_048),
    mimeType: optionalText(row.mime_type, 160),
    data: jsonObject(row.data),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function normalizeOwner(input: MissionOwner): Required<MissionOwner> {
  const actorId = safeText(input.actorId, 200);
  if (!actorId) throw new Error("An actor id is required for mission storage.");
  return {
    tenantId: normalizeTenantId(input.tenantId),
    actorId,
  };
}

function normalizeTenantId(value?: string) {
  return (
    value ||
    getDatabaseTenantContext() ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default"
  ).trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function owns(
  value: { tenantId: string; actorId: string },
  owner: Required<MissionOwner>,
) {
  return value.tenantId === owner.tenantId && value.actorId === owner.actorId;
}

function requiredText(value: unknown, max: number, label: string) {
  const text = safeText(value, max);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredTextBlock(value: unknown, max: number, label: string) {
  const text = safeTextBlock(value, max);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredKey(value: unknown, label: string) {
  const key = safeText(value, 240);
  if (!key) throw new Error(`${label} is required.`);
  return key;
}

function optionalKey(value: unknown) {
  const key = safeText(value, 240);
  return key || undefined;
}

function optionalText(value: unknown, max: number) {
  const text = safeTextBlock(value, max);
  return text || undefined;
}

function safeText(value: unknown, max: number) {
  return String(redactSensitive(String(value || "")))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeTextBlock(value: unknown, max: number) {
  return String(redactSensitive(String(value || ""))).trim().slice(0, max);
}

function boundedObject(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const redacted = redactSensitive(value) as Record<string, unknown>;
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    throw new Error("Mission payload must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`Mission payload exceeds ${maxBytes} bytes.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function compactEventPayload(payload: Record<string, unknown>) {
  const compact = Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, 12),
  );
  return boundedObject(compact, 8_000);
}

function sanitizeIds(values?: string[]) {
  return [...new Set((values || []).map((value) => safeText(value, 240)).filter(Boolean))].slice(0, 100);
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return sanitizeIds(value.map(String));
  if (typeof value === "string") {
    try {
      return stringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(Math.max(Math.trunc(value), min), max);
}

function boundedLimit(value: number | undefined, fallback: number) {
  return boundedInteger(value, fallback, 1, 1_000);
}

function optionalDateValue(value: unknown) {
  return value ? dateValue(value) : undefined;
}

function dateValue(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function replaceAt<T>(values: T[], index: number, value: T) {
  const next = [...values];
  next[index] = value;
  return next;
}

function compareMissions(left: Mission, right: Mission) {
  const order: Record<MissionStatus, number> = {
    running: 0,
    waiting: 1,
    queued: 2,
    draft: 3,
    succeeded: 4,
    failed: 5,
    canceled: 6,
    archived: 7,
  };
  return order[left.status] - order[right.status] || right.updatedAt.localeCompare(left.updatedAt);
}

function compareTasks(left: MissionTask, right: MissionTask) {
  return left.position - right.position || left.createdAt.localeCompare(right.createdAt);
}

function compareNewest<T extends { createdAt: string }>(left: T, right: T) {
  return right.createdAt.localeCompare(left.createdAt);
}
