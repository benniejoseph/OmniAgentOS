import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executeGovernedTool } from "@/lib/tools/executor";

export const runtime = "nodejs";

const executeSchema = z.object({
  toolId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.boolean().optional(),
  approved: z.boolean().optional(),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = executeSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid tool execution request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.dryRun === false) {
    try {
      await authorizeRequest({
        request,
        action: "execute.tool",
        resourceType: "tool",
        resourceId: parsed.data.toolId,
        metadata: { toolId: parsed.data.toolId, input: parsed.data.input },
      });
    } catch (error) {
      return forbiddenResponse(error);
    }
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
