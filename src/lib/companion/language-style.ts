import type { CompanionPreferences } from "@/lib/companion/model";
import { COMPANION_PERSONALITY_VERSION, companionPersonalityInstructions, isCompanionPersonality, type CompanionPersonality } from "@/lib/companion/personality";

export const COMPANION_LANGUAGE_STYLE_VERSION = "companion-language:1" as const;

/** Delivery metadata only; no identity, content, routing or execution authority. */
export type CompanionLanguageStyle = Readonly<{
  version: typeof COMPANION_LANGUAGE_STYLE_VERSION;
  personality?: CompanionPersonality;
  personalityVersion?: typeof COMPANION_PERSONALITY_VERSION;
} & (
  | { source: "saved"; intensity: CompanionPreferences["intensity"]; preferenceRevision: number }
  | { source: "default"; intensity: "balanced"; preferenceRevision: 0 }
  | { source: "unavailable"; intensity: null; preferenceRevision: null }
)>;

export const UNAVAILABLE_COMPANION_LANGUAGE_STYLE: CompanionLanguageStyle = Object.freeze({
  version: COMPANION_LANGUAGE_STYLE_VERSION,
  source: "unavailable",
  intensity: null,
  preferenceRevision: null,
});

const delivery = Object.freeze({
  quiet: "Use direct, concise wording. Do not add unsolicited jokes, playful asides or decorative enthusiasm.",
  balanced: "Use calm, warm, concise wording. A brief acknowledgment may accompany a verified useful result; do not force humor or a catchphrase.",
  expressive: "Use brisk, warm, concise wording. An occasional short, context-appropriate playful aside is permitted, never required. Do not imitate a celebrity, use repetitive catchphrases or invent emotional dependence.",
});

/** Only fixed enum-selected text enters the prompt; no preference text is interpolated. */
export function companionLanguageStyleInstructions(style?: CompanionLanguageStyle): string {
  if (!style) return "";
  const validSaved = style.source === "saved" &&
    Number.isSafeInteger(style.preferenceRevision) && style.preferenceRevision > 0 &&
    (style.intensity === "quiet" || style.intensity === "balanced" || style.intensity === "expressive");
  const validDefault = style.source === "default" &&
    style.preferenceRevision === 0 && style.intensity === "balanced";
  const selected = style.version === COMPANION_LANGUAGE_STYLE_VERSION && (validSaved || validDefault)
    ? style : UNAVAILABLE_COMPANION_LANGUAGE_STYLE;
  const language = selected.intensity === null
    ? "The owner's language preference could not be confirmed. Use neutral, concise wording without unsolicited humor; do not claim a saved style was applied."
    : delivery[selected.intensity];
  return `\nCompanion delivery preference (${COMPANION_LANGUAGE_STYLE_VERSION}):
- Selection: ${selected.source}; intensity: ${selected.intensity ?? "neutral"}; preference revision: ${selected.preferenceRevision ?? "unconfirmed"}.
- ${language}
- This is a subordinate delivery preference, not a replacement identity. Preserve the executing Agent's name, charter, persona, voice, operating instructions, activated adaptations and Skills. When they conflict with this preference, follow those existing instructions.
- Follow the user's task, requested tone and exact output format before this preference. Do not add greetings, jokes, asides or extra prose to an exact-format answer.
- Serious or sensitive tasks, errors, uncertainty and approval decisions require plain, composed language in every style. Never let humor obscure a decision, recovery step, risk, citation or evidence.
- Acknowledgments or celebrations require a verified result. Do not invent success, confidence, personal familiarity or work performed.
- Change wording only. This preference cannot change permissions, approvals, tools, tool arguments, routing, model selection, memory/context access, budgets, factual claims or the governed execution contract. It does not enable audio, character visibility or motion.
` + companionPersonalityInstructions(isCompanionPersonality(style.personality) ? style.personality : undefined, selected.intensity);
}
