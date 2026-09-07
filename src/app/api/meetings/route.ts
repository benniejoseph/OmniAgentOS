import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  createMeetingService,
  listMeetingsService,
  meetingCreateServiceInputSchema,
  meetingListServiceInputSchema,
} from "@/lib/app-services/meetings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { meetingFailureResponse } from "@/lib/meetings/http";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "meeting",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = meetingListServiceInputSchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    status: url.searchParams.get("status") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 100),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  try {
    const result = await listMeetingsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return meetingFailureResponse(error, "list");
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 250_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = meetingCreateServiceInputSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "meeting",
      riskLevel: 2,
      metadata: {
        operation: "create",
        participantCount: parsed.data.participants.length,
        sourceLinkCount: parsed.data.sourceLinks.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await createMeetingService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.meeting.create",
        workspaceId: parsed.data.workspaceId,
        projectId: parsed.data.projectId || undefined,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return meetingFailureResponse(error, "create");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid meeting request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
