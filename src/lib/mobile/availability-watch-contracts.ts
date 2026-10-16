import { WatchReadinessSchema } from "@/lib/availability-watches/readiness-contracts";
import { z } from "zod";
import { AVAILABILITY_WATCH_CONTRACT, AvailabilityWatchCreateInputSchema, AvailabilityWatchProjectionSchema, AvailabilityWatchCheckSchema } from "@/lib/availability-watches/contracts";

const envelope = { schemaVersion: z.literal(1), contract: z.literal(AVAILABILITY_WATCH_CONTRACT) };
const coverage = z.object({ provider: z.literal("district"), sourceKind: z.literal("public_cinema_sessions"), timezone: z.literal("Asia/Kolkata"), minimumIntervalMinutes: z.literal(1), description: z.string().min(1).max(1_000) }).strict();
export const nativeAvailabilityWatchListSchema = z.object({ ...envelope, coverage, watches: z.array(AvailabilityWatchProjectionSchema).max(100), hasMore: z.boolean() }).strict();
export const nativeAvailabilityWatchReadSchema = z.object({ ...envelope, coverage, watch: AvailabilityWatchProjectionSchema, checks: z.array(AvailabilityWatchCheckSchema).max(40), hasMore: z.boolean() }).strict();
export const nativeAvailabilityWatchMutationSchema = z.object({ ...envelope, watch: AvailabilityWatchProjectionSchema }).strict();
export const nativeAvailabilityWatchStopSchema = z.object({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const nativeAvailabilityWatchErrorSchema = z.union([
  z.object({ error: z.string().min(1), code: z.string().min(1) }).strict(),
  z.object({ error: z.enum(["Unauthorized", "Forbidden", "Invalid request"]), message: z.string().min(1) }).strict(),
]);
export const nativeAvailabilityWatchContractSchemas = Object.freeze({
  NativeAvailabilityWatchReadinessResponse: WatchReadinessSchema,
  NativeAvailabilityWatchCreateRequest: AvailabilityWatchCreateInputSchema,
  NativeAvailabilityWatchStopRequest: nativeAvailabilityWatchStopSchema,
  NativeAvailabilityWatchListResponse: nativeAvailabilityWatchListSchema,
  NativeAvailabilityWatchReadResponse: nativeAvailabilityWatchReadSchema,
  NativeAvailabilityWatchMutationResponse: nativeAvailabilityWatchMutationSchema,
  NativeAvailabilityWatchErrorResponse: nativeAvailabilityWatchErrorSchema,
});
