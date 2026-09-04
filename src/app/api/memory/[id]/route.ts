import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { publicMemoryDeletionReceiptV1 } from "@/lib/memory/deletion-receipt";
import { queueMemoryGraphRebuild } from "@/lib/memory/graph";
import { correctMemory, forgetMemoryWithReceipt, getMemory } from "@/lib/memory/store";
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
  let context;
  try { context = await authorize(request, id, "read"); } catch (error) { return forbiddenResponse(error); }
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
  const result = await forgetMemoryWithReceipt(id, {
    tenantId: context.tenantId,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId: `memory_forget_${randomUUID()}`,
      purpose: "memory.forget.api",
    }),
  });
  if (!result) return Response.json({ error: "Memory not found." }, { status: 404 });
  return Response.json({
    forgotten: true,
    id,
    deletionGuarantee: result.deletionGuarantee,
    deletionDisposition: result.deletionDisposition,
    deletionReceipt: result.receipt
      ? publicMemoryDeletionReceiptV1(result.receipt)
      : null,
  }, {
    headers: { "cache-control": "private, no-store" },
  });
}

function publicMemory<T extends { embedding?: number[] }>(memory: T) {
  const result = { ...memory };
  delete result.embedding;
  return result;
}
