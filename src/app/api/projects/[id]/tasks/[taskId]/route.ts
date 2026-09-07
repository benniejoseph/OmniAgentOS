import { z } from "zod";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { updateWorkItemService } from "@/lib/app-services/projects";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ProjectTransitionError } from "@/lib/projects/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
const agentIds = ["atlas", "scout", "forge", "sentinel", "mnemosyne"] as const;
const schema = z.object({ title: z.string().trim().min(1).max(240).optional(), detail: z.string().trim().max(1_000).optional(), status: z.enum(["open", "doing", "done"]).optional(), priority: z.enum(["low", "medium", "high"]).optional(), agentId: z.enum(agentIds).optional(), dueAt: z.string().datetime().nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0, { message: "A change is required." });

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid task update", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "project_task", resourceId: taskId, nativeMutationCapability: "workspaces.update" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await updateWorkItemService(
      createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: "project.task.update", causationId: taskId }),
      { projectId: id, workItemId: taskId, ...parsed.data },
    );
    const task = result.data.workItem;
    return task ? Response.json({ task }) : Response.json({ error: "Project task not found." }, { status: 404 });
  } catch (error) {
    return error instanceof ProjectTransitionError
      ? Response.json({ error: error.message }, { status: 409 })
      : Response.json({ error: error instanceof Error ? error.message : "Task update failed." }, { status: 500 });
  }
}
