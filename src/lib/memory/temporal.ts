export type TemporalInterval = Readonly<{
  validFrom?: string | null;
  validTo?: string | null;
}>;

export type TemporalFact<T> = TemporalInterval & Readonly<{
  id: string;
  value: T;
}>;

export type TemporalFactSelection<T> = Readonly<{
  facts: readonly TemporalFact<T>[];
  uncertainty: "none" | "no_matching_interval" | "overlapping_intervals";
}>;

/** Half-open validity: validFrom <= asOf < validTo. */
export function isTemporalIntervalActive(
  interval: TemporalInterval,
  asOf: string | number | Date,
) {
  const asOfMs = timestamp(asOf);
  if (asOfMs === undefined) return false;
  const validFromMs = optionalTimestamp(interval.validFrom);
  const validToMs = optionalTimestamp(interval.validTo);
  if (validFromMs === null || validToMs === null) return false;
  if (
    validFromMs !== undefined &&
    validToMs !== undefined &&
    validFromMs >= validToMs
  ) {
    return false;
  }
  return (validFromMs === undefined || validFromMs <= asOfMs) &&
    (validToMs === undefined || asOfMs < validToMs);
}

export function selectTemporalFactsAsOf<T>(
  facts: readonly TemporalFact<T>[],
  asOf: string | number | Date,
): TemporalFactSelection<T> {
  const asOfMs = timestamp(asOf);
  if (asOfMs === undefined) throw new Error("Temporal as-of time is invalid.");
  const ids = facts.map((fact) => fact.id.trim());
  if (ids.some((id) => !id || id.length > 240) || new Set(ids).size !== ids.length) {
    throw new Error("Temporal fact IDs must be unique, bounded, and non-empty.");
  }
  if (facts.length > 256) throw new Error("Temporal fact selection is bounded to 256 facts.");
  for (const fact of facts) {
    if (
      optionalTimestamp(fact.validFrom) === null ||
      optionalTimestamp(fact.validTo) === null
    ) {
      throw new Error("Temporal fact interval is invalid.");
    }
  }
  const selected = facts.filter((fact) =>
    isTemporalIntervalActive(fact, asOfMs)
  );
  return Object.freeze({
    facts: Object.freeze(selected.map((fact) => Object.freeze({ ...fact }))),
    uncertainty: selected.length === 1
      ? "none"
      : selected.length === 0
        ? "no_matching_interval"
        : "overlapping_intervals",
  });
}

function optionalTimestamp(value: string | null | undefined) {
  if (value === undefined || value === null || value === "") return undefined;
  return timestamp(value) ?? null;
}

function timestamp(value: string | number | Date) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
