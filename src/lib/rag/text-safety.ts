const REPLACEMENT_CHARACTER = "\uFFFD";

/**
 * PostgreSQL jsonb rejects NUL characters and unpaired UTF-16 surrogates even
 * when JSON.stringify escapes them. Replace only those invalid code units so
 * externally sourced text remains persistable without changing valid Unicode.
 */
export function jsonbSafeText(value: string) {
  let normalized = "";
  let unchangedStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isNull = codeUnit === 0;
    const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    }

    if (!isNull && !isHighSurrogate && !isLowSurrogate) continue;

    normalized += value.slice(unchangedStart, index) + REPLACEMENT_CHARACTER;
    unchangedStart = index + 1;
  }

  return unchangedStart === 0
    ? value
    : normalized + value.slice(unchangedStart);
}

/**
 * Bound externally sourced text without splitting a valid Unicode surrogate
 * pair, then apply PostgreSQL jsonb text safety to the result.
 */
export function jsonbSafeTruncate(value: string, maxLength: number) {
  const normalized = jsonbSafeText(value);
  const limit = Math.max(0, Math.floor(maxLength));
  if (normalized.length <= limit) return normalized;

  let end = limit;
  const previous = normalized.charCodeAt(end - 1);
  const next = normalized.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    end -= 1;
  }

  return normalized.slice(0, end);
}

/**
 * Normalize every nested string immediately before a jsonb parameter is sent
 * to PostgreSQL. This is a persistence-boundary safeguard for values derived
 * from already-sanitized text later in a pipeline.
 *
 * The result is serialized text. When interpolating it with postgres.js, cast
 * it through text before jsonb (`::text::jsonb`) so the driver does not apply
 * its JSON serializer a second time and turn an array/object into a JSON string.
 */
export function jsonbSafeStringify(value: unknown) {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return jsonbSafeText(item);
    if (typeof item === "bigint") return item.toString();
    return item;
  });
  return serialized ?? "null";
}
