export const TODAY_SECTION_KEYS = Object.freeze([
  "focus",
  "agenda",
  "approvals",
  "active_agents",
  "work",
  "memory",
  "conversations",
  "consumption",
] as const);

export type TodaySectionKey = (typeof TODAY_SECTION_KEYS)[number];
// Defaults apply only when a person has not saved their own section choices.
export const DEFAULT_TODAY_SECTIONS: readonly TodaySectionKey[] = Object.freeze([
  "focus", "agenda", "approvals", "work",
]);

export function normalizeTodaySections(value: unknown): readonly TodaySectionKey[] {
  if (!Array.isArray(value)) return DEFAULT_TODAY_SECTIONS;
  const allowed = new Set<TodaySectionKey>(TODAY_SECTION_KEYS);
  const result = [...new Set(value.filter(
    (item): item is TodaySectionKey => typeof item === "string" && allowed.has(item as TodaySectionKey),
  ))];
  return Object.freeze(result.length ? result : [...DEFAULT_TODAY_SECTIONS]);
}
