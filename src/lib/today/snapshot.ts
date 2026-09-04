import {
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { listMemories } from "@/lib/memory/store";
import { listProjects, listProjectTasks } from "@/lib/projects/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { listThreads } from "@/lib/threads/store";
import { todayActorReadOrder } from "@/lib/today/actor-scope";
import { getTodayBriefBundle } from "@/lib/today/briefs";
import { loadPostgresTodaySnapshot } from "@/lib/today/postgres-snapshot";
import { loadCachedTodaySnapshot } from "@/lib/today/snapshot-cache";
import { listTodayItems } from "@/lib/today/store";

export type TodaySnapshot = Awaited<ReturnType<typeof readLocalTodaySnapshot>>;

/**
 * Builds the browser-safe Today projection for an already-authorized owner.
 * Canonical-bound session/mobile reads use Next's shared data cache so warm
 * server renders avoid repeating the dashboard's fan-out reads. Exact-only
 * contexts bypass it so they cannot share a cached preference authority with
 * an authenticated request using the same historical actor id. Explicit `now`
 * values also bypass the cache for deterministic jobs and tests. Cache keys
 * and invalidation tags remain scoped to the existing tenant/request actor.
 */
export async function loadTodaySnapshot({
  tenantId,
  actorId,
  now,
  requestActorBinding,
}: {
  tenantId: string;
  actorId: string;
  now?: Date;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<TodaySnapshot> {
  const hasCanonicalTodayBinding = requestActorBinding
    ? todayActorReadOrder(actorId, requestActorBinding)[0] !== actorId
    : false;
  const readScopedSnapshot = () => runWithDatabaseTenantScope(
    tenantId,
    () => readTodaySnapshot({
      tenantId,
      actorId,
      now: now || new Date(),
      requestActorBinding,
    }),
  );
  if (now || !hasCanonicalTodayBinding) {
    return readScopedSnapshot();
  }
  return loadCachedTodaySnapshot(
    { tenantId, actorId },
    readScopedSnapshot,
  );
}

async function readTodaySnapshot({
  tenantId,
  actorId,
  now,
  requestActorBinding,
}: {
  tenantId: string;
  actorId: string;
  now: Date;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<TodaySnapshot> {
  if (hasDatabaseUrl()) {
    return loadPostgresTodaySnapshot({
      tenantId,
      actorId,
      now,
      requestActorBinding,
    });
  }

  return readLocalTodaySnapshot({
    tenantId,
    actorId,
    now,
    requestActorBinding,
  });
}

async function readLocalTodaySnapshot({
  tenantId,
  actorId,
  now,
  requestActorBinding,
}: {
  tenantId: string;
  actorId: string;
  now: Date;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}) {
  const [items, threads, memories, briefBundle, projects] = await Promise.all([
    listTodayItems(100, { tenantId, actorId, requestActorBinding }),
    listThreads(6, { tenantId, actorId }),
    listMemories({ tenantId, limit: 6 }),
    getTodayBriefBundle({ tenantId, actorId, now, requestActorBinding }),
    listProjects(6, { tenantId, actorId }),
  ]);
  const activeProjects = projects
    .filter((project) => project.status === "active")
    .slice(0, 4);
  const projectTasks = await Promise.all(
    activeProjects.map((project) => listProjectTasks(project.id, { tenantId })),
  );
  const nowMs = now.getTime();
  const leadMs = briefBundle.preferences.reminderLeadMinutes * 60_000;

  return {
    generatedAt: now.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      priority: item.priority,
      status: item.status,
      dueAt: item.dueAt,
      completedAt: item.completedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      reminderState: !item.dueAt || item.status === "done"
        ? "none" as const
        : Date.parse(item.dueAt) < nowMs
          ? "overdue" as const
          : Date.parse(item.dueAt) <= nowMs + leadMs
            ? "due_soon" as const
            : "later" as const,
    })),
    threads: threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
    })),
    memories: memories.map((memory) => ({
      id: memory.id,
      title: memory.title,
      content: memory.content.slice(0, 240),
      type: memory.type,
      updatedAt: memory.updatedAt,
    })),
    brief: briefBundle.brief
      ? {
          localDate: briefBundle.brief.localDate,
          summary: briefBundle.brief.summary,
          focus: briefBundle.brief.focus,
          watchouts: briefBundle.brief.watchouts,
          resurfaced: briefBundle.brief.resurfaced,
          generatedBy: briefBundle.brief.generatedBy,
          model: briefBundle.brief.model,
          sourceCounts: briefBundle.brief.sourceCounts,
          generatedAt: briefBundle.brief.generatedAt,
        }
      : undefined,
    preferences: {
      briefEnabled: briefBundle.preferences.briefEnabled,
      briefTime: briefBundle.preferences.briefTime,
      timezone: briefBundle.preferences.timezone,
      reminderLeadMinutes: briefBundle.preferences.reminderLeadMinutes,
      notificationsEnabled: briefBundle.preferences.notificationsEnabled,
      quietHoursEnabled: briefBundle.preferences.quietHoursEnabled,
      quietHoursStart: briefBundle.preferences.quietHoursStart,
      quietHoursEnd: briefBundle.preferences.quietHoursEnd,
    },
    briefLocalDate: briefBundle.localDate,
    briefGenerationDue: briefBundle.generationDue,
    projects: activeProjects.map((project, index) => ({
      id: project.id,
      title: project.title,
      objective: project.objective,
      targetDate: project.targetDate,
      completedTasks: projectTasks[index].filter((task) => task.status === "done").length,
      totalTasks: projectTasks[index].length,
      nextTask: projectTasks[index].find((task) => task.status !== "done")?.title,
    })),
  };
}
