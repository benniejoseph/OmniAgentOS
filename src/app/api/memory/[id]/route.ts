import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { publicMemoryDeletionReceiptV1 } from "@/lib/memory/deletion-receipt";
import { queueMemoryGraphRebuild } from "@/lib/memory/graph";
import {
  correctMemory,
  forgetMemoryWithReceipt,
  getMemory,
  MemoryDeletionPreviewConflictError,
  previewMemoryDeletion,
} from "@/lib/memory/store";
import { embedTexts } from "@/lib/openai/client";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const correctionSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().min(1).max(200_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validTo: z.string().datetime().optional(),
  contradiction: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "A correction is required." });

async function authorize(request: Request, id: string, action: "read" | "write.memory") {
  return authorizeRequest({ request, action, resourceType: "memory", resourceId: id });
}

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  const deletionPreview = new URL(request.url).searchParams.get("view") ===
    "deletion-preview";
  let context;
  try {
    context = await authorize(
      request,
      id,
      deletionPreview ? "write.memory" : "read",
    );
  } catch (error) { return forbiddenResponse(error); }
  if (deletionPreview) {
    const preview = await previewMemoryDeletion(id, {
      tenantId: context.tenantId,
    });
    return preview
      ? Response.json({ preview }, {
          headers: { "cache-control": "private, no-store" },
        })
      : Response.json({ error: "Memory not found." }, {
          status: 404,
          headers: { "cache-control": "private, no-store" },
        });
  }
  const memory = await getMemory(id, { tenantId: context.tenantId });
  return memory ? Response.json({ memory: publicMemory(memory) }) : Response.json({ error: "Memory not found." }, { status: 404 });
}

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = correctionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid correction", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorize(request, id, "write.memory"); } catch (error) { return forbiddenResponse(error); }
  const existing = await getMemory(id, { tenantId: context.tenantId });
  if (!existing) return Response.json({ error: "Memory not found." }, { status: 404 });
  const embedding = (await embedTexts([
    `${parsed.data.title || existing.title}\n\n${parsed.data.content || existing.content}`,
  ], undefined, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    sourceStreamId: `memory:${id}`,
    operation: "embedding",
    purpose: "api.memory.correct",
    credentialSource: "deployment_environment",
  }))?.[0] || existing.embedding;
  const result = await correctMemory(id, { ...parsed.data, embedding }, { tenantId: context.tenantId, actorId: context.actorId });
  if (!result) return Response.json({ error: "Memory not found." }, { status: 404 });
  await queueMemoryGraphRebuild({ tenantId: context.tenantId });
  return Response.json({ previous: publicMemory(result.previous), corrected: publicMemory(result.corrected) });
}

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorize(request, id, "write.memory"); } catch (error) { return forbiddenResponse(error); }
  const expectedManifestSha256 = request.headers
    .get("x-asael-deletion-preview")
    ?.trim();
  if (!expectedManifestSha256) {
    return Response.json({
      error: "Review the current deletion preview before forgetting this memory.",
    }, {
      status: 428,
      headers: { "cache-control": "private, no-store" },
    });
  }
  let result: Awaited<ReturnType<typeof forgetMemoryWithReceipt>>;
  try {
    result = await forgetMemoryWithReceipt(id, {
      tenantId: context.tenantId,
      expectedDescendantManifestSha256: expectedManifestSha256,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: `memory_forget_${randomUUID()}`,
        purpose: "memory.forget.api",
      }),
    });
  } catch (error) {
    if (error instanceof MemoryDeletionPreviewConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (
      error instanceof Error &&
      error.message === "Memory deletion preview digest is invalid."
    ) {
      return Response.json({ error: error.message }, {
        status: 400,
        headers: { "cache-control": "private, no-store" },
      });
    }
    throw error;
  }
  if (!result) return Response.json({ error: "Memory not found." }, { status: 404 });
  return Response.json({
    forgotten: true,
    id,
    deletionGuarantee: result.deletionGuarantee,
    deletionDisposition: result.deletionDisposition,
    deletionReceipt: result.receipt
      ? publicMemoryDeletionReceiptV1(result.receipt)
      : null,
    invalidatedAgentRunCount: result.invalidatedAgentRunCount,
    invalidatedWorkflowRunCount: result.invalidatedWorkflowRunCount,
    invalidatedDailyBriefCount: result.invalidatedDailyBriefCount,
  }, {
    headers: { "cache-control": "private, no-store" },
  });
}

function publicMemory<T extends { embedding?: number[] }>(memory: T) {
  const result = { ...memory };
  delete result.embedding;
  return result;
}
