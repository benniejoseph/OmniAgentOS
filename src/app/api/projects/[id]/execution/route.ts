import { z } from "zod";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { controlProjectExecutionService } from "@/lib/app-services/projects";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    autonomyMode: z.enum(["manual", "supervised", "autonomous"]),
    taskBudget: z.number().int().min(1).max(50),
    maxParallelTasks: z.number().int().min(1).max(3),
    requireApproval: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("start"),
    autonomyMode: z.enum(["supervised", "autonomous"]),
    taskBudget: z.number().int().min(1).max(50),
    maxParallelTasks: z.number().int().min(1).max(3),
    requireApproval: z.boolean(),
  }).strict(),
  z.object({ action: z.enum(["pause", "resume", "sync"]) }).strict(),
  z.object({ action: z.enum(["approve", "retry"]), taskId: z.string().uuid() }).strict(),
]);

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid project execution command", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "project_execution", resourceId: id, metadata: { action: parsed.data.action } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const result = await controlProjectExecutionService(
      createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: `project.execution.${parsed.data.action}` }),
      { projectId: id, ...parsed.data, ...("taskId" in parsed.data ? { workItemId: parsed.data.taskId } : {}) } as never,
    );
    if (!result.data.snapshot) {
      return Response.json(
        { error: "workItemFound" in result.data ? "Project task workflow not found." : "Project not found." },
        { status: 404 },
      );
    }
    return Response.json(result.data.snapshot);
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Project execution command failed.",
    }, { status: 409 });
  }
}
