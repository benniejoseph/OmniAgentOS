import { z } from "zod";
import { MeetingCalendarError } from "@/lib/connectors/meeting-calendar-sync-store";
import { IdempotencyKeyError } from "@/lib/http/idempotency-key";

export const calendarHeaders = { "cache-control": "private, no-store" };
export function privateCalendarResponse(response: Response) { response.headers.set("cache-control", calendarHeaders["cache-control"]); return response; }
export function calendarQuery<T>(request: Request, schema: z.ZodType<T>): T {
  const entries = [...new URL(request.url).searchParams];
  if (entries.length !== new Set(entries.map(([key]) => key)).size) throw new MeetingCalendarError("calendar_query_invalid", 400, "Repeated Calendar query parameters are invalid.");
  return schema.parse(Object.fromEntries(entries));
}
export function calendarFailure(error: unknown) {
  if (error instanceof MeetingCalendarError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: calendarHeaders });
  if (error instanceof z.ZodError || error instanceof IdempotencyKeyError) return Response.json({ error: "Invalid Calendar request.", code: "calendar_request_invalid" }, { status: 400, headers: calendarHeaders });
  return Response.json({ error: "Calendar status could not be confirmed. Read the exact sync receipt before starting another sync.", code: "calendar_unavailable" }, { status: 503, headers: calendarHeaders });
}
