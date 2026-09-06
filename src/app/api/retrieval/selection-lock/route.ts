import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { lockContextSelection } from "@/lib/rag/context-selection-lock";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const evidenceIdSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?:memory|knowledge|graph):[^\s]+$/);

const requestSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(evidenceIdSchema)
    .max(24)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Context evidence IDs must be unique.",
    }),
  previewToken: z.string().min(80).max(24_000),
}).strict();

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid context lock request", details: parsed.error.flatten() },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "context_selection_lock",
      metadata: {
        queryLength: parsed.data.query.length,
        selectedCount: parsed.data.evidenceIds.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const locked = lockContextSelection({
      tenantId: context.tenantId,
      actorId: context.actorId,
      query: parsed.data.query,
      evidenceIds: parsed.data.evidenceIds,
      previewToken: parsed.data.previewToken,
    });
    return Response.json({
      selection: {
        query: locked.binding.query,
        evidenceIds: locked.binding.evidenceIds,
        lockToken: locked.token,
      },
      receipt: locked.binding,
    }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return Response.json({
      error: "Context selection could not be locked.",
      message: error instanceof Error
        ? error.message
        : "Refresh and review context again.",
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
}
