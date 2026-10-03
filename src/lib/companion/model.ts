/** Browser-safe Companion values. Keep runtime schemas in contracts.ts on the server. */
export const COMPANION_PREFERENCES_CONTRACT = "asael-companion-preferences:1" as const;
export const COMPANION_INTENSITIES = ["quiet", "balanced", "expressive"] as const;
export const COMPANION_MOTION = ["full", "reduced", "off"] as const;
export const COMPANION_DESTINATIONS = ["assistant", "today", "activity", "work"] as const;

export type CompanionPreferences = {
  intensity: typeof COMPANION_INTENSITIES[number];
  visible: boolean;
  motion: typeof COMPANION_MOTION[number];
  defaultDestination: typeof COMPANION_DESTINATIONS[number];
  preferredThreadId: string | null;
};

export const DEFAULT_COMPANION_PREFERENCES: Readonly<CompanionPreferences> = Object.freeze({
  intensity: "balanced", visible: true, motion: "full", defaultDestination: "assistant", preferredThreadId: null,
});

export type CompanionChange =
  | { action: "save"; expectedRevision: number; preferences: CompanionPreferences }
  | { action: "reset"; expectedRevision: number };
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
