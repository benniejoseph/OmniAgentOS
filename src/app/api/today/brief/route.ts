import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  generateDailyBrief,
  getTodayBriefBundle,
  updateTodayPreferences,
} from "@/lib/today/briefs";
import { invalidateTodaySnapshot } from "@/lib/today/snapshot-cache";

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
  const bundle = await getTodayBriefBundle({
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  return Response.json(bundle, { headers: { "cache-control": "private, no-store" } });
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
  const brief = await generateDailyBrief({
    tenantId: context.tenantId,
    actorId: context.actorId,
    force: parsed.force,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  invalidateTodaySnapshot(context);
  return Response.json({ brief });
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
  const preferences = await updateTodayPreferences(parsed, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  invalidateTodaySnapshot(context);
  return Response.json({ preferences });
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
