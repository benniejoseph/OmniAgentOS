import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_BRANCH,
  RELEASE_REPOSITORY,
  REQUIRED_RELEASE_CHECKS,
} from "./release-provenance.mjs";

/**
 * A signed release manifest says the release runner released this revision of
 * the release branch with these green checks. The runner signs it with a key
 * that never leaves the release machine and hands it to the deployment, which
 * serves it from /api/health. A deployment made outside the runner has no
 * manifest a trusted key signed for the revision it serves.
 */
export const RELEASE_MANIFEST_VERSION = 1;
export const RELEASE_MANIFEST_ENV = "OMNIAGENT_RELEASE_MANIFEST";
export const RELEASE_SIGNING_KEY_FILE_ENV = "OMNIAGENT_RELEASE_SIGNING_KEY_FILE";
/** The longest encoded manifest a deployment serves. */
export const RELEASE_MANIFEST_MAX_CHARS = 4096;

/**
 * The public keys a release manifest may be signed by, as base64 SPKI DER.
 * Rotate by adding the new key, releasing with it, then removing the old one.
 */
export const RELEASE_SIGNING_PUBLIC_KEYS = Object.freeze([
  // a435a0bd1e543803, created 2026-10-01.
  "MCowBQYDK2VwAyEAJX0d+5tT9LeW/yL90aMkC2OucRGF0xOiNTfTdziH4ks=",
]);

const SIGNATURE_ALGORITHM = "Ed25519";
const ED25519_SIGNATURE_BYTES = 64;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[a-f0-9]{16}$/;
const REVISION = /^[a-f0-9]{40}$/;
const CHECK_NAME = /^[\x20-\x7e]{1,100}$/;
const MAX_CHECKS = 64;
const MAX_KEY_FILE_BYTES = 4096;
const ENVELOPE_KEYS = ["payload", "signature"];
const SIGNATURE_KEYS = ["algorithm", "keyId", "value"];
const PAYLOAD_KEYS = ["branch", "checks", "repository", "revision", "signedAt", "version"];
// The checkout a deploy uploads, wherever the runner is started from.
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @typedef {{
 *   version: number;
 *   revision: string;
 *   repository: string;
 *   branch: string;
 *   checks: string[];
 *   signedAt: string;
 * }} ReleaseManifest
 */

/**
 * Signs a manifest and encodes it for a deployment's environment.
 * @param {ReleaseManifest} manifest
 * @param {{ privateKey: import("node:crypto").KeyObject }} key
 */
export function signReleaseManifest(manifest, { privateKey }) {
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(`The release manifest ${problem}.`);
  const payload = {
    version: manifest.version,
    revision: manifest.revision,
    repository: manifest.repository,
    branch: manifest.branch,
    checks: [...manifest.checks],
    signedAt: manifest.signedAt,
  };
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey);
  const encoded = Buffer.from(JSON.stringify({
    payload,
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      keyId: releaseSigningKeyId(createPublicKey(privateKey)),
      value: signature.toString("base64url"),
    },
  })).toString("base64url");
  if (encoded.length > RELEASE_MANIFEST_MAX_CHARS) {
    throw new Error(
      `The release manifest is longer than ${RELEASE_MANIFEST_MAX_CHARS} characters.`,
    );
  }
  return encoded;
}

/**
 * Checks an encoded manifest against the trusted public keys. Never throws on
 * what a deployment serves: an unusable manifest is a result, not an error.
 * @param {unknown} encoded
 * @param {{ publicKeys?: readonly string[] }} [options]
 * @returns {{ valid: true; keyId: string; manifest: ReleaseManifest }
 *   | { valid: false; error: string }}
 */
export function verifyReleaseManifest(
  encoded,
  { publicKeys = RELEASE_SIGNING_PUBLIC_KEYS } = {},
) {
  if (typeof encoded !== "string" || !encoded) return invalid("is missing");
  if (encoded.length > RELEASE_MANIFEST_MAX_CHARS || !ENCODED.test(encoded)) {
    return invalid("is not an encoded release manifest");
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return invalid("is not an encoded release manifest");
  }
  const signature = envelope?.signature;
  if (
    !hasExactKeys(envelope, ENVELOPE_KEYS) ||
    !isRecord(envelope.payload) ||
    !hasExactKeys(signature, SIGNATURE_KEYS)
  ) {
    return invalid("is not a signed release manifest");
  }
  if (signature.algorithm !== SIGNATURE_ALGORITHM) {
    return invalid(`is signed with ${diagnostic(signature.algorithm)}, not ${SIGNATURE_ALGORITHM}`);
  }
  if (typeof signature.keyId !== "string" || !KEY_ID.test(signature.keyId)) {
    return invalid("names no signing key");
  }
  const trusted = publicKeys
    .map(publicKeyFromBase64)
    .find((key) => releaseSigningKeyId(key) === signature.keyId);
  if (!trusted) {
    return invalid(`is signed by key ${signature.keyId}, which this repository does not trust`);
  }
  const value = typeof signature.value === "string" && ENCODED.test(signature.value)
    ? Buffer.from(signature.value, "base64url")
    : Buffer.alloc(0);
  if (
    value.length !== ED25519_SIGNATURE_BYTES ||
    !verify(null, Buffer.from(canonicalJson(envelope.payload)), trusted, value)
  ) {
    return invalid(`carries a signature key ${signature.keyId} did not make`);
  }
  const problem = manifestProblem(envelope.payload);
  if (problem) return invalid(problem);
  return { valid: true, keyId: signature.keyId, manifest: envelope.payload };
}

/**
 * The release runner's signing key, from the private key file that
 * OMNIAGENT_RELEASE_SIGNING_KEY_FILE names. The file must hold an Ed25519 key
 * that only its owner can read, outside the checkout a deploy uploads. Errors
 * never quote the file.
 * @param {{ env?: Record<string, string | undefined>; checkout?: string }} [options]
 */
export function loadReleaseSigningKey({
  env = process.env,
  checkout = REPOSITORY_ROOT,
} = {}) {
  const name = RELEASE_SIGNING_KEY_FILE_ENV;
  const configured = env[name]?.trim();
  if (!configured) {
    throw new Error(`${name} is required: every release signs its manifest with that key.`);
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  let file;
  let stats;
  try {
    file = realpathSync(configured);
    stats = statSync(file);
  } catch {
    throw new Error(`${name} does not name a readable file.`);
  }
  if (!stats.isFile()) {
    throw new Error(`${name} does not name a readable file.`);
  }
  if (isInside(file, realpathSync(checkout))) {
    throw new Error(`${name} must be outside the release checkout, which the deploy uploads.`);
  }
  if (stats.mode & 0o077) {
    throw new Error(`${name} must be readable only by its owner (chmod 600).`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${name} must be owned by the user running the release.`);
  }
  let privateKey;
  try {
    if (stats.size > MAX_KEY_FILE_BYTES) throw new Error("too large");
    privateKey = createPrivateKey(readFileSync(file));
  } catch {
    throw new Error(`${name} is not an Ed25519 private key.`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${name} is not an Ed25519 private key.`);
  }
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: releaseSigningKeyId(publicKey),
    publicKey: publicKeyToBase64(publicKey),
    privateKey,
  };
}

/** A new signing key: the private key as PEM and its public key to commit. */
export function generateReleaseSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId: releaseSigningKeyId(publicKey),
    publicKey: publicKeyToBase64(publicKey),
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
  };
}

/**
 * The id a manifest names its key by: the start of the key's SHA-256.
 * @param {import("node:crypto").KeyObject} publicKey
 */
export function releaseSigningKeyId(publicKey) {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);
}

/** @param {string} value */
export function publicKeyFromBase64(value) {
  return createPublicKey({
    key: Buffer.from(value, "base64"),
    format: "der",
    type: "spki",
  });
}

/** @param {import("node:crypto").KeyObject} publicKey */
function publicKeyToBase64(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** @param {unknown} manifest */
function manifestProblem(manifest) {
  if (!isRecord(manifest)) return "is not a release manifest";
  if (manifest.version !== RELEASE_MANIFEST_VERSION) {
    return `is version ${diagnostic(manifest.version)}, not ${RELEASE_MANIFEST_VERSION}`;
  }
  if (!hasExactKeys(manifest, PAYLOAD_KEYS)) {
    return `is not a version ${RELEASE_MANIFEST_VERSION} release manifest`;
  }
  if (typeof manifest.revision !== "string" || !REVISION.test(manifest.revision)) {
    return "names no exact revision";
  }
  if (manifest.repository !== RELEASE_REPOSITORY || manifest.branch !== RELEASE_BRANCH) {
    return `releases ${diagnostic(manifest.repository)} ${diagnostic(manifest.branch)}, not ${RELEASE_REPOSITORY} ${RELEASE_BRANCH}`;
  }
  const checks = manifest.checks;
  if (
    !Array.isArray(checks) ||
    checks.length > MAX_CHECKS ||
    !checks.every((check) => typeof check === "string" && CHECK_NAME.test(check))
  ) {
    return "lists unreadable checks";
  }
  const missing = REQUIRED_RELEASE_CHECKS.filter((check) => !checks.includes(check));
  if (missing.length) return `does not list the required checks ${missing.join(", ")}`;
  if (typeof manifest.signedAt !== "string" || !isTimestamp(manifest.signedAt)) {
    return "has no signing time";
  }
  return undefined;
}

/** @param {string} error */
function invalid(error) {
  return /** @type {const} */ ({ valid: false, error });
}

// Sorted keys, so a signature covers the manifest's meaning, not its layout.
/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** @param {unknown} value @returns {unknown} */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]),
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string[]} keys */
function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const present = Object.keys(value).sort();
  return present.length === keys.length &&
    [...keys].sort().every((key, index) => present[index] === key);
}

/** @param {string} value */
function isTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** @param {string} file @param {string} directory */
function isInside(file, directory) {
  const relative = path.relative(directory, file);
  return relative === "" ||
    (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..");
}

/** @param {unknown} value */
function diagnostic(value) {
  return String(value ?? "missing").replace(/[^\x20-\x7e]/g, "?").slice(0, 80) || "missing";
}
