import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { getToolExecution } from "@/lib/tools/audit-store";
import { executeGovernedTool } from "@/lib/tools/executor";

export const runtime = "nodejs";

const executeSchema = z.object({
  toolId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.boolean().optional(),
  approved: z.boolean().optional(),
  approvalExecutionId: z.string().min(1).optional(),
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

  let context: SecurityContext;
  try {
    context = await authorizeRequest({
      request,
      action: parsed.data.dryRun === false ? "execute.tool" : "read",
      resourceType: "tool",
      resourceId: parsed.data.toolId,
      metadata: { toolId: parsed.data.toolId, input: parsed.data.input, dryRun: parsed.data.dryRun ?? true },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const approvalRecord = parsed.data.approvalExecutionId
    ? await getToolExecution(parsed.data.approvalExecutionId, { tenantId: context.tenantId })
    : undefined;

  if (parsed.data.approvalExecutionId && !approvalRecord) {
    return Response.json({ error: "Approval record not found." }, { status: 404 });
  }

  if (approvalRecord && approvalRecord.status !== "approval_required") {
    return Response.json(
      { error: "Approval record is not pending.", status: approvalRecord.status },
      { status: 409 },
    );
  }

  const result = await executeGovernedTool({
    toolId: approvalRecord?.toolId || parsed.data.toolId,
    input: approvalRecord?.input || parsed.data.input,
    dryRun: parsed.data.dryRun ?? true,
    approved: Boolean(approvalRecord && parsed.data.approved),
    context,
    existingRecord: approvalRecord,
  });
  const status =
    result.record.status === "blocked" || result.record.status === "approval_required"
      ? 202
      : result.record.status === "failed"
        ? 500
        : 200;

  return Response.json(result, { status });
}
