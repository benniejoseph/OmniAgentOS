import { z } from "zod";
import { createWorkflowRun, getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";

export const runtime = "nodejs";

const workflowStartSchema = z.object({
  goal: z.string().min(1).max(4000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  requireApproval: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  return Response.json({
    runs: await listWorkflowRuns(limit),
    stats: await getWorkflowStats(),
  });
}

export async function POST(request: Request) {
  const parsed = workflowStartSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow start request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const detail = await createWorkflowRun(parsed.data);
  return Response.json(detail, { status: 201 });
}
