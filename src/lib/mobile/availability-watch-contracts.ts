import { WatchReadinessSchema } from "@/lib/availability-watches/readiness-contracts";
import { array, boolean, enum as enumSchema, literal, number, object, string, union } from "zod";
import { AVAILABILITY_WATCH_CONTRACT, AvailabilityWatchCreateInputSchema, AvailabilityWatchProjectionSchema, AvailabilityWatchCheckSchema } from "@/lib/availability-watches/contracts";

const envelope = { schemaVersion: literal(1), contract: literal(AVAILABILITY_WATCH_CONTRACT) };
const coverage = object({ provider: literal("district"), sourceKind: literal("public_cinema_sessions"), timezone: literal("Asia/Kolkata"), minimumIntervalMinutes: literal(1), description: string().min(1).max(1_000) }).strict();
export const nativeAvailabilityWatchListSchema = object({ ...envelope, coverage, watches: array(AvailabilityWatchProjectionSchema).max(100), hasMore: boolean() }).strict();
export const nativeAvailabilityWatchReadSchema = object({ ...envelope, coverage, watch: AvailabilityWatchProjectionSchema, checks: array(AvailabilityWatchCheckSchema).max(40), hasMore: boolean() }).strict();
export const nativeAvailabilityWatchMutationSchema = object({ ...envelope, watch: AvailabilityWatchProjectionSchema }).strict();
export const nativeAvailabilityWatchStopSchema = object({ expectedRevision: number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const nativeAvailabilityWatchErrorSchema = union([
  object({ error: string().min(1), code: string().min(1) }).strict(),
  object({ error: enumSchema(["Unauthorized", "Forbidden", "Invalid request"]), message: string().min(1) }).strict(),
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
