import { z } from "zod";
import { COMPANION_DESTINATIONS, COMPANION_INTENSITIES, COMPANION_MOTION } from "./model";
export * from "./model";

// Command and the native conversation contract accept UUID thread destinations.
export const companionThreadIdSchema = z.string().uuid();
export const companionPreferencesSchema = z.object({
  intensity: z.enum(COMPANION_INTENSITIES),
  visible: z.boolean(),
  motion: z.enum(COMPANION_MOTION),
  defaultDestination: z.enum(COMPANION_DESTINATIONS),
  preferredThreadId: companionThreadIdSchema.nullable(),
}).strict();

export const companionChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    preferences: companionPreferencesSchema,
  }).strict(),
  z.object({ action: z.literal("reset"), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict(),
]);
