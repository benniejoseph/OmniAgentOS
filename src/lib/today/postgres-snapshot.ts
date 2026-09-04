import {
  ensureDatabaseSchema,
  getSql,
} from "@/lib/db/client";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import {
  isBriefGenerationDue,
  localScheduleParts,
  todayPreferenceActorReadOrder,
} from "@/lib/today/briefs";
import type { TodaySnapshot } from "@/lib/today/snapshot";

const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const MAX_JSON_TEXT_LENGTH = 2_000_000;

type PostgresTodaySnapshotOptions = {
  tenantId: string;
  actorId: string;
  now?: Date;
  requestActorBinding?: CanonicalRequestActorBindingV1;
};

/**
 * Loads the complete Today projection through one tenant-scoped transaction
 * and one aggregate statement. This is the cold-path counterpart to the
 * shared Today data cache; callers must already hold an authorized owner
 * scope, and every source remains explicitly tenant/actor constrained.
 */
export async function loadPostgresTodaySnapshot({
  tenantId,
  actorId,
  now = new Date(),
  requestActorBinding,
}: PostgresTodaySnapshotOptions): Promise<TodaySnapshot> {
  const safeTenantId = requiredScopeValue(tenantId, 120, "tenant");
  const safeActorId = requiredScopeValue(actorId, 200, "actor");
  const preferenceActorReadOrder = todayPreferenceActorReadOrder(
    actorId,
    requestActorBinding,
    safeActorId,
  );
  const canonicalPreferenceActorId = preferenceActorReadOrder[0];
  const exactPreferenceActorId = preferenceActorReadOrder[1];
  const nowIso = validDate(now) ? now.toISOString() : new Date().toISOString();
  const wallClockIso = new Date().toISOString();
  const fallbackTimezone = defaultTimezone();
  const [yesterday, utcToday, tomorrow] = utcCandidateDates(new Date(nowIso));
  const statementTimeoutMs = configuredStatementTimeoutMs();

  await ensureDatabaseSchema();
  const rows = await getSql().transaction(
    async (sql: ReturnType<typeof getSql>) => {
      await sql`
        SELECT
          set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
          set_config('lock_timeout', ${String(Math.min(statementTimeoutMs, 1_000))}, true)
      `;
      return sql`
      WITH runtime_settings AS MATERIALIZED (
        SELECT 1 AS ready
      ),
      matched_preferences AS MATERIALIZED (
        SELECT
          preferences.tenant_id,
          preferences.actor_id,
          preferences.brief_enabled,
          preferences.brief_time,
          preferences.timezone,
          preferences.reminder_lead_minutes,
          preferences.notifications_enabled,
          preferences.quiet_hours_enabled,
          preferences.quiet_hours_start,
          preferences.quiet_hours_end,
          preferences.created_at,
          preferences.updated_at,
          CASE
            WHEN preferences.actor_id = ${canonicalPreferenceActorId} THEN 0
            ELSE 1
          END AS preference_rank
        FROM omni_today_preferences preferences
        CROSS JOIN runtime_settings
        WHERE preferences.tenant_id = ${safeTenantId}
          AND (
            preferences.actor_id = ${canonicalPreferenceActorId}
            OR preferences.actor_id = ${exactPreferenceActorId}
          )
        ORDER BY preference_rank ASC, preferences.actor_id ASC
        LIMIT 2
      ),
      preference_match_state AS MATERIALIZED (
        SELECT COUNT(*)::int AS preference_match_count
        FROM matched_preferences
      ),
      existing_preferences AS MATERIALIZED (
        SELECT
          matched.tenant_id,
          matched.actor_id,
          matched.brief_enabled,
          matched.brief_time,
          matched.timezone,
          matched.reminder_lead_minutes,
          matched.notifications_enabled,
          matched.quiet_hours_enabled,
          matched.quiet_hours_start,
          matched.quiet_hours_end,
          matched.created_at,
          matched.updated_at
        FROM matched_preferences matched
        CROSS JOIN preference_match_state state
        WHERE state.preference_match_count = 1
        ORDER BY matched.preference_rank ASC, matched.actor_id ASC
        LIMIT 1
      ),
      inserted_preferences AS (
        INSERT INTO omni_today_preferences (
          tenant_id, actor_id, brief_enabled, brief_time, timezone,
          reminder_lead_minutes, notifications_enabled, quiet_hours_enabled,
          quiet_hours_start, quiet_hours_end, created_at, updated_at
        )
        SELECT
          ${safeTenantId}, ${exactPreferenceActorId}, TRUE, '08:00', ${fallbackTimezone},
          30, TRUE, TRUE, '22:00', '07:00', ${wallClockIso}, ${wallClockIso}
        FROM runtime_settings
        CROSS JOIN preference_match_state state
        WHERE state.preference_match_count = 0
          AND NOT EXISTS (SELECT 1 FROM existing_preferences)
        ON CONFLICT (tenant_id, actor_id) DO UPDATE
          SET updated_at = omni_today_preferences.updated_at
        RETURNING
          tenant_id, actor_id, brief_enabled, brief_time, timezone,
          reminder_lead_minutes, notifications_enabled, quiet_hours_enabled,
          quiet_hours_start, quiet_hours_end, created_at, updated_at
      ),
      owner_preferences AS MATERIALIZED (
        SELECT * FROM inserted_preferences
        UNION ALL
        SELECT existing_preferences.*
        FROM existing_preferences
        WHERE NOT EXISTS (SELECT 1 FROM inserted_preferences)
        LIMIT 1
      ),
      item_rows AS MATERIALIZED (
        SELECT
          items.id,
          items.title,
          items.kind,
          items.priority,
          items.status,
          items.due_at,
          items.completed_at,
          items.created_at,
          items.updated_at,
          CASE items.status WHEN 'open' THEN 0 ELSE 1 END AS status_rank
        FROM omni_today_items items
        CROSS JOIN runtime_settings
        WHERE items.tenant_id = ${safeTenantId}
          AND items.actor_id = ${safeActorId}
        ORDER BY
          CASE items.status WHEN 'open' THEN 0 ELSE 1 END,
          items.due_at ASC NULLS LAST,
          items.created_at DESC
        LIMIT 100
      ),
      thread_rows AS MATERIALIZED (
        SELECT threads.id, threads.title, threads.updated_at
        FROM omni_threads threads
        CROSS JOIN runtime_settings
        WHERE threads.tenant_id = ${safeTenantId}
          AND threads.actor_id = ${safeActorId}
        ORDER BY threads.updated_at DESC
        LIMIT 6
      ),
      memory_rows AS MATERIALIZED (
        SELECT
          memories.id,
          memories.title,
          memories.content,
          memories.type,
          memories.updated_at
        FROM omni_memories memories
        CROSS JOIN runtime_settings
        WHERE memories.tenant_id = ${safeTenantId}
          AND memories.claim_status = 'active'
          AND (memories.valid_from IS NULL OR memories.valid_from <= NOW())
          AND (memories.valid_to IS NULL OR memories.valid_to > NOW())
        ORDER BY memories.updated_at DESC
        LIMIT 6
      ),
      brief_rows AS MATERIALIZED (
        SELECT
          briefs.id,
          briefs.local_date,
          briefs.content,
          briefs.generated_by,
          briefs.model,
          briefs.source_counts,
          briefs.generated_at
        FROM omni_daily_briefs briefs
        CROSS JOIN runtime_settings
        WHERE briefs.tenant_id = ${safeTenantId}
          AND briefs.actor_id = ${safeActorId}
          AND briefs.local_date IN (${yesterday}, ${utcToday}, ${tomorrow})
        ORDER BY briefs.local_date ASC, briefs.generated_at DESC
        LIMIT 3
      ),
      active_projects AS MATERIALIZED (
        SELECT
          projects.id,
          projects.title,
          projects.objective,
          projects.target_date,
          projects.updated_at
        FROM omni_projects projects
        CROSS JOIN runtime_settings
        WHERE projects.tenant_id = ${safeTenantId}
          AND projects.actor_id = ${safeActorId}
          AND projects.status = 'active'
        ORDER BY projects.updated_at DESC
        LIMIT 4
      ),
      project_rows AS MATERIALIZED (
        SELECT
          projects.id,
          projects.title,
          projects.objective,
          projects.target_date,
          projects.updated_at,
          COALESCE(task_stats.completed_tasks, 0)::int AS completed_tasks,
          COALESCE(task_stats.total_tasks, 0)::int AS total_tasks,
          task_stats.next_task
        FROM active_projects projects
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE task_window.status = 'done')::int AS completed_tasks,
            COUNT(*)::int AS total_tasks,
            (ARRAY_AGG(
              task_window.title
              ORDER BY task_window.position ASC, task_window.created_at ASC
            ) FILTER (WHERE task_window.status <> 'done'))[1] AS next_task
          FROM (
            SELECT tasks.title, tasks.status, tasks.position, tasks.created_at
            FROM omni_project_tasks tasks
            WHERE tasks.tenant_id = ${safeTenantId}
              AND tasks.project_id = projects.id
              AND EXISTS (
                SELECT 1
                FROM omni_projects owner_project
                WHERE owner_project.id = tasks.project_id
                  AND owner_project.tenant_id = ${safeTenantId}
                  AND owner_project.actor_id = ${safeActorId}
              )
            ORDER BY tasks.position ASC, tasks.created_at ASC
            LIMIT 500
          ) task_window
        ) task_stats ON TRUE
      )
      SELECT
        (SELECT preference_match_count FROM preference_match_state) AS preference_match_count,
        COALESCE((
          SELECT jsonb_agg(
            to_jsonb(item_rows) - 'status_rank'
            ORDER BY status_rank ASC, due_at ASC NULLS LAST, created_at DESC
          )
          FROM item_rows
        ), '[]'::jsonb) AS items,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(thread_rows) ORDER BY updated_at DESC)
          FROM thread_rows
        ), '[]'::jsonb) AS threads,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(memory_rows) ORDER BY updated_at DESC)
          FROM memory_rows
        ), '[]'::jsonb) AS memories,
        (SELECT to_jsonb(owner_preferences) FROM owner_preferences LIMIT 1) AS preferences,
        COALESCE((
          SELECT jsonb_agg(
            to_jsonb(brief_rows)
            ORDER BY local_date ASC, generated_at DESC
          )
          FROM brief_rows
        ), '[]'::jsonb) AS briefs,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(project_rows) ORDER BY updated_at DESC)
          FROM project_rows
        ), '[]'::jsonb) AS projects
      FROM runtime_settings
    `;
    },
  ) as Record<string, unknown>[];

  const aggregate = requireAggregateRow(rows[0]);
  return projectSnapshot(aggregate, {
    tenantId: safeTenantId,
    actorId: safeActorId,
    fallbackTimezone,
    now: new Date(nowIso),
  });
}

function requireAggregateRow(row: Record<string, unknown> | undefined) {
  if (!row) {
    throw new Error("Today snapshot aggregate returned no row.");
  }
  const rawPreferenceMatchCount = row.preference_match_count;
  const preferenceMatchCount = Number(rawPreferenceMatchCount);
  if (
    rawPreferenceMatchCount === null ||
    rawPreferenceMatchCount === undefined ||
    !Number.isInteger(preferenceMatchCount) ||
    preferenceMatchCount < 0 ||
    preferenceMatchCount > 2
  ) {
    throw new Error("Today snapshot aggregate returned an invalid preference match count.");
  }
  if (preferenceMatchCount > 1) {
    throw new Error("Today preferences resolved to multiple physical rows.");
  }
  for (const field of ["items", "threads", "memories", "briefs", "projects"] as const) {
    if (!Array.isArray(parseJsonValue(row[field]))) {
      throw new Error(`Today snapshot aggregate returned invalid ${field}.`);
    }
  }
  return row;
}

function projectSnapshot(
  row: Record<string, unknown>,
  context: {
    tenantId: string;
    actorId: string;
    fallbackTimezone: string;
    now: Date;
  },
): TodaySnapshot {
  const preferences = projectPreferences(
    asRecord(row.preferences),
    context,
  );
  const local = localScheduleParts(context.now, preferences.timezone);
  const briefRow = asRecordArray(row.briefs, 3)
    .find((candidate) => safeText(candidate.local_date, 10) === local.date);
  const brief = briefRow ? projectBrief(briefRow) : undefined;
  const nowMs = context.now.getTime();
  const reminderLeadMs = preferences.reminderLeadMinutes * 60_000;

  return {
    generatedAt: context.now.toISOString(),
    items: asRecordArray(row.items, 100).map((item) => {
      const dueAt = optionalDate(item.due_at);
      const status = itemStatus(item.status);
      return {
        id: safeText(item.id, 200),
        title: safeText(item.title, 280),
        kind: itemKind(item.kind),
        priority: itemPriority(item.priority),
        status,
        dueAt,
        completedAt: optionalDate(item.completed_at),
        createdAt: requiredDate(item.created_at),
        updatedAt: requiredDate(item.updated_at),
        reminderState: reminderState({
          dueAt,
          status,
          nowMs,
          reminderLeadMs,
        }),
      };
    }),
    threads: asRecordArray(row.threads, 6).map((thread) => ({
      id: safeText(thread.id, 200),
      title: safeTextBlock(thread.title, 90),
      updatedAt: requiredDate(thread.updated_at),
    })),
    memories: asRecordArray(row.memories, 6).map((memory) => ({
      id: safeText(memory.id, 200),
      title: safeTextBlock(memory.title, 240),
      content: safeTextBlock(memory.content, 200_000).slice(0, 240),
      type: memoryType(memory.type),
      updatedAt: requiredDate(memory.updated_at),
    })),
    brief,
    preferences: {
      briefEnabled: preferences.briefEnabled,
      briefTime: preferences.briefTime,
      timezone: preferences.timezone,
      reminderLeadMinutes: preferences.reminderLeadMinutes,
      notificationsEnabled: preferences.notificationsEnabled,
      quietHoursEnabled: preferences.quietHoursEnabled,
      quietHoursStart: preferences.quietHoursStart,
      quietHoursEnd: preferences.quietHoursEnd,
    },
    briefLocalDate: local.date,
    briefGenerationDue:
      isBriefGenerationDue(preferences, context.now) && !brief,
    projects: asRecordArray(row.projects, 4).map((project) => ({
      id: safeText(project.id, 200),
      title: safeText(project.title, 180),
      objective: safeText(project.objective, 2_000),
      targetDate: optionalDate(project.target_date),
      completedTasks: boundedCount(project.completed_tasks, 500),
      totalTasks: boundedCount(project.total_tasks, 500),
      nextTask: optionalSafeText(project.next_task, 240),
    })),
  };
}

function projectPreferences(
  value: Record<string, unknown>,
  context: { tenantId: string; actorId: string; fallbackTimezone: string; now: Date },
) {
  const reminderLead = Number(value.reminder_lead_minutes);
  const storedTimezone = String(value.timezone || "");
  return {
    tenantId: context.tenantId,
    actorId: context.actorId,
    briefEnabled: booleanValue(value.brief_enabled, true),
    briefTime: validTime(value.brief_time, "08:00"),
    timezone: storedTimezone
      ? validTimezone(storedTimezone, "UTC")
      : context.fallbackTimezone,
    reminderLeadMinutes: [5, 15, 30, 60, 120].includes(reminderLead)
      ? reminderLead
      : 30,
    notificationsEnabled: booleanValue(value.notifications_enabled, true),
    quietHoursEnabled: booleanValue(value.quiet_hours_enabled, true),
    quietHoursStart: validTime(value.quiet_hours_start, "22:00"),
    quietHoursEnd: validTime(value.quiet_hours_end, "07:00"),
    createdAt: optionalDate(value.created_at) || context.now.toISOString(),
    updatedAt: optionalDate(value.updated_at) || context.now.toISOString(),
  };
}

function projectBrief(row: Record<string, unknown>) {
  const content = asRecord(parseJsonValue(row.content));
  const sourceCounts = asRecord(parseJsonValue(row.source_counts));
  return {
    localDate: safeText(row.local_date, 10),
    summary: safeText(content.summary || "Your brief is ready.", 600),
    focus: asRecordArray(content.focus, 5).map((item) => ({
      title: safeText(item.title, 180),
      reason: safeText(item.reason, 240),
    })),
    watchouts: asArray(content.watchouts, 4).map((item) => safeText(item, 240)),
    resurfaced: asRecordArray(content.resurfaced, 3).map((item) => ({
      title: safeText(item.title, 180),
      context: safeText(item.context, 240),
    })),
    generatedBy: String(row.generated_by) === "ai" ? "ai" as const : "system" as const,
    model: optionalSafeText(row.model, 200),
    sourceCounts: {
      items: boundedCount(sourceCounts.items, 1_000_000),
      memories: boundedCount(sourceCounts.memories, 1_000_000),
      threads: boundedCount(sourceCounts.threads, 1_000_000),
      activeWork: boundedCount(sourceCounts.activeWork, 1_000_000),
      projects: boundedCount(sourceCounts.projects, 1_000_000),
    },
    generatedAt: requiredDate(row.generated_at),
  };
}

function reminderState({
  dueAt,
  status,
  nowMs,
  reminderLeadMs,
}: {
  dueAt?: string;
  status: "open" | "done";
  nowMs: number;
  reminderLeadMs: number;
}): "none" | "overdue" | "due_soon" | "later" {
  if (!dueAt || status === "done") return "none";
  const dueMs = Date.parse(dueAt);
  if (dueMs < nowMs) return "overdue";
  if (dueMs <= nowMs + reminderLeadMs) return "due_soon";
  return "later";
}

function asRecordArray(value: unknown, limit: number) {
  return asArray(parseJsonValue(value), limit)
    .map(asRecord)
    .filter((item) => Object.keys(item).length > 0);
}

function asArray(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  if (value.length > MAX_JSON_TEXT_LENGTH) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function requiredScopeValue(value: string, max: number, name: string) {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`A ${name} id is required for the Today snapshot.`);
  return normalized;
}

function safeText(value: unknown, max: number) {
  return safeTextBlock(value, max).replace(/\s+/g, " ").trim().slice(0, max);
}

function safeTextBlock(value: unknown, max: number) {
  return String(redactSensitive(String(value ?? ""))).trim().slice(0, max);
}

function optionalSafeText(value: unknown, max: number) {
  const text = safeText(value, max);
  return text || undefined;
}

function optionalDate(value: unknown) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return validDate(date) ? date.toISOString() : undefined;
}

function requiredDate(value: unknown) {
  return optionalDate(value) || new Date(0).toISOString();
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function validTime(value: unknown, fallback: string) {
  const text = String(value || "");
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function validTimezone(value: unknown, fallback: string) {
  const timezone = String(value || "");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return fallback;
  }
}

function defaultTimezone() {
  return validTimezone(
    process.env.OMNIAGENT_TIME_ZONE ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
    "UTC",
  );
}

function boundedCount(value: unknown, max: number) {
  const count = Number(value);
  return Number.isFinite(count)
    ? Math.min(Math.max(Math.trunc(count), 0), max)
    : 0;
}

function configuredStatementTimeoutMs() {
  const configured = Number(process.env.OMNIAGENT_TODAY_SNAPSHOT_STATEMENT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(configured), 1_000), 15_000);
}

function utcCandidateDates(now: Date) {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return [-1, 0, 1].map((offset) =>
    new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10)
  );
}

function itemKind(value: unknown): "task" | "reminder" {
  return value === "reminder" ? "reminder" : "task";
}

function itemPriority(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "high" ? value : "medium";
}

function itemStatus(value: unknown): "open" | "done" {
  return value === "done" ? "done" : "open";
}

function memoryType(value: unknown): TodaySnapshot["memories"][number]["type"] {
  const allowed = new Set([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]);
  const type = String(value);
  return allowed.has(type)
    ? type as TodaySnapshot["memories"][number]["type"]
    : "fact";
}
