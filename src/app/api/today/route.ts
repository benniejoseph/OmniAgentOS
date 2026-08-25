import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { listMemories } from "@/lib/memory/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { listThreads } from "@/lib/threads/store";
import { createTodayItem, listTodayItems } from "@/lib/today/store";
import { getTodayBriefBundle } from "@/lib/today/briefs";
import { listProjects, listProjectTasks } from "@/lib/projects/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  title: z.string().trim().min(1).max(280),
  kind: z.enum(["task", "reminder"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueAt: z.string().datetime().optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "today" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const [items, threads, memories, briefBundle, projects] = await Promise.all([
    listTodayItems(100, { tenantId: context.tenantId, actorId: context.actorId }),
    listThreads(6, { tenantId: context.tenantId, actorId: context.actorId }),
    listMemories({ tenantId: context.tenantId, limit: 6 }),
    getTodayBriefBundle({ tenantId: context.tenantId, actorId: context.actorId }),
    listProjects(6, { tenantId: context.tenantId, actorId: context.actorId }),
  ]);
  const activeProjects = projects.filter((project) => project.status === "active").slice(0, 4);
  const projectTasks = await Promise.all(activeProjects.map((project) =>
    listProjectTasks(project.id, { tenantId: context.tenantId })
  ));
  const now = Date.now();
  const leadMs = briefBundle.preferences.reminderLeadMinutes * 60_000;
  return Response.json({
    generatedAt: new Date().toISOString(),
    items: items.map((item) => ({
      ...item,
      reminderState: !item.dueAt || item.status === "done"
        ? "none"
        : Date.parse(item.dueAt) < now
          ? "overdue"
          : Date.parse(item.dueAt) <= now + leadMs
            ? "due_soon"
            : "later",
    })),
    threads,
    memories: memories.map((memory) => ({
      id: memory.id,
      title: memory.title,
      content: memory.content.slice(0, 240),
      type: memory.type,
      updatedAt: memory.updatedAt,
    })),
    brief: briefBundle.brief,
    preferences: briefBundle.preferences,
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
  }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid focus item", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "today_item" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const item = await createTodayItem({
    tenantId: context.tenantId,
    actorId: context.actorId,
    ...parsed.data,
  });
  return Response.json({ item }, { status: 201 });
}
