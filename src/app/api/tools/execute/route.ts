import { z } from "zod";
import { executeGovernedTool } from "@/lib/tools/executor";

export const runtime = "nodejs";

const executeSchema = z.object({
  toolId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.boolean().optional(),
  approved: z.boolean().optional(),
});

export async function POST(request: Request) {
  const parsed = executeSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid tool execution request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await executeGovernedTool({
    toolId: parsed.data.toolId,
    input: parsed.data.input,
    dryRun: parsed.data.dryRun ?? true,
    approved: parsed.data.approved ?? false,
  });
  const status =
    result.record.status === "blocked" || result.record.status === "approval_required"
      ? 202
      : result.record.status === "failed"
        ? 500
        : 200;

  return Response.json(result, { status });
}
