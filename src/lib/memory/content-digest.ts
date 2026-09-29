import { createHmac, hkdfSync } from "node:crypto";

const KEY_LABEL = "asael:memory-content-digest:v1";
const localDevelopmentSecret = "asael-local-development-memory-digest-key";

/**
 * A digest of memory text under a per-tenant key derived from the server
 * secret. Events and ids outlive the memory they describe, and a plain hash
 * of a short fact confirms a guess of it; this one needs the key.
 */
export function memoryContentDigest(tenantId: string, value: string) {
  return createHmac("sha256", tenantDigestKey(tenantId))
    .update(value, "utf8")
    .digest("hex");
}

function tenantDigestKey(tenantId: string) {
  return Buffer.from(
    hkdfSync("sha256", digestSecret(), "", `${KEY_LABEL}\0${tenantId}`, 32),
  );
}

function digestSecret() {
  const configured = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (configured) return configured;
  if (isProductionRuntime()) {
    throw new Error(
      "OMNIAGENT_INTERNAL_AUTH_SECRET must be configured before memory content can be digested.",
    );
  }
  return localDevelopmentSecret;
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV === "production",
  );
}
