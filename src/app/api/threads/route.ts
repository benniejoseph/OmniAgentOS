import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody, parseBoundedInteger } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { createThread, listThreads } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({ title: z.string().min(1).max(200), mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional() }).strict();

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "thread" }); }
  catch (error) { return forbiddenResponse(error); }
  const limit = parseBoundedInteger(new URL(request.url).searchParams.get("limit"), 30, { max: 100 });
  return Response.json({ threads: await listThreads(limit, { tenantId: context.tenantId, actorId: context.actorId }) });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "thread" }); }
  catch (error) { return forbiddenResponse(error); }
  const thread = await createThread({ tenantId: context.tenantId, actorId: context.actorId, title: parsed.data.title, mode: parsed.data.mode || "orchestrate" });
  return Response.json({ thread }, { status: 201 });
}
