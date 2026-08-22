import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const algorithm = "aes-256-gcm";
const associatedDataPrefix = "omniagent:tool-execution-input:v1";
const localDevelopmentSecret = "omniagent-local-development-seal-key";

export type SealedPayload = {
  version: 1;
  algorithm: typeof algorithm;
  iv: string;
  ciphertext: string;
  tag: string;
};

export function sealJsonPayload(value: unknown, binding = ""): SealedPayload {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, payloadEncryptionKey(), iv);
  cipher.setAAD(associatedData(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function openJsonPayload(value: unknown, binding = ""): unknown {
  const payload = parseSealedPayload(value);
  try {
    const decipher = createDecipheriv(
      algorithm,
      payloadEncryptionKey(),
      Buffer.from(payload.iv, "base64url"),
    );
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new Error("The approved execution payload could not be authenticated.");
  }
}

export function isSealedPayload(value: unknown): value is SealedPayload {
  try {
    parseSealedPayload(value);
    return true;
  } catch {
    return false;
  }
}

function parseSealedPayload(value: unknown): SealedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The approved execution payload is missing.");
  }
  const candidate = value as Partial<SealedPayload>;
  if (
    candidate.version !== 1 ||
    candidate.algorithm !== algorithm ||
    !isBase64Url(candidate.iv, 12, 12) ||
    !isBase64Url(candidate.tag, 16, 16) ||
    !isBase64Url(candidate.ciphertext, 0, 300_000)
  ) {
    throw new Error("The approved execution payload is invalid.");
  }
  return candidate as SealedPayload;
}

function payloadEncryptionKey() {
  const configured =
    process.env.OMNIAGENT_EXECUTION_PAYLOAD_SECRET?.trim() ||
    process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (!configured && isProductionRuntime()) {
    throw new Error(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET must be configured before approval-gated inputs can be stored.",
    );
  }
  const secret = configured || localDevelopmentSecret;
  if (isProductionRuntime() && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET must contain at least 32 bytes.",
    );
  }
  return createHash("sha256")
    .update("omniagent:tool-execution-input:key:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function associatedData(binding: string) {
  const normalized = String(binding).slice(0, 1_000);
  return Buffer.from(`${associatedDataPrefix}\0${normalized}`, "utf8");
}

function isBase64Url(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.length >= minBytes &&
    decoded.length <= maxBytes &&
    decoded.toString("base64url") === value
  );
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV === "production",
  );
}
