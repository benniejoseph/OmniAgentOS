import { createHash } from "node:crypto";
import { parseDocument } from "htmlparser2";
import { z } from "zod";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { AvailabilityObservationSchema, AvailabilityInspectInputSchema, availabilitySourceUrl, type AvailabilityMatch, type AvailabilityObservation } from "./contracts";

export { AvailabilityInspectInputSchema } from "./contracts";
const LIMIT_BYTES = 2 * 1024 * 1024;
const SCOPE = "This District cinema page and selected date only; seats and prices may change before checkout." as const;
const failureMessages = {
  source_restricted: "District refused this public read. Monitoring has no current availability evidence.",
  source_rate_limited: "District limited requests. Asael will wait before checking again.",
  source_http_error: "The booking source did not return a successful response.",
  source_timeout: "The booking source did not respond within the check deadline.",
  source_shape_changed: "The public booking data could not be matched to its expected cinema and date.",
  source_stale: "The booking source returned stale or unverifiable data.",
  source_too_large: "The booking source exceeded the bounded response limit.",
} as const;
export type AvailabilitySourceFailureCode = keyof typeof failureMessages;
export class AvailabilitySourceError extends Error {
  constructor(public readonly code: AvailabilitySourceFailureCode) { super(failureMessages[code]); }
}
export function availabilitySourceFailure(error: unknown) {
  if (error instanceof AvailabilitySourceError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const [code, known] of Object.entries(failureMessages)) {
    if (message.includes(known)) return { code, message: known };
  }
  return { code: "source_unavailable", message: "The booking source could not be checked. Previous availability has not been changed." };
}

/** One inert public GET. No account, Javascript, private API or seat reservation. */
export async function inspectDistrictAvailability(input: unknown, abortSignal?: AbortSignal): Promise<AvailabilityObservation> {
  const config = AvailabilityInspectInputSchema.parse(input);
  const sourceUrl = availabilitySourceUrl(config);
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(abortSignal ? [abortSignal] : [])]);
  let url = sourceUrl;
  try {
    for (let redirects = 0; redirects <= 2; redirects++) {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.district.in" || parsedUrl.port || parsedUrl.username || parsedUrl.password ||
        !parsedUrl.pathname.endsWith(`-CD${config.source.cinemaId}`) || parsedUrl.searchParams.get("fromdate") !== config.target.date) throw new AvailabilitySourceError("source_shape_changed");
      const response = await fetchPublicHttpUrl(url, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
        headers: { accept: "text/html", "cache-control": "no-cache", "user-agent": "Asael-Availability/1.0" }, signal }, "Availability source");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 2) throw new AvailabilitySourceError("source_shape_changed");
        url = new URL(location, url).toString(); continue;
      }
      if (!response.ok) {
        void response.body?.cancel();
        throw new AvailabilitySourceError(response.status === 429 ? "source_rate_limited" : [401, 403].includes(response.status) ? "source_restricted" : "source_http_error");
      }
      if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html") || !response.body) throw new AvailabilitySourceError("source_shape_changed");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > LIMIT_BYTES) throw new AvailabilitySourceError("source_too_large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = Buffer.concat(chunks); const checkedAt = new Date().toISOString();
      return parseDistrictAvailability(body.toString("utf8"), config, { checkedAt, sourceUrl: url, sourceSha256: createHash("sha256").update(body).digest("hex") });
    }
    throw new AvailabilitySourceError("source_shape_changed");
  } catch (error) {
    if (signal.aborted) throw new AvailabilitySourceError("source_timeout");
    throw error;
  }
}

/** The source's exact date key is mandatory. Empty date data is distinct from a missing response. */
export function parseDistrictAvailability(html: string, config: z.infer<typeof AvailabilityInspectInputSchema>, receipt: { checkedAt: string; sourceUrl: string; sourceSha256: string }): AvailabilityObservation {
  const document = parseDocument(html); const scripts: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 100 || !node || typeof node !== "object") return;
    const value = node as { name?: string; attribs?: Record<string, string>; children?: unknown[]; data?: string };
    if (value.name === "script" && value.attribs?.id === "__NEXT_DATA__") scripts.push((value.children || []).map((child) => typeof child === "object" && child && "data" in child ? String(child.data) : "").join(""));
    for (const child of value.children || []) visit(child, depth + 1);
  };
  visit(document, 0);
  if (scripts.length !== 1) throw new AvailabilitySourceError("source_shape_changed");
  let root: Record<string, unknown>;
  try { root = object(JSON.parse(scripts[0])); } catch { throw new AvailabilitySourceError("source_shape_changed"); }
  const query = object(root.query); const page = object(object(root.props).pageProps); const data = object(page.data);
  if (query.fromdate !== config.target.date || data.cinemaId !== config.source.cinemaId || data.isCSR !== false) throw new AvailabilitySourceError("source_shape_changed");
  const state = object(object(data.serverState)[`${config.source.cinemaId}${config.target.date}`]);
  const cinema = object(object(state.meta).cinema);
  if (String(cinema.id) !== config.source.cinemaId || typeof cinema.name !== "string" || !cinema.name.trim() || cinema.name.length > 180) throw new AvailabilitySourceError("source_shape_changed");
  const observedMs = typeof state.serverTime === "number" ? state.serverTime * 1000 : NaN;
  const age = Date.parse(receipt.checkedAt) - observedMs;
  if (!Number.isFinite(observedMs) || age < -120_000 || age > 10 * 60_000) throw new AvailabilitySourceError("source_stale");
  if (!Array.isArray(state.arrangedSessions) || state.arrangedSessions.length > 200) throw new AvailabilitySourceError("source_shape_changed");
  if (!state.arrangedSessions.length && cinema.sessionCount !== 0) throw new AvailabilitySourceError("source_shape_changed");
  const matches: AvailabilityMatch[] = []; const seen = new Set<string>(); let matchingSessions = 0; let totalSessions = 0;
  for (const rawGroup of state.arrangedSessions) {
    const group = object(rawGroup); const movie = object(group.data);
    if (typeof movie.label !== "string" || !Array.isArray(group.sessions) || group.sessions.length > 500 || String(group.cinemaId) !== config.source.cinemaId) throw new AvailabilitySourceError("source_shape_changed");
    for (const rawSession of group.sessions) {
      if (++totalSessions > 2000) throw new AvailabilitySourceError("source_shape_changed");
      const session = object(rawSession);
      if (String(session.cid) !== config.source.cinemaId || typeof session.showTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(session.showTime) ||
        typeof session.lang !== "string" || typeof session.scrnFmt !== "string" || !Array.isArray(session.areas) || session.areas.length > 30 || typeof session.disableClick !== "boolean") throw new AvailabilitySourceError("source_shape_changed");
      // District omits the zone in this field but renders it as UTC converted
      // to India time. Validate before conversion so Date cannot normalize an
      // invalid source date or 24:00 into a different bookable session.
      const utc = session.showTime.length === 16 ? `${session.showTime}:00` : session.showTime;
      const epoch = Date.parse(`${utc}Z`);
      if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 19) !== utc) throw new AvailabilitySourceError("source_shape_changed");
      const startsAt = new Date(epoch).toISOString();
      const india = new Date(epoch + 330 * 60_000).toISOString();
      const localTime = india.slice(11, 16);
      if (india.slice(0, 10) !== config.target.date) continue;
      if ((config.target.movieTitle !== null && normalized(movie.label) !== normalized(config.target.movieTitle)) ||
        (config.target.language !== null && normalized(session.lang) !== normalized(config.target.language)) ||
        (config.target.earliestTime !== null && localTime < config.target.earliestTime) || (config.target.latestTime !== null && localTime > config.target.latestTime) || startsAt <= receipt.checkedAt) continue;
      const areas = session.areas.map(object).filter((area) => typeof area.label === "string" && (config.target.seatClass === "any" || /^GOLD(?: PRIME)?$/i.test(area.label)));
      if (!areas.length) continue;
      matchingSessions++;
      for (const area of areas) {
        if (typeof area.sAvail !== "number" || !Number.isInteger(area.sAvail) || area.sAvail < 0 || typeof area.disableClick !== "boolean") throw new AvailabilitySourceError("source_shape_changed");
        if (session.disableClick || area.disableClick || area.sAvail === 0) continue;
        const id = String(session.sid || ""); if (!id || id.length > 160) throw new AvailabilitySourceError("source_shape_changed");
        const key = `${id}:${String(area.code)}:${String(area.label)}`; if (seen.has(key)) continue; seen.add(key);
        if (matches.length >= 80) throw new AvailabilitySourceError("source_shape_changed");
        matches.push({ sessionId: id, movieTitle: movie.label, language: session.lang, format: session.scrnFmt, startsAt, localTime,
          seatClass: String(area.label), availableSeats: area.sAvail, price: typeof area.price === "number" && Number.isFinite(area.price) && area.price >= 0 ? area.price : null,
          currency: "INR", bookingUrl: receipt.sourceUrl });
      }
    }
  }
  return AvailabilityObservationSchema.parse({ ...receipt, providerObservedAt: new Date(observedMs).toISOString(), providerCinemaName: cinema.name,
    outcome: matches.length ? "available" : matchingSessions ? "sold_out" : "not_listed", matchingSessions,
    matches: matches.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sessionId.localeCompare(b.sessionId) || a.seatClass.localeCompare(b.seatClass)), scope: SCOPE });
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function normalized(value: string) { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"); }
