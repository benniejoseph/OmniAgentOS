import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// scripts/internal-identity-token.mjs mints these tokens; keep the two in step.
const TOKEN_VERSION = "v1";
const KEY_LABEL = "asael:internal-identity-token:v1";
const TOKEN_PATTERN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
// Tokens are minted for five minutes. A later expiry is refused, with room
// for clock skew between the worker host and this deployment.
const MAX_TOKEN_HORIZON_SECONDS = 900;

type InternalSecretHeader = "x-omni-internal-auth" | "x-omni-synthetic-auth";

/** Compare two secrets without revealing where they first differ. */
export function secretsMatch(expected: string, provided: string) {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/** True when the header carries the deployment's raw internal secret. */
export function carriesInternalSecret(
  request: Request | undefined,
  header: InternalSecretHeader,
) {
  const configured = configuredInternalSecret();
  const provided = request?.headers.get(header)?.trim();
  return Boolean(configured && provided && secretsMatch(configured, provided));
}

/**
 * True when x-omni-internal-auth is an unexpired token signed for this
 * request's method, path, tenant, actor and role headers.
 */
export function hasInternalIdentityToken(
  request: Request | undefined,
  now = Date.now(),
) {
  const secret = configuredInternalSecret();
  const token = request?.headers.get("x-omni-internal-auth")?.trim();
  const match = token ? TOKEN_PATTERN.exec(token) : null;
  if (!request || !secret || !match) return false;
  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1_000);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_TOKEN_HORIZON_SECONDS) {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  const expected = Buffer.from(
    internalIdentitySignature(secret, expiresAt, {
      tenantId: headerValue(request, "x-omni-tenant-id"),
      actorId: headerValue(request, "x-omni-user-id"),
      role: headerValue(request, "x-omni-user-role"),
      method: request.method.toUpperCase(),
      pathname,
    }),
    "base64url",
  );
  const provided = Buffer.from(match[2], "base64url");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function internalIdentitySignature(
  secret: string,
  expiresAt: number,
  fields: { tenantId: string; actorId: string; role: string; method: string; pathname: string },
) {
  const key = Buffer.from(hkdfSync("sha256", secret, "", KEY_LABEL, 32));
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

function configuredInternalSecret() {
  return process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim() || undefined;
}

function headerValue(request: Request, name: string) {
  return request.headers.get(name)?.trim() || "";
}
