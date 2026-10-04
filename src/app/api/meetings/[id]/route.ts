import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  meetingShowServiceInputSchema,
  meetingUpdateServiceInputSchema,
  showMeetingService,
  updateMeetingService,
} from "@/lib/app-services/meetings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { meetingFailureResponse } from "@/lib/meetings/http";
import { decodeMeetingRouteId, isPathScopedMeetingBody, privateMeetingResponse } from "@/lib/meetings/route-input";
import { MeetingNotFoundError } from "@/lib/meetings/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const meetingId = decodeMeetingRouteId((await routeContext.params).id);
  if (!meetingId) return invalidRequest({ formErrors: ["Invalid meeting path identity."], fieldErrors: {} });
  const url = new URL(request.url);
  const parsed = meetingShowServiceInputSchema.safeParse({
    meetingId,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "meeting",
      resourceId: meetingId,
    });
  } catch (error) {
    return privateMeetingResponse(forbiddenResponse(error));
  }
  try {
    const result = await showMeetingService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    if (!result.data.meeting) {
      return Response.json(
        { error: "Meeting not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return meetingFailureResponse(error, "show");
  }
}

async function PATCHHandler(request: Request, routeContext: RouteContext) {
  const meetingId = decodeMeetingRouteId((await routeContext.params).id);
  if (!meetingId) return invalidRequest({ formErrors: ["Invalid meeting path identity."], fieldErrors: {} });
  let body: unknown;
  try {
    body = await parseJsonBody(request, 250_000);
  } catch (error) {
    return privateMeetingResponse(jsonBodyErrorResponse(error));
  }
  if (!isPathScopedMeetingBody(body)) return invalidRequest({ formErrors: ["The body must be an object without meetingId."], fieldErrors: {} });
  const parsed = meetingUpdateServiceInputSchema.safeParse({
    ...body,
    meetingId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "meeting",
      nativeMutationCapability: "meetings.records.manage",
      resourceId: meetingId,
      riskLevel: 2,
      metadata: {
        operation: "revise",
        expectedRevision: parsed.data.expectedRevision,
        participantCount: parsed.data.participants.length,
        sourceLinkCount: parsed.data.sourceLinks.length,
      },
    });
  } catch (error) {
    return privateMeetingResponse(forbiddenResponse(error));
  }
  try {
    const result = await updateMeetingService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.meeting.update",
        workspaceId: parsed.data.workspaceId,
        projectId: parsed.data.projectId || undefined,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof MeetingNotFoundError) {
      return Response.json(
        { error: error.message },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    return meetingFailureResponse(error, "update");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid meeting request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}
