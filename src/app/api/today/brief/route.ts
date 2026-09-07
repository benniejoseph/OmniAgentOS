import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { generateTodayBriefService, showTodayBriefService, updateTodayPreferencesService } from "@/lib/app-services/today";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const generateSchema = z.object({ force: z.boolean().optional() }).strict();
const preferencesSchema = z.object({
  briefEnabled: z.boolean().optional(),
  briefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  reminderLeadMinutes: z.union([
    z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(120),
  ]).optional(),
  notificationsEnabled: z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "daily_brief" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await showTodayBriefService(createAppServiceCaller({ context }), {});
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  const parsed = await parseBody(request, generateSchema);
  if (parsed instanceof Response) return parsed;
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "daily_brief" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await generateTodayBriefService(
    createRequestMutationAppServiceCaller(request, context, { purpose: "today.brief.generate" }),
    parsed,
  );
  return Response.json({ ...result.data, serviceReceipt: result.receipt });
}

async function PATCHHandler(request: Request) {
  const parsed = await parseBody(request, preferencesSchema);
  if (parsed instanceof Response) return parsed;
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "daily_brief_preferences" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await updateTodayPreferencesService(
    createRequestMutationAppServiceCaller(request, context, { purpose: "today.preferences.update" }),
    parsed,
  );
  return Response.json({ ...result.data, serviceReceipt: result.receipt });
}

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid daily brief request", details: parsed.error.flatten() }, { status: 400 });
  }
  return parsed.data;
}
