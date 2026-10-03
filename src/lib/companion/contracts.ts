import { z } from "zod";

export const COMPANION_PREFERENCES_CONTRACT = "asael-companion-preferences:1" as const;
export const COMPANION_INTENSITIES = ["quiet", "balanced", "expressive"] as const;
export const COMPANION_MOTION = ["full", "reduced", "off"] as const;
export const COMPANION_DESTINATIONS = ["assistant", "today", "activity", "work"] as const;

// Command and the native conversation contract accept UUID thread destinations.
export const companionThreadIdSchema = z.string().uuid();
export const companionPreferencesSchema = z.object({
  intensity: z.enum(COMPANION_INTENSITIES),
  visible: z.boolean(),
  motion: z.enum(COMPANION_MOTION),
  defaultDestination: z.enum(COMPANION_DESTINATIONS),
  preferredThreadId: companionThreadIdSchema.nullable(),
}).strict();
export type CompanionPreferences = z.infer<typeof companionPreferencesSchema>;

export const DEFAULT_COMPANION_PREFERENCES: Readonly<CompanionPreferences> = Object.freeze({
  intensity: "balanced", visible: true, motion: "full", defaultDestination: "assistant", preferredThreadId: null,
});

export const companionChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    preferences: companionPreferencesSchema,
  }).strict(),
  z.object({ action: z.literal("reset"), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict(),
]);
export type CompanionChange = z.infer<typeof companionChangeSchema>;

export type CompanionSnapshot = {
  revision: number;
  persisted: boolean;
  updatedAt: string | null;
  preferences: CompanionPreferences;
};
export type CompanionHome = {
  state: "not_set" | "available" | "unavailable" | "unconfirmed";
  preferredThreadId: string | null;
  href: string | null;
  /** The Assistant offers existing history/new-conversation controls; this read creates nothing. */
  fallbackHref: "/app/command";
};
export type CompanionPreferencesResponse = {
  schemaVersion: 1;
  contract: typeof COMPANION_PREFERENCES_CONTRACT;
  snapshot: CompanionSnapshot;
  home: CompanionHome;
  destination: { href: string; state: "configured" | "fallback" };
  mutation?: {
    outcome: "saved" | "replayed";
    receiptId: string;
    revision: number;
    savedAt: string;
    /** The accepted values may precede snapshot when replaying an older confirmed change. */
    preferences: CompanionPreferences;
  };
};

/** OS reduction is a floor; presentation preferences grant no execution authority. */
export function effectiveCompanionMotion(preference: CompanionPreferences["motion"], osReducedMotion: boolean) {
  return preference === "off" ? "off" : osReducedMotion || preference === "reduced" ? "reduced" : "full";
}
