import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showMeetingCalendarService } from "@/lib/app-services/meeting-calendar";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeMeetingCalendarQuerySchema } from "@/lib/mobile/meeting-calendar-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { calendarFailure, calendarHeaders, calendarQuery, privateCalendarResponse } from "./route-helpers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "meeting_calendar" }); }
  catch (error) { return privateCalendarResponse(forbiddenResponse(error)); }
  try {
    const query = calendarQuery(request, nativeMeetingCalendarQuerySchema);
    const result = await showMeetingCalendarService(createAppServiceCaller({ context }), query);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: calendarHeaders });
  } catch (error) { return calendarFailure(error); }
});
