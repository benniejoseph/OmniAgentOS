import { z } from "zod";

export const AVAILABILITY_WATCH_CONTRACT = "asael-availability-watches:1" as const;
export const AVAILABILITY_WATCH_COVERAGE = Object.freeze({ provider: "district", sourceKind: "public_cinema_sessions", timezone: "Asia/Kolkata", minimumIntervalMinutes: 1,
  description: "Public District cinema pages with exact dates, optional movie and language, Gold or any seating, and inclusive showtime bounds. Other websites, signed-in pages and general text-change watches are not supported." });
export const AvailabilityWatchIdSchema = z.string().regex(/^watch_[a-f0-9]{48}$/);
export const AvailabilityWatchOwnerSchema = z.object({ tenantId: z.string().min(1).max(240), actorId: z.string().regex(/^actor:[a-f0-9-]{36}$/) }).strict();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const instant = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const notificationConfig = z.object({ destination: z.literal("owner_in_app"), push: z.literal(true), quietOnNoChange: z.literal(true) }).strict();

export const AvailabilityWatchSourceSchema = z.object({
  provider: z.literal("district"), cinemaId: z.string().regex(/^[1-9]\d{0,11}$/), cinemaName: boundedText(180),
  sourceUrl: z.string().url().max(500),
}).strict().superRefine((value, context) => {
  const url = new URL(value.sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "www.district.in" || url.port || url.username || url.password || url.search || url.hash ||
    !new RegExp(`^/movies/[a-z0-9-]+-CD${value.cinemaId}$`).test(url.pathname)) {
    context.addIssue({ code: "custom", message: "Use the exact public District cinema page, without query parameters, matching its cinema ID." });
  }
});
export const AvailabilityWatchTargetSchema = z.object({
  date, timezone: z.literal("Asia/Kolkata").default("Asia/Kolkata"), movieTitle: boundedText(180).nullable(),
  language: boundedText(60).nullable().optional().default(null), seatClass: z.enum(["gold", "any"]).default("gold"),
  earliestTime: clock.nullable().optional().default(null), latestTime: clock.nullable().optional().default(null),
}).strict().refine((value) => !value.earliestTime || !value.latestTime || value.earliestTime <= value.latestTime, "The showtime window must end after it starts.");
export const AvailabilityWatchCreateInputSchema = z.object({
  source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema,
  intervalMinutes: z.number().int().min(1).max(60).default(5), expiresAt: instant.optional(),
  maxChecks: z.number().int().min(1).max(50_000).optional(),
  notification: notificationConfig.default({ destination: "owner_in_app", push: true, quietOnNoChange: true }),
}).strict();
export const AvailabilityInspectInputSchema = z.object({ source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema }).strict();
export const AvailabilityWatchConfigSchema = z.object({
  source: AvailabilityWatchSourceSchema, target: AvailabilityWatchTargetSchema,
  intervalMinutes: z.number().int().min(1).max(60), expiresAt: instant,
  maxChecks: z.number().int().min(1).max(50_000),
  notification: notificationConfig,
}).strict();
export const AvailabilityMatchSchema = z.object({
  sessionId: boundedText(160), movieTitle: boundedText(180), language: boundedText(60), format: boundedText(60),
  startsAt: instant, localTime: clock, seatClass: boundedText(80), availableSeats: z.number().int().min(1).max(100_000),
  price: z.number().nonnegative().max(1_000_000).nullable(), currency: z.literal("INR"), bookingUrl: z.string().url().max(700),
}).strict();
export const AvailabilityObservationSchema = z.object({
  outcome: z.enum(["available", "not_listed", "sold_out"]), checkedAt: instant, providerObservedAt: instant,
  sourceUrl: z.string().url().max(700), sourceSha256: digest, providerCinemaName: boundedText(180),
  matchingSessions: z.number().int().min(0).max(2000), matches: z.array(AvailabilityMatchSchema).max(80),
  scope: z.literal("This District cinema page and selected date only; seats and prices may change before checkout."),
}).strict();
export const AvailabilityWatchNotificationSchema = z.object({
  state: z.enum(["pending", "held", "disabled", "recorded", "expired", "canceled"]),
  notificationId: z.string().max(240).nullable(), dispositionId: z.string().max(240).nullable(),
  pushDeliveryIds: z.array(z.string().max(240)).max(100), nextAttemptAt: instant.nullable(),
}).strict();
export const AvailabilityWatchDeliverySchema = z.object({
  queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(), providerAccepted: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(), opened: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), eligibleDevices: z.number().int().nonnegative(),
  providers: z.object({ apns: z.enum(["configured", "configuration_required"]), fcm: z.enum(["configured", "configuration_required"]) }).strict(),
}).strict();
export const AvailabilityWatchProjectionSchema = z.object({
  schemaVersion: z.literal(1), id: AvailabilityWatchIdSchema, revision: z.number().int().positive(), generation: z.number().int().positive(),
  state: z.enum(["active", "degraded", "fulfilled", "expired", "stopped", "exhausted"]), config: AvailabilityWatchConfigSchema,
  lastCheckedAt: instant.nullable(), lastSuccessfulAt: instant.nullable(), nextCheckAt: instant.nullable(),
  checksUsed: z.number().int().min(0).max(50_000), consecutiveFailures: z.number().int().min(0).max(50_000),
  lastError: z.object({ code: boundedText(100), message: boundedText(350), at: instant }).strict().nullable(),
  lastObservation: AvailabilityObservationSchema.nullable(), matches: z.array(AvailabilityMatchSchema).max(80),
  openingId: z.string().regex(/^availability-opening:[a-f0-9]{64}$/).nullable(), notification: AvailabilityWatchNotificationSchema.nullable(),
  delivery: AvailabilityWatchDeliverySchema.nullable().default(null),
  createdAt: instant, updatedAt: instant,
}).strict();
export const AvailabilityWatchCheckSchema = z.object({
  id: z.string().regex(/^availability-check:[a-f0-9]{64}$/), generation: z.number().int().positive(), scheduledFor: instant,
  state: z.enum(["queued", "running", "completed", "failed", "canceled"]), startedAt: instant.nullable(), finishedAt: instant.nullable(),
  observation: AvailabilityObservationSchema.nullable(), error: z.object({ code: boundedText(100), message: boundedText(350) }).strict().nullable(),
  toolExecutionId: z.string().max(240).nullable(),
}).strict();
export type AvailabilityWatchOwner = z.infer<typeof AvailabilityWatchOwnerSchema>;
export type AvailabilityWatchConfig = z.infer<typeof AvailabilityWatchConfigSchema>;
export type AvailabilityWatchProjection = z.infer<typeof AvailabilityWatchProjectionSchema>;
export type AvailabilityObservation = z.infer<typeof AvailabilityObservationSchema>;
export type AvailabilityMatch = z.infer<typeof AvailabilityMatchSchema>;
export type AvailabilityWatchCheck = z.infer<typeof AvailabilityWatchCheckSchema>;
export class AvailabilityWatchError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "availability_watch_invalid") { super(message); }
}
export function availabilitySourceUrl(config: Pick<AvailabilityWatchConfig, "source" | "target">) {
  const url = new URL(config.source.sourceUrl); url.searchParams.set("fromdate", config.target.date); return url.toString();
}
export function resolveAvailabilityWatchConfig(input: unknown, now: string): AvailabilityWatchConfig {
  const parsed = AvailabilityWatchCreateInputSchema.safeParse(input);
  if (!parsed.success) throw new AvailabilityWatchError(parsed.error.issues[0]?.message || "The watch request is invalid.");
  const value = parsed.data;
  const dayEnd = new Date(`${value.target.date}T23:59:59.999+05:30`).toISOString();
  const horizon = Date.parse(dayEnd) - Date.parse(now);
  const expiresAt = value.expiresAt || dayEnd;
  if (horizon <= 0 || value.target.date > new Date(Date.parse(now) + 31 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10) || expiresAt > dayEnd || expiresAt <= now) {
    throw new AvailabilityWatchError("Choose a future cinema date within 31 days, and an expiry no later than the end of that date.");
  }
  return AvailabilityWatchConfigSchema.parse({ ...value, expiresAt,
    maxChecks: value.maxChecks ?? Math.min(50_000, Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / (value.intervalMinutes * 60_000)) + 1) });
}
