import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createMission, listMissions } from "@/lib/missions/store";
import { toMissionSummaryView } from "@/lib/missions/public";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(4_000),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "missions",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const requestedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
  const missions = await listMissions(limit, {
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  return Response.json({ missions: missions.map(toMissionSummaryView) }, {
    headers: { "cache-control": "private, no-store" },
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid mission",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "mission",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const mission = await createMission({
    ...parsed.data,
    tenantId: context.tenantId,
    actorId: context.actorId,
    source: "user",
  });
  return Response.json({ mission: toMissionSummaryView(mission) }, { status: 201 });
}
