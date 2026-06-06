import { tickWorkflowRun } from "@/lib/workflows/runner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      resourceId: id,
    });
    return Response.json(await tickWorkflowRun(id));
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to not-found style workflow error
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow tick failed." },
      { status: 404 },
    );
  }
}
