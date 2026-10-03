import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { resolveOwnedSearchWork } from "@/lib/content-search/work-reader";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showProjectService, showProjectTaskService } from "@/lib/app-services/projects";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  const taskId = new URL(request.url).searchParams.get("task") ?? undefined;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "project", resourceId: id }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  try {
    const readable = await resolveOwnedSearchWork({ tenantId: context.tenantId, actorId: context.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context), projectId: id, taskId });
    if (!readable) return Response.json({ error: "This Work result is no longer available." }, { status: 404, headers });
    const caller = createAppServiceCaller({ context });
    const result = await showProjectService(caller, { projectId: id, taskLimit: 200, artifactLimit: 200 });
    if (!result.data.project) return Response.json({ error: "This project is no longer available." }, { status: 404, headers });
    const project = result.data.project;
    let tasks = project.tasks;
    if (taskId) {
      const task = (await showProjectTaskService(caller, { projectId: id, taskId })).data.task;
      if (!task) return Response.json({ error: "This task is no longer available." }, { status: 404, headers });
      tasks = [task, ...project.tasks.filter((item) => item.id !== taskId)];
    }
    return Response.json({ project: { ...project, tasks } }, { headers });
  } catch { return Response.json({ error: "This Work result could not be opened." }, { status: 503, headers }); }
}
