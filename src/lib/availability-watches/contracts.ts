import { array, enum as enumSchema, literal, number, object, string, type infer as Infer } from "zod";

export const AVAILABILITY_WATCH_CONTRACT = "asael-availability-watches:1" as const;
export const AVAILABILITY_WATCH_COVERAGE = Object.freeze({ provider: "district", sourceKind: "public_cinema_sessions", timezone: "Asia/Kolkata", minimumIntervalMinutes: 1,
  description: "Public District cinema pages with exact dates, optional movie and language, Gold or any seating, and inclusive showtime bounds. Other websites, signed-in pages and general text-change watches are not supported." });
export const AvailabilityWatchIdSchema = string().regex(/^watch_[a-f0-9]{48}$/);
export const AvailabilityWatchOwnerSchema = object({ tenantId: string().min(1).max(240), actorId: string().regex(/^actor:[a-f0-9-]{36}$/) }).strict();
const boundedText = (maximum: number) => string().trim().min(1).max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const instant = string().datetime().refine((value) => new Date(value).toISOString() === value);
const date = string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const clock = string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const digest = string().regex(/^[a-f0-9]{64}$/);
const notificationConfig = object({ destination: literal("owner_in_app"), push: literal(true), quietOnNoChange: literal(true) }).strict();

export const AvailabilityWatchSourceSchema = object({
  provider: literal("district"), cinemaId: string().regex(/^[1-9]\d{0,11}$/), cinemaName: boundedText(180),
  sourceUrl: string().url().max(500),
}).strict().superRefine((value, context) => {
  const url = new URL(value.sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "www.district.in" || url.port || url.username || url.password || url.search || url.hash ||
    !new RegExp(`^/movies/[a-z0-9-]+-CD${value.cinemaId}$`).test(url.pathname)) {
    context.addIssue({ code: "custom", message: "Use the exact public District cinema page, without query parameters, matching its cinema ID." });
  }
});
export const AvailabilityWatchTargetSchema = object({
  date, timezone: literal("Asia/Kolkata").default("Asia/Kolkata"), movieTitle: boundedText(180).nullable(),
  language: boundedText(60).nullable().optional().default(null), seatClass: enumSchema(["gold", "any"]).default("gold"),
  earliestTime: clock.nullable().optional().default(null), latestTime: clock.nullable().optional().default(null),
}).strict().refine((value) => !value.earliestTime || !value.latestTime || value.earliestTime <= value.latestTime, "The showtime window must end after it starts.");
export const AvailabilityWatchCreateInputSchema = object({
  source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema,
  intervalMinutes: number().int().min(1).max(60).default(5), expiresAt: instant.optional(),
  maxChecks: number().int().min(1).max(50_000).optional(),
  notification: notificationConfig.default({ destination: "owner_in_app", push: true, quietOnNoChange: true }),
}).strict();
export const AvailabilityInspectInputSchema = object({ source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema }).strict();
export const AvailabilityWatchConfigSchema = object({
  source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema,
  intervalMinutes: number().int().min(1).max(60), expiresAt: instant,
  maxChecks: number().int().min(1).max(50_000),
  notification: notificationConfig,
}).strict();
export const AvailabilityMatchSchema = object({
  sessionId: boundedText(160), movieTitle: boundedText(180), language: boundedText(60), format: boundedText(60),
  startsAt: instant, localTime: clock, seatClass: boundedText(80), availableSeats: number().int().min(1).max(100_000),
  price: number().nonnegative().max(1_000_000).nullable(), currency: literal("INR"), bookingUrl: string().url().max(700),
}).strict();
export const AvailabilityObservationSchema = object({
  outcome: enumSchema(["available", "not_listed", "sold_out"]), checkedAt: instant, providerObservedAt: instant,
  sourceUrl: string().url().max(700), sourceSha256: digest, providerCinemaName: boundedText(180),
  matchingSessions: number().int().min(0).max(2000), matches: array(AvailabilityMatchSchema).max(80),
  scope: literal("This District cinema page and selected date only; seats and prices may change before checkout."),
}).strict();
export const AvailabilityWatchNotificationSchema = object({
  state: enumSchema(["pending", "held", "disabled", "recorded", "expired", "canceled"]),
  notificationId: string().max(240).nullable(), dispositionId: string().max(240).nullable(),
  pushDeliveryIds: array(string().max(240)).max(100), nextAttemptAt: instant.nullable(),
}).strict();
export const AvailabilityWatchDeliverySchema = object({
  queued: number().int().nonnegative(), running: number().int().nonnegative(), providerAccepted: number().int().nonnegative(),
  received: number().int().nonnegative(), opened: number().int().nonnegative(), failed: number().int().nonnegative(), eligibleDevices: number().int().nonnegative(),
  providers: object({ apns: enumSchema(["configured", "configuration_required"]), fcm: enumSchema(["configured", "configuration_required"]) }).strict(),
}).strict();
export const AvailabilityWatchProjectionSchema = object({
  schemaVersion: literal(1), id: AvailabilityWatchIdSchema, revision: number().int().positive(), generation: number().int().positive(),
  state: enumSchema(["active", "degraded", "fulfilled", "expired", "stopped", "exhausted"]), config: AvailabilityWatchConfigSchema,
  lastCheckedAt: instant.nullable(), lastSuccessfulAt: instant.nullable(), nextCheckAt: instant.nullable(),
  checksUsed: number().int().min(0).max(50_000), consecutiveFailures: number().int().min(0).max(50_000),
  lastError: object({ code: boundedText(100), message: boundedText(350), at: instant }).strict().nullable(),
  lastObservation: AvailabilityObservationSchema.nullable(), matches: array(AvailabilityMatchSchema).max(80),
  openingId: string().regex(/^availability-opening:[a-f0-9]{64}$/).nullable(), notification: AvailabilityWatchNotificationSchema.nullable(),
  delivery: AvailabilityWatchDeliverySchema.nullable().default(null),
  createdAt: instant, updatedAt: instant,
}).strict();
export const AvailabilityWatchCheckSchema = object({
  id: string().regex(/^availability-check:[a-f0-9]{64}$/), generation: number().int().positive(), scheduledFor: instant,
  state: enumSchema(["queued", "running", "completed", "failed", "canceled"]), startedAt: instant.nullable(), finishedAt: instant.nullable(),
  observation: AvailabilityObservationSchema.nullable(), error: object({ code: boundedText(100), message: boundedText(350) }).strict().nullable(),
  toolExecutionId: string().max(240).nullable(),
}).strict();
export type AvailabilityWatchOwner = Infer<typeof AvailabilityWatchOwnerSchema>;
export type AvailabilityWatchConfig = Infer<typeof AvailabilityWatchConfigSchema>;
export type AvailabilityWatchProjection = Infer<typeof AvailabilityWatchProjectionSchema>;
export type AvailabilityObservation = Infer<typeof AvailabilityObservationSchema>;
export type AvailabilityMatch = Infer<typeof AvailabilityMatchSchema>;
export type AvailabilityWatchCheck = Infer<typeof AvailabilityWatchCheckSchema>;
export type AvailabilityWatchDelivery = Infer<typeof AvailabilityWatchDeliverySchema>;
export class AvailabilityWatchError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "availability_watch_invalid") { super(message); }
}
export function availabilitySourceUrl(config: Pick<AvailabilityWatchConfig, "source" | "target">) {
  const url = new URL(config.source.sourceUrl); url.searchParams.set("fromdate", config.target.date); return url.toString();
}
/** A start-time bound is inclusive for matching, but cannot be booked after it
 * starts. Derive this for saved watches too, without rewriting their config hash. */
export function availabilityWatchDeadline(config: Pick<AvailabilityWatchConfig, "target" | "expiresAt">): string {
  const opportunityEnd = new Date(`${config.target.date}T${config.target.latestTime ? `${config.target.latestTime}:00.000` : "23:59:59.999"}+05:30`).toISOString();
  const explicitEnd = new Date(config.expiresAt).toISOString();
  return explicitEnd < opportunityEnd ? explicitEnd : opportunityEnd;
}
export function availabilityOpeningActionable(watch: AvailabilityWatchProjection, now: string): boolean {
  const currentTime = Date.parse(now);
  return watch.state === "fulfilled" && Date.parse(availabilityWatchDeadline(watch.config)) > currentTime &&
    watch.matches.some(match => Date.parse(match.startsAt) > currentTime);
}
export function resolveAvailabilityWatchConfig(input: unknown, now: string): AvailabilityWatchConfig {
  const parsed = AvailabilityWatchCreateInputSchema.safeParse(input);
  if (!parsed.success) throw new AvailabilityWatchError(parsed.error.issues[0]?.message || "The watch request is invalid.");
  const value = parsed.data;
  const dayEnd = new Date(`${value.target.date}T23:59:59.999+05:30`).toISOString();
  const horizon = Date.parse(dayEnd) - Date.parse(now);
  const expiresAt = availabilityWatchDeadline({ target: value.target, expiresAt: value.expiresAt || dayEnd });
  if (horizon <= 0 || value.target.date > new Date(Date.parse(now) + 31 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10) || Date.parse(expiresAt) <= Date.parse(now)) {
    throw new AvailabilityWatchError("Choose a cinema date within 31 days whose requested showtime window has not ended, and an expiry in the future.");
  }
  return AvailabilityWatchConfigSchema.parse({ ...value, expiresAt,
    maxChecks: value.maxChecks ?? Math.min(50_000, Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / (value.intervalMinutes * 60_000)) + 1) });
}
