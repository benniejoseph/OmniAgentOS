const redactedSecret = "[redacted-secret]";

export function redactExactSecrets<T>(value: T, secrets: Array<string | undefined>): T {
  const variants = secretVariants(secrets);
  if (!variants.length) {
    return value;
  }
  return redactValue(value, variants, 0) as T;
}

function redactValue(value: unknown, variants: string[], depth: number): unknown {
  if (depth > 40) {
    return "[truncated-depth]";
  }
  if (typeof value === "string") {
    return redactString(value, variants);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, variants, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactString(key, variants),
      redactValue(item, variants, depth + 1),
    ]),
  );
}

function redactString(value: string, variants: string[]) {
  let redacted = value;
  for (const variant of variants) {
    redacted = redacted.split(variant).join(redactedSecret);
  }
  return redacted;
}

function secretVariants(secrets: Array<string | undefined>) {
  const variants = new Set<string>();
  for (const rawSecret of secrets) {
    const secret = rawSecret?.trim();
    if (!secret || Buffer.byteLength(secret, "utf8") < 8) {
      continue;
    }
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(Buffer.from(secret, "utf8").toString("base64"));
    variants.add(Buffer.from(secret, "utf8").toString("base64url"));
  }
  return [...variants].sort((left, right) => right.length - left.length);
}
