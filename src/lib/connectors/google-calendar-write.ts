import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GOOGLE_CALENDAR_WRITE_SCOPE,
  refreshOAuthAccess,
} from "@/lib/connectors/oauth-providers";
import {
  getOAuthGrantSecrets,
  saveOAuthGrant,
} from "@/lib/connectors/oauth-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const dateTimeSchema = z.string().datetime({ offset: true });

export const googleCalendarCreateSchema = z.object({
  calendarId: z.string().trim().min(1).max(240).optional().default("primary"),
  summary: z.string().trim().min(1).max(1_000),
  description: z.string().max(8_000).optional(),
  location: z.string().max(1_000).optional(),
  start: dateTimeSchema,
  end: dateTimeSchema,
  timeZone: z.string().trim().min(1).max(100).optional(),
  attendees: z.array(z.string().email().max(320)).max(50).optional(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.end) <= Date.parse(value.start)) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "Calendar event end must be after start.",
    });
  }
});

export type GoogleCalendarCreateInput = z.infer<typeof googleCalendarCreateSchema>;

export type GoogleCalendarEffectResult = Readonly<{
  calendarId: string;
  eventId: string;
  providerAcknowledgement: "provider_response" | "provider_idempotency_reconciliation";
  providerAcknowledgementId: string;
  providerAcknowledgementSha256: string;
  observedTargetStateSha256: string;
  htmlLink?: string;
}>;

export function googleCalendarEventId(executionId: string) {
  return `asael${createHash("sha256").update(executionId, "utf8").digest("hex")}`;
}

export function googleCalendarTargetState(
  inputValue: unknown,
  eventId: string,
) {
  const input = googleCalendarCreateSchema.parse(inputValue);
  return {
    targetType: "google_calendar_event",
    calendarId: input.calendarId,
    eventId,
    summary: input.summary,
    description: input.description || "",
    location: input.location || "",
    start: normalizeDateTime(input.start),
    end: normalizeDateTime(input.end),
    timeZone: input.timeZone || "",
    attendees: [...(input.attendees || [])].map((email) => email.toLowerCase()).sort(),
  };
}

export async function createGoogleCalendarEvent(inputValue: unknown, options: {
  tenantId: string;
  actorId: string;
  executionId: string;
  abortSignal?: AbortSignal;
}): Promise<GoogleCalendarEffectResult> {
  const input = googleCalendarCreateSchema.parse(inputValue);
  const eventId = googleCalendarEventId(options.executionId);
  const authorization = await googleAuthorization(options);
  const url = googleCalendarEventUrl(input.calendarId);
  url.searchParams.set("sendUpdates", "none");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: googleHeaders(authorization.accessToken, true),
      body: JSON.stringify({
        id: eventId,
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        attendees: input.attendees?.map((email) => ({ email })),
      }),
      signal: providerSignal(options.abortSignal),
    });
  } catch (error) {
    throw new Error("Google Calendar create outcome is unknown.", { cause: error });
  }
  if (response.status !== 409 && !response.ok) {
    throw new Error(`Google Calendar create returned ${response.status}.`);
  }
  const observed = await readGoogleCalendarEvent({
    ...options,
    calendarId: input.calendarId,
    eventId,
    accessToken: authorization.accessToken,
  });
  if (!observed) {
    throw new Error("Google Calendar event could not be verified after create.");
  }
  return verifiedResult(
    input,
    eventId,
    observed,
    response.status === 409
      ? "provider_idempotency_reconciliation"
      : "provider_response",
  );
}

export async function reconcileGoogleCalendarEvent(inputValue: unknown, options: {
  tenantId: string;
  actorId: string;
  executionId: string;
  abortSignal?: AbortSignal;
}): Promise<GoogleCalendarEffectResult | undefined> {
  const input = googleCalendarCreateSchema.parse(inputValue);
  const eventId = googleCalendarEventId(options.executionId);
  const authorization = await googleAuthorization(options);
  const observed = await readGoogleCalendarEvent({
    ...options,
    calendarId: input.calendarId,
    eventId,
    accessToken: authorization.accessToken,
  });
  return observed
    ? verifiedResult(input, eventId, observed, "provider_idempotency_reconciliation")
    : undefined;
}

async function googleAuthorization(input: { tenantId: string; actorId: string }) {
  const secrets = await getOAuthGrantSecrets(input.tenantId, input.actorId, "google");
  if (!secrets) throw new Error("Google is not connected for this user.");
  if (!secrets.grant.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE)) {
    throw new Error("Reconnect Google to grant calendar event write access.");
  }
  const current = typeof secrets.tokens.access_token === "string"
    ? secrets.tokens.access_token
    : "";
  if (current && (!secrets.grant.expiresAt || Date.parse(secrets.grant.expiresAt) > Date.now() + 60_000)) {
    return { accessToken: current };
  }
  const refreshToken = typeof secrets.tokens.refresh_token === "string"
    ? secrets.tokens.refresh_token
    : "";
  if (!refreshToken) throw new Error("Google access expired. Reconnect Google.");
  const refreshed = await refreshOAuthAccess("google", refreshToken);
  await saveOAuthGrant({
    tenantId: input.tenantId,
    actorId: input.actorId,
    provider: "google",
    tokens: refreshed,
    authorizationMode: "refresh",
  });
  return { accessToken: String(refreshed.access_token) };
}

async function readGoogleCalendarEvent(input: {
  calendarId: string;
  eventId: string;
  accessToken: string;
  abortSignal?: AbortSignal;
}) {
  const response = await fetch(
    googleCalendarEventUrl(input.calendarId, input.eventId),
    {
      headers: googleHeaders(input.accessToken),
      signal: providerSignal(input.abortSignal),
    },
  );
  if (response.status === 404 || response.status === 410) return undefined;
  if (!response.ok) throw new Error(`Google Calendar verification returned ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}

function verifiedResult(
  input: GoogleCalendarCreateInput,
  eventId: string,
  observed: Record<string, unknown>,
  acknowledgement: GoogleCalendarEffectResult["providerAcknowledgement"],
): GoogleCalendarEffectResult {
  const observedState = observedTargetState(input, observed);
  const expectedState = googleCalendarTargetState(input, eventId);
  const observedTargetStateSha256 = canonicalJsonSha256(observedState);
  if (observedTargetStateSha256 !== canonicalJsonSha256(expectedState)) {
    throw new Error("Google Calendar event does not match the governed effect intent.");
  }
  const acknowledgementBody = {
    provider: "google_calendar",
    acknowledgement,
    calendarId: input.calendarId,
    eventId,
    observedTargetStateSha256,
  };
  return Object.freeze({
    calendarId: input.calendarId,
    eventId,
    providerAcknowledgement: acknowledgement,
    providerAcknowledgementId: `google_calendar_ack:${eventId}`,
    providerAcknowledgementSha256: canonicalJsonSha256(acknowledgementBody),
    observedTargetStateSha256,
    ...(typeof observed.htmlLink === "string" ? { htmlLink: observed.htmlLink } : {}),
  });
}

function observedTargetState(
  input: GoogleCalendarCreateInput,
  value: Record<string, unknown>,
) {
  const start = record(value.start);
  const end = record(value.end);
  return {
    targetType: "google_calendar_event",
    calendarId: input.calendarId,
    eventId: String(value.id || ""),
    summary: String(value.summary || ""),
    description: String(value.description || ""),
    location: String(value.location || ""),
    start: normalizeDateTime(String(start.dateTime || "")),
    end: normalizeDateTime(String(end.dateTime || "")),
    timeZone: input.timeZone
      ? String(start.timeZone || end.timeZone || "")
      : "",
    attendees: array(value.attendees)
      .map((attendee) => String(record(attendee).email || "").toLowerCase())
      .filter(Boolean)
      .sort(),
  };
}

function googleCalendarEventUrl(calendarId: string, eventId?: string) {
  return new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`,
  );
}

function googleHeaders(accessToken: string, json = false) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function providerSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeDateTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
