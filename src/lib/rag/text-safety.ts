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
