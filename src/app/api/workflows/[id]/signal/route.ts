import { z } from "zod";
import { signalWorkflowRun } from "@/lib/workflows/runner";

export const runtime = "nodejs";

const signalSchema = z.object({
  signal: z.enum(["pause", "resume", "cancel", "approve", "retry"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = signalSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow signal request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    return Response.json(await signalWorkflowRun(id, parsed.data.signal));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow signal failed." },
      { status: 404 },
    );
  }
}
