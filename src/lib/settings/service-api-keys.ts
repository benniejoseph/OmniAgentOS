import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { appendDomainEventSafely } from "@/lib/events/store";
import {
  getServiceApiKeyRecord,
  insertServiceApiKey,
  listServiceApiKeyRecords,
  updateServiceApiKeyRecord,
} from "@/lib/settings/store";
import {
  SERVICE_API_SCOPES,
  type RedactedServiceApiKey,
  type ServiceApiKeyPrincipal,
  type ServiceApiScope,
} from "@/lib/settings/types";

export { SERVICE_API_SCOPES } from "@/lib/settings/types";
export type {
  RedactedServiceApiKey,
  ServiceApiKeyPrincipal,
  ServiceApiScope,
} from "@/lib/settings/types";

const TOKEN_PREFIX = "omni_sk";

export class ServiceApiKeyError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
    this.name = "ServiceApiKeyError";
  }
}

export async function createServiceApiKey(input: {
  tenantId: string;
  actorId: string;
  name: string;
  scopes: ServiceApiScope[];
  expiresAt?: string;
}): Promise<{ record: RedactedServiceApiKey; token: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ServiceApiKeyError("API key name is required.");
  const scopes = [...new Set(input.scopes)].filter((scope): scope is ServiceApiScope =>
    SERVICE_API_SCOPES.includes(scope as ServiceApiScope)
  );
  if (!scopes.length) throw new ServiceApiKeyError("Select at least one API scope.");

  const expiresAt = normalizeFutureDate(input.expiresAt);
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const tenantSegment = Buffer.from(input.tenantId, "utf8").toString("base64url");
  const token = `${TOKEN_PREFIX}_${tenantSegment}.${id}.${secret}`;
  const now = new Date().toISOString();
  const internal = await insertServiceApiKey({
    id,
    tenantId: input.tenantId,
    actorId: input.actorId,
    name,
    tokenHash: tokenDigest(token),
    tokenPrefix: `${TOKEN_PREFIX}_${tenantSegment.slice(0, 10)}…${id.slice(0, 8)}`,
    tokenLastFour: secret.slice(-4),
    scopes,
    status: "active",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await appendDomainEventSafely({
    streamId: `settings:${input.actorId}`,
    type: "settings.service_api_key.created",
    tenantId: input.tenantId,
    actorId: input.actorId,
    payload: { keyId: internal.id, name: internal.name, scopes: internal.scopes, expiresAt },
  });
  return { record: redactServiceApiKey(internal), token };
}

export async function listServiceApiKeys(input: {
  tenantId: string;
  actorId?: string;
}): Promise<RedactedServiceApiKey[]> {
  return (await listServiceApiKeyRecords(input)).map(redactServiceApiKey);
}

export async function revokeServiceApiKey(input: {
  tenantId: string;
  actorId: string;
  keyId: string;
}) {
  const record = await updateServiceApiKeyRecord({ ...input, status: "revoked" });
  if (!record) throw new ServiceApiKeyError("API key not found.", 404);
  await appendDomainEventSafely({
    streamId: `settings:${input.actorId}`,
    type: "settings.service_api_key.revoked",
    tenantId: input.tenantId,
    actorId: input.actorId,
    payload: { keyId: input.keyId, name: record.name },
  });
  return redactServiceApiKey(record);
}

/**
 * Resolves an untrusted Bearer token into a verified tenant, actor, and scope
 * principal. The tenant encoded in the token is only a lookup partition; the
 * returned identity always comes from the hash-matched RLS-scoped record.
 */
export async function resolveServiceApiKeyToken(
  token: string,
): Promise<ServiceApiKeyPrincipal | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const record = await getServiceApiKeyRecord({
    tenantId: parsed.tenantId,
    keyId: parsed.keyId,
  });
  if (!record || record.status !== "active") return null;
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;
  const expected = Buffer.from(record.tokenHash, "hex");
  const supplied = Buffer.from(tokenDigest(token), "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  const lastUsedAt = new Date().toISOString();
  await updateServiceApiKeyRecord({
    tenantId: record.tenantId,
    actorId: record.actorId,
    keyId: record.id,
    lastUsedAt,
  });
  return {
    keyId: record.id,
    tenantId: record.tenantId,
    actorId: record.actorId,
    name: record.name,
    scopes: record.scopes,
  };
}

export function assertServiceApiKeyScope(
  principal: ServiceApiKeyPrincipal,
  required: ServiceApiScope | readonly ServiceApiScope[],
) {
  const requirements: readonly ServiceApiScope[] = typeof required === "string"
    ? [required]
    : required;
  const missing = requirements.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length) {
    throw new ServiceApiKeyError(
      `The service API key does not grant: ${missing.join(", ")}.`,
      403,
    );
  }
  return principal;
}

function redactServiceApiKey(record: RedactedServiceApiKey & { tokenHash: string }): RedactedServiceApiKey {
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: record.actorId,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    tokenLastFour: record.tokenLastFour,
    scopes: record.scopes,
    status: record.status,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  };
}

function parseToken(token: string) {
  const match = token.match(/^omni_sk_([A-Za-z0-9_-]{1,180})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return undefined;
  try {
    const tenantBuffer = Buffer.from(match[1], "base64url");
    if (tenantBuffer.toString("base64url") !== match[1]) return undefined;
    const tenantId = tenantBuffer.toString("utf8");
    if (!tenantId || Buffer.byteLength(tenantId, "utf8") > 120 || /[^a-zA-Z0-9_.:-]/.test(tenantId)) return undefined;
    return { tenantId, keyId: match[2] };
  } catch {
    return undefined;
  }
}

function tokenDigest(token: string) {
  return createHash("sha256")
    .update("omniagent:service-api-key:v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

function normalizeFutureDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new ServiceApiKeyError("API key expiry must be a future date.");
  }
  return date.toISOString();
}
