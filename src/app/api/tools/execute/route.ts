import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { publicToolExecution } from "@/lib/tools/audit-store";
import {
  executeGovernedTool,
  ToolInputValidationError,
} from "@/lib/tools/executor";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const executeSchema = z.object({
  toolId: z.string().min(1).max(240),
  input: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.boolean().optional(),
}).strict();

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
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
      metadata: {
        toolId: parsed.data.toolId,
        inputKeys: Object.keys(parsed.data.input).slice(0, 50),
        inputBytes: Buffer.byteLength(JSON.stringify(parsed.data.input)),
        dryRun: parsed.data.dryRun ?? true,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let result: Awaited<ReturnType<typeof executeGovernedTool>>;
  try {
    result = await executeGovernedTool({
      toolId: parsed.data.toolId,
      input: parsed.data.input,
      dryRun: parsed.data.dryRun ?? true,
      context,
    });
  } catch (error) {
    if (error instanceof ToolInputValidationError) {
      return Response.json(
        { error: "Invalid tool input", message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
  const status =
    result.record.status === "blocked" || result.record.status === "approval_required"
      ? 202
      : result.record.status === "failed"
        ? 500
        : 200;

  return Response.json(
    { ...result, record: publicToolExecution(result.record) },
    { status },
  );
}
