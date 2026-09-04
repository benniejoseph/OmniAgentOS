import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  createMission,
  listMissions,
  listMissionSummariesForRequest,
  MissionReadConflictError,
} from "@/lib/missions/store";
import { toMissionSummaryView } from "@/lib/missions/public";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(4_000),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
}).strict();
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

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
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const requestedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
  const readableOwnerScope = url.searchParams.get("ownerScope") === "readable";
  const owner = {
    tenantId: context.tenantId,
    actorId: context.actorId,
  };
  try {
    const missions = readableOwnerScope
      ? await listMissionSummariesForRequest(limit, {
          ...owner,
          requestActorBinding:
            canonicalRequestActorBindingFromSecurityContext(context),
        })
      : (await listMissions(limit, owner)).map(toMissionSummaryView);
    return Response.json({
      missions,
      requestReadContracts: {
        missions: readableOwnerScope ? "readable_v1" : "exact_v1",
      },
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (!readableOwnerScope) throw error;
    return missionCollectionReadErrorResponse(error);
  }
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

function missionCollectionReadErrorResponse(error: unknown) {
  if (error instanceof MissionReadConflictError) {
    return Response.json(
      { error: "Mission history could not be verified." },
      { status: 409, headers: privateNoStoreHeaders },
    );
  }
  console.error(
    "Mission history read failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "Mission history is temporarily unavailable." },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
