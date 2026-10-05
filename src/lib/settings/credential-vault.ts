import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const CREDENTIAL_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_PAYLOAD_VERSION = 1;
const AAD_PREFIX = "omniagent:tenant-credential:v1";

export type SealedCredentialPayload = {
  version: typeof CREDENTIAL_PAYLOAD_VERSION;
  algorithm: typeof CREDENTIAL_ALGORITHM;
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
};

export class CredentialVaultUnavailableError extends Error {
  readonly status = 503;

  constructor(message = "The independent credential keyring is not configured.") {
    super(message);
    this.name = "CredentialVaultUnavailableError";
  }
}

export function credentialVaultStatus() {
  try {
    const keyring = readCredentialKeyring();
    return {
      configured: true,
      activeKeyId: keyring.activeKeyId,
      message: "Tenant credentials are sealed with the independent credential keyring.",
    } as const;
  } catch {
    return {
      configured: false,
      message:
        "Add OMNIAGENT_CREDENTIAL_KEYRING before saving tenant credentials. Deployment environment keys continue to work as the runtime fallback.",
    } as const;
  }
}

export function sealCredentialBundle(
  credentials: Record<string, string>,
  binding: string,
): SealedCredentialPayload {
  const keyring = readCredentialKeyring();
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new CredentialVaultUnavailableError();

  const iv = randomBytes(12);
  const cipher = createCipheriv(CREDENTIAL_ALGORITHM, key, iv);
  cipher.setAAD(associatedData(binding));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    version: CREDENTIAL_PAYLOAD_VERSION,
    algorithm: CREDENTIAL_ALGORITHM,
    keyId: keyring.activeKeyId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function openCredentialBundle(
  value: unknown,
  binding: string,
): Record<string, string> {
  const payload = parseSealedCredentialPayload(value);
  const key = readCredentialKeyring().keys.get(payload.keyId);
  if (!key) {
    throw new CredentialVaultUnavailableError(
      `Credential key ${payload.keyId} is not available in OMNIAGENT_CREDENTIAL_KEYRING.`,
    );
  }
  try {
    const decipher = createDecipheriv(
      CREDENTIAL_ALGORITHM,
      key,
      Buffer.from(payload.iv, "base64url"),
    );
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid credential bundle.");
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([name, item]) => {
        if (typeof item !== "string") throw new Error("Invalid credential field.");
        return [name, item];
      }),
    );
  } catch (error) {
    if (error instanceof CredentialVaultUnavailableError) throw error;
    throw new Error("The tenant credential bundle could not be authenticated.");
  }
}

export function credentialBinding(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
  provider: string;
  credentialVersion: number;
}) {
  return [
    input.tenantId,
    input.actorId,
    input.connectionId,
    input.provider,
    String(input.credentialVersion),
  ].join(":");
}

/** Native OpenAPI snapshots have a separate bounded envelope. Ordinary credential
 * readers keep their existing 64,000-byte limit and AAD convention unchanged. */
export const NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES = 4_000_000;
function nativeOpenapiSnapshotAad(binding: string) {
  if (!/^asael:native-openapi-import-snapshot:v1:[a-f0-9]{64}$/.test(binding)) {
    throw new Error("The OpenAPI snapshot binding is invalid.");
  }
  return Buffer.from(binding, "utf8");
}

export function sealNativeOpenapiImportSnapshot(snapshot: unknown, binding: string): SealedCredentialPayload {
  const plaintext = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (!plaintext.length || plaintext.length > NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES) {
    throw new Error("The OpenAPI snapshot exceeds its protected staging bound.");
  }
  try {
    const keyring = readCredentialKeyring(), key = keyring.keys.get(keyring.activeKeyId);
    if (!key) throw new CredentialVaultUnavailableError();
    const iv = randomBytes(12), cipher = createCipheriv(CREDENTIAL_ALGORITHM, key, iv);
    cipher.setAAD(nativeOpenapiSnapshotAad(binding));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, algorithm: CREDENTIAL_ALGORITHM, keyId: keyring.activeKeyId,
      iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
  } finally { plaintext.fill(0); }
}

export function openNativeOpenapiImportSnapshot(value: unknown, binding: string): unknown {
  const payload = parseSealedCredentialPayload(value, NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES);
  const key = readCredentialKeyring().keys.get(payload.keyId);
  if (!key) throw new CredentialVaultUnavailableError();
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CREDENTIAL_ALGORITHM, key, Buffer.from(payload.iv, "base64url"));
    decipher.setAAD(nativeOpenapiSnapshotAad(binding));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64url")), decipher.final()]);
    if (plaintext.length > NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES) throw new Error("Snapshot overflow.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch { throw new Error("The OpenAPI snapshot could not be authenticated."); }
  finally { plaintext?.fill(0); }
}

function readCredentialKeyring() {
  const raw = process.env.OMNIAGENT_CREDENTIAL_KEYRING?.trim();
  if (!raw) throw new CredentialVaultUnavailableError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialVaultUnavailableError(
      "OMNIAGENT_CREDENTIAL_KEYRING must be valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialVaultUnavailableError();
  }
  const record = parsed as Record<string, unknown>;
  const activeKeyId = typeof record.activeKeyId === "string"
    ? record.activeKeyId.trim()
    : "";
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(activeKeyId)) {
    throw new CredentialVaultUnavailableError(
      "The credential keyring needs a valid activeKeyId.",
    );
  }
  if (!record.keys || typeof record.keys !== "object" || Array.isArray(record.keys)) {
    throw new CredentialVaultUnavailableError(
      "The credential keyring needs a keys object.",
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(record.keys as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(keyId) || typeof encoded !== "string") continue;
    const key = Buffer.from(encoded, "base64url");
    if (key.length === 32 && key.toString("base64url") === encoded) keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new CredentialVaultUnavailableError(
      "The active credential key must be a 32-byte base64url value.",
    );
  }
  return { activeKeyId, keys };
}

function parseSealedCredentialPayload(value: unknown, maximumBytes = 64_000): SealedCredentialPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The tenant credential bundle is missing.");
  }
  const payload = value as Partial<SealedCredentialPayload>;
  if (
    payload.version !== CREDENTIAL_PAYLOAD_VERSION ||
    payload.algorithm !== CREDENTIAL_ALGORITHM ||
    typeof payload.keyId !== "string" ||
    !isBase64Url(payload.iv, 12, 12) ||
    !isBase64Url(payload.tag, 16, 16) ||
    !isBase64Url(payload.ciphertext, 1, maximumBytes)
  ) {
    throw new Error("The tenant credential bundle is invalid.");
  }
  return payload as SealedCredentialPayload;
}

function associatedData(binding: string) {
  return Buffer.from(`${AAD_PREFIX}\0${binding.slice(0, 1_000)}`, "utf8");
}

function isBase64Url(value: unknown, minBytes: number, maxBytes: number) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= minBytes && decoded.length <= maxBytes &&
    decoded.toString("base64url") === value;
}
