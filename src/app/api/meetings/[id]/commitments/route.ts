import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  listMeetingCommitmentsService,
  meetingCommitmentListServiceInputSchema,
  meetingCommitmentProposeServiceInputSchema,
  meetingCommitmentResolveServiceInputSchema,
  proposeMeetingCommitmentService,
  resolveMeetingCommitmentService,
} from "@/lib/app-services/meetings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { meetingFailureResponse } from "@/lib/meetings/http";
import { MeetingNotFoundError } from "@/lib/meetings/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const meetingId = decodeURIComponent((await routeContext.params).id);
  const url = new URL(request.url);
  const parsed = meetingCommitmentListServiceInputSchema.safeParse({
    meetingId,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "meeting_commitment",
      resourceId: meetingId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await listMeetingCommitmentsService(
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
    return failureResponse(error, "list commitments");
  }
}

async function POSTHandler(request: Request, routeContext: RouteContext) {
  const meetingId = decodeURIComponent((await routeContext.params).id);
  let body: unknown;
  try {
    body = await parseJsonBody(request, 50_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = meetingCommitmentProposeServiceInputSchema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    meetingId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "meeting_commitment",
      resourceId: meetingId,
      riskLevel: 1,
      metadata: {
        operation: "propose",
        mediaRevisionId: parsed.data.mediaRevisionId,
        actionItemId: parsed.data.actionItemId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await proposeMeetingCommitmentService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.meeting.commitment.propose",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return failureResponse(error, "propose commitment");
  }
}

async function PATCHHandler(request: Request, routeContext: RouteContext) {
  const meetingId = decodeURIComponent((await routeContext.params).id);
  let body: unknown;
  try {
    body = await parseJsonBody(request, 100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = meetingCommitmentResolveServiceInputSchema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    meetingId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "meeting_commitment",
      resourceId: parsed.data.proposalId,
      riskLevel: 2,
      metadata: {
        operation: "resolve",
        meetingId,
        decision: parsed.data.decision,
        createsCommunicationDraft:
          parsed.data.decision === "confirmed" && Boolean(parsed.data.communication),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await resolveMeetingCommitmentService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.meeting.commitment.resolve",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return failureResponse(error, "resolve commitment");
  }
}

function failureResponse(error: unknown, operation: string) {
  if (error instanceof MeetingNotFoundError) {
    return Response.json(
      { error: error.message },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  return meetingFailureResponse(error, operation);
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid meeting commitment request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}
