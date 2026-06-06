import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { tickQueuedWorkflows } from "@/lib/workflows/runner";

export const runtime = "nodejs";

const tickSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = tickSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow tick request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const runs = await tickQueuedWorkflows(parsed.data.limit || 5);
  return Response.json({ runs, count: runs.length });
}
