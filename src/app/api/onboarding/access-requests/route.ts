import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  getAccessRequestStore,
  type AccessRequestStatus,
} from "@/lib/onboarding/access-request-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const reviewSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
  note: z.string().trim().max(1_000).optional(),
}).strict();

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status");
  const status = normalizeStatus(requestedStatus);
  const actionable = requestedStatus === "actionable";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.identity",
      resourceType: "access_request",
      metadata: { status, limit },
    });
    const store = getAccessRequestStore();
    const [listedRequests, pending, provisioning] = await Promise.all([
      actionable
        ? Promise.all([
            store.list({
              tenantId: context.tenantId,
              status: "pending_review",
              limit,
            }),
            store.list({
              tenantId: context.tenantId,
              status: "provisioning_pending",
              limit,
            }),
            store.list({
              tenantId: context.tenantId,
              status: "approved",
              limit,
            }),
          ]).then((groups) =>
            groups
              .flat()
              .sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt),
              )
              .slice(0, limit),
          )
        : store.list({
            tenantId: context.tenantId,
            status,
            limit,
          }),
      store.count({
        tenantId: context.tenantId,
        status: "pending_review",
      }),
      store.count({
        tenantId: context.tenantId,
        status: "provisioning_pending",
      }),
    ]);
    return Response.json({
      requests: listedRequests,
      stats: {
        shown: listedRequests.length,
        pending,
        provisioning,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 32_768);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid access-request decision", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.identity",
      resourceType: "access_request",
      resourceId: parsed.data.id,
      metadata: {
        decision: parsed.data.decision,
        noteProvided: Boolean(parsed.data.note),
      },
    });
    const reviewed = await getAccessRequestStore().review({
      id: parsed.data.id,
      tenantId: context.tenantId,
      status: parsed.data.decision,
      reviewedBy: context.actorId,
      reviewNote: parsed.data.note,
    });
    if (!reviewed) {
      return Response.json(
        {
          error: "Access request not pending",
          message: "The request was not found or has already been reviewed.",
        },
        { status: 409 },
      );
    }
    return Response.json({ request: reviewed });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

function normalizeStatus(value: string | null): AccessRequestStatus | undefined {
  return value === "pending_review" ||
    value === "approved" ||
    value === "provisioning_pending" ||
    value === "provisioned" ||
    value === "declined"
    ? value
    : undefined;
}
