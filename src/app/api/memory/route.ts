import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { indexMemoryGraphRecords } from "@/lib/memory/graph";
import { listMemories, saveMemory, searchMemories } from "@/lib/memory/store";
import { embedTexts } from "@/lib/openai/client";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const memorySchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(200_000),
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });

  if (query) {
    const safeQuery = String(redactSensitive(query));
    const queryEmbedding = (await embedTexts([safeQuery]))?.[0];
    return Response.json({
      results: (
        await searchMemories(safeQuery, {
          limit: Math.min(Math.max(limit, 1), 100),
          queryEmbedding,
          tenantId: context.tenantId,
        })
      ).map((result) => ({
        ...result,
        record: publicMemoryRecord(result.record),
      })),
    });
  }

  return Response.json({
    memories: (
      await listMemories({
        tenantId: context.tenantId,
        includeInactive: true,
        limit: Math.min(Math.max(limit, 1), 100),
      })
    ).map(publicMemoryRecord),
  });
}

function publicMemoryRecord<T extends { embedding?: number[] }>(record: T) {
  const publicRecord = { ...record };
  delete publicRecord.embedding;
  return publicRecord;
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = memorySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      metadata: {
        titleLength: parsed.data.title.length,
        type: parsed.data.type,
        tagCount: parsed.data.tags?.length || 0,
        importance: parsed.data.importance,
        contentLength: parsed.data.content.length,
      },
    });
    const safeMemory = redactSensitive(parsed.data) as typeof parsed.data;
    const embedding = (await embedTexts([
      `${safeMemory.title}\n\n${safeMemory.content}`,
    ]))?.[0];
    const record = await saveMemory({
      ...safeMemory,
      tenantId: context.tenantId,
      source: "manual",
      scope: "workspace",
      assertedBy: "user",
      embedding,
    });
    await indexMemoryGraphRecords([record], "memory.manual");

    return Response.json({ record }, { status: 201 });
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to ordinary error handling
    }
    return Response.json(
      {
        error: "Memory write failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
