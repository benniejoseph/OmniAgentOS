import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectMeetingCalendarSyncService } from "@/lib/app-services/meeting-calendar";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeMeetingCalendarSyncIdSchema, nativeMeetingCalendarSyncReadQuerySchema } from "@/lib/mobile/meeting-calendar-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { calendarFailure, calendarHeaders, calendarQuery, privateCalendarResponse } from "../../route-helpers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string }> }) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "meeting_calendar" }); }
  catch (error) { return privateCalendarResponse(forbiddenResponse(error)); }
  try {
    const { id } = await route.params;
    nativeMeetingCalendarSyncIdSchema.parse(id);
    const query = calendarQuery(request, nativeMeetingCalendarSyncReadQuerySchema);
    const result = await inspectMeetingCalendarSyncService(createAppServiceCaller({ context }), id, query);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: calendarHeaders });
  } catch (error) { return calendarFailure(error); }
});
