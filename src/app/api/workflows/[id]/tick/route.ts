import { tickWorkflowRun } from "@/lib/workflows/runner";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    return Response.json(await tickWorkflowRun(id));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow tick failed." },
      { status: 404 },
    );
  }
}
