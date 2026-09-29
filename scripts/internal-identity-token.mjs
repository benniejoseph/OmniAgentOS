import { createHmac, hkdfSync } from "node:crypto";

// src/lib/security/internal-auth.ts verifies these tokens; keep the two in step.
const TOKEN_VERSION = "v1";
const KEY_LABEL = "asael:internal-identity-token:v1";
export const INTERNAL_IDENTITY_TOKEN_LIFETIME_SECONDS = 300;

/**
 * Headers that authenticate one request as one exact tenant, actor and role.
 * The token also names the request's method and path and expires after five
 * minutes, so the deployment secret itself never leaves this process.
 */
export function internalIdentityHeaders(secret, identity, now = Date.now()) {
  const fields = {
    tenantId: headerValue(identity.tenantId),
    actorId: headerValue(identity.actorId),
    role: headerValue(identity.role),
    method: headerValue(identity.method).toUpperCase(),
    pathname: headerValue(identity.pathname),
  };
  if (!fields.method || !fields.pathname.startsWith("/")) {
    throw new Error("An internal identity token needs the request method and path.");
  }
  const expiresAt =
    Math.floor(now / 1_000) + INTERNAL_IDENTITY_TOKEN_LIFETIME_SECONDS;
  return {
    "x-omni-internal-auth": `${TOKEN_VERSION}.${expiresAt}.${internalIdentitySignature(secret, expiresAt, fields)}`,
    ...(fields.tenantId ? { "x-omni-tenant-id": fields.tenantId } : {}),
    ...(fields.actorId ? { "x-omni-user-id": fields.actorId } : {}),
    ...(fields.role ? { "x-omni-user-role": fields.role } : {}),
  };
}

export function internalIdentitySignature(secret, expiresAt, fields) {
  const normalizedSecret = headerValue(secret);
  if (!normalizedSecret) {
    throw new Error("An internal identity token needs the deployment secret.");
  }
  const key = Buffer.from(
    hkdfSync("sha256", normalizedSecret, "", KEY_LABEL, 32),
  );
  return createHmac("sha256", key)
    .update(
      [
        TOKEN_VERSION,
        String(expiresAt),
        fields.tenantId,
        fields.actorId,
        fields.role,
        fields.method,
        fields.pathname,
      ].join("\0"),
    )
    .digest("base64url");
}

function headerValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
