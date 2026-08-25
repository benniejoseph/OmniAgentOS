import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { generateGeminiImage } from "@/lib/google/ai";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
}).strict();

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "generate_image" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Add a valid image prompt and aspect ratio." }, { status: 400 });
  try {
    const result = await generateGeminiImage({ ...parsed.data, abortSignal: request.signal });
    await recordRuntimeEventSafely({ category: "api", action: "gemini.image", tenantId: context.tenantId, actorId: context.actorId, resourceType: "media", durationMs: result.latencyMs, message: "Gemini image generation completed.", metadata: { model: result.model, usage: result.usage, responseId: result.responseId, aspectRatio: parsed.data.aspectRatio || "1:1" } });
    return Response.json({ image: `data:${result.mimeType};base64,${result.data}`, mimeType: result.mimeType, model: result.model, latencyMs: result.latencyMs }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Image generation failed." }, { status: 502 });
  }
}
