import { withDatabaseRequestScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { getMission } from "@/lib/missions/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const DEFAULT_EVENT_LIMIT = 25;
const MAX_EVENT_LIMIT = 100;

async function GETHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mission",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const afterSeq = parseNonNegativeInteger(url.searchParams.get("afterSeq"), 0);
  const limit = parseNonNegativeInteger(
    url.searchParams.get("limit"),
    DEFAULT_EVENT_LIMIT,
  );
  if (afterSeq === undefined || limit === undefined || limit < 1) {
    return Response.json({ error: "Invalid mission event cursor." }, { status: 400 });
  }

  const owner = { tenantId: context.tenantId, actorId: context.actorId };
  const mission = await getMission(id, owner);
  if (!mission) {
    return Response.json({ error: "Mission not found." }, { status: 404 });
  }

  const events = await listStreamEvents(`mission:${mission.id}`, {
    ...owner,
    afterSeq,
    limit: Math.min(limit, MAX_EVENT_LIMIT),
    order: "desc",
  });
  const cursor = events.reduce(
    (latest, event) => Math.max(latest, event.seq),
    afterSeq,
  );

  return Response.json({
    cursor,
    changed: events.length > 0,
    mission: {
      status: mission.status,
      updatedAt: mission.updatedAt,
    },
    events: [...events].reverse().map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.at,
    })),
  }, {
    headers: { "cache-control": "private, no-store" },
  });
}

function parseNonNegativeInteger(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
