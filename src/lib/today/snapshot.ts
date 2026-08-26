import { listMemories } from "@/lib/memory/store";
import { listProjects, listProjectTasks } from "@/lib/projects/store";
import { listThreads } from "@/lib/threads/store";
import { getTodayBriefBundle } from "@/lib/today/briefs";
import { listTodayItems } from "@/lib/today/store";

export type TodaySnapshot = Awaited<ReturnType<typeof loadTodaySnapshot>>;

/**
 * Builds the browser-safe Today projection for an already-authorized owner.
 * This deliberately has no cross-request cache: reminder state and owner
 * mutations must be visible immediately, and callers provide the full scope.
 */
export async function loadTodaySnapshot({
  tenantId,
  actorId,
  now = new Date(),
}: {
  tenantId: string;
  actorId: string;
  now?: Date;
}) {
  const [items, threads, memories, briefBundle, projects] = await Promise.all([
    listTodayItems(100, { tenantId, actorId }),
    listThreads(6, { tenantId, actorId }),
    listMemories({ tenantId, limit: 6 }),
    getTodayBriefBundle({ tenantId, actorId, now }),
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
