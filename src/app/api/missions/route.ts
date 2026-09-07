import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  createMissionService,
  listMissionsService,
  missionCreateServiceInputSchema,
} from "@/lib/app-services/missions";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  MissionReadConflictError,
} from "@/lib/missions/store";
import { missionMutationFromRequest } from "@/lib/missions/request-mutation";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

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
  try {
    const result = await listMissionsService(
      createAppServiceCaller({ context }),
      {
        limit: Math.min(Math.max(limit, 1), 100),
        ownerScope: readableOwnerScope ? "readable" : "exact",
      },
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
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
  const parsed = missionCreateServiceInputSchema.safeParse(body);
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
  const mutation = missionMutationFromRequest(request, context, {
      purpose: "mission.create",
    });
  const result = await createMissionService(
    createAppServiceCaller({
      context,
      executionScope: mutation.executionScope,
      idempotencyKey: mutation.idempotencyKey,
    }),
    parsed.data,
  );
  return Response.json({
    ...result.data,
    serviceReceipt: result.receipt,
  }, { status: 201 });
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
