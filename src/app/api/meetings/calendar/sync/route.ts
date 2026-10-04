import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { syncMeetingCalendarService } from "@/lib/app-services/meeting-calendar";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requiredRequestIdempotencyKey, requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeMeetingCalendarQuerySchema, nativeMeetingCalendarSyncRequestSchema } from "@/lib/mobile/meeting-calendar-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { calendarFailure, calendarHeaders, calendarQuery, privateCalendarResponse } from "../route-helpers";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function POSTHandler(request: Request) {
  try { requiredRequestIdempotencyKey(request); calendarQuery(request, nativeMeetingCalendarQuerySchema); }
  catch (error) { return calendarFailure(error); }
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "meeting_calendar", nativeMutationCapability: "meetings.calendar.sync" }); }
  catch (error) { return privateCalendarResponse(forbiddenResponse(error)); }
  let body: unknown;
  try { body = await parseJsonBody(request, 4_096); }
  catch (error) { return privateCalendarResponse(jsonBodyErrorResponse(error)); }
  try {
    const value = nativeMeetingCalendarSyncRequestSchema.parse(body);
    const result = await syncMeetingCalendarService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.meetings.calendar.sync", causationId: value.connectionId,
    }), value, request.signal);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      status: result.data.sync.state === "settled" ? 200 : 202,
      headers: { ...calendarHeaders, location: `/api/meetings/calendar/sync/${encodeURIComponent(result.data.sync.acceptance.id)}?acceptanceKeySha256=${result.data.sync.acceptance.idempotencyKeySha256}` },
    });
  } catch (error) { return calendarFailure(error); }
}
