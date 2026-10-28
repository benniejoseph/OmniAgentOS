/** Private, bounded release receipts with immutable content-addressed ancestry. */
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const IMPROVEMENT_RECEIPT_MAX_BYTES = 100_000;
// Limits apply before a retained input can admit another paid phase. They are
// independent of the per-file privacy boundary and do not extend agent budgets.
const MAX_ANCESTRY_REFERENCES = 32, MAX_ANCESTRY_DEPTH = 32, MAX_TOTAL_BYTES = 2_000_000;
const ancestorFields = ["normalQueueFailure", "stagedTerminalNoop", "ownerRejectedStage", "stagedOrigin"];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hash = raw => createHash("sha256").update(raw).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const valueHash = value => hash(JSON.stringify(value));
const directoryFor = file => `${path.resolve(file)}.ancestry`;
const privateInfo = (info, directory = false) =>
  (directory ? info.isDirectory() : info.isFile()) && info.uid === process.getuid() && !(info.mode & 0o077);

async function checkDirectory(directory, create = false) {
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  assert(privateInfo(info, true) && !info.isSymbolicLink(), "Private improvement ancestry directory is invalid");
  return info;
}

async function privateBytes(file) {
  const target = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await target.stat();
    assert(privateInfo(info) && info.size < IMPROVEMENT_RECEIPT_MAX_BYTES, "Private improvement receipt is invalid or exceeds its byte bound");
    // Do not read a concurrently enlarged file beyond the same fixed boundary.
    const raw = Buffer.alloc(IMPROVEMENT_RECEIPT_MAX_BYTES);
    const { bytesRead } = await target.read(raw, 0, raw.length, 0);
    assert(bytesRead === info.size && bytesRead < IMPROVEMENT_RECEIPT_MAX_BYTES, "Private improvement receipt changed while reading");
    return raw.subarray(0, bytesRead);
  } finally { await target.close(); }
}

function reference(value) {
  if (!object(value) || !Object.hasOwn(value, "receiptReference")) return undefined;
  const ref = value.receiptReference;
  assert(Object.keys(value).length === 1 && object(ref) &&
    Object.keys(ref).sort().join(",") === "bytes,sha256,valueSha256,version" && ref.version === 1 &&
    /^[a-f0-9]{64}$/.test(ref.sha256 || "") && /^[a-f0-9]{64}$/.test(ref.valueSha256 || "") &&
    Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes < IMPROVEMENT_RECEIPT_MAX_BYTES,
  "Improvement ancestry reference is invalid");
  return ref;
}

function context(directory) { return { directory, references: 0, totalBytes: 0, stack: new Set() }; }
function countBytes(ctx, bytes) {
  ctx.totalBytes += bytes;
  assert(ctx.totalBytes <= MAX_TOTAL_BYTES, "Improvement receipt ancestry exceeds its aggregate byte bound");
}
function countReference(ctx, depth) {
  assert(++ctx.references <= MAX_ANCESTRY_REFERENCES && depth <= MAX_ANCESTRY_DEPTH,
    "Improvement receipt ancestry exceeds its traversal bound");
}
function materialized(value) {
  assert(Buffer.byteLength(JSON.stringify(value)) <= MAX_TOTAL_BYTES, "Improvement receipt exceeds its materialized byte bound");
  return value;
}

async function decodeDocument(document, ctx, depth = 0) {
  assert(object(document) && !Object.hasOwn(document, "receiptReference") && depth <= MAX_ANCESTRY_DEPTH,
    "Improvement receipt document is invalid");
  const result = { ...document };
  if (object(document.continuation)) {
    result.continuation = { ...document.continuation };
    for (const field of ancestorFields) {
      const value = document.continuation[field];
      if (value === undefined) continue;
      const ref = reference(value);
      if (!ref) {
        // Legacy small receipts remain readable with their complete inline
        // ancestry. Mixed legacy/reference histories retain every field.
        result.continuation[field] = await decodeDocument(value, ctx, depth + 1);
        continue;
      }
      countReference(ctx, depth + 1);
      assert(!ctx.stack.has(ref.sha256), "Improvement ancestry contains a reference cycle");
      const before = await checkDirectory(ctx.directory);
      const raw = await privateBytes(path.join(ctx.directory, `${ref.sha256}.json`));
      const after = await checkDirectory(ctx.directory);
      assert(before.dev === after.dev && before.ino === after.ino, "Improvement ancestry directory changed while reading");
      assert(raw.length === ref.bytes && hash(raw) === ref.sha256, "Improvement ancestry bytes changed");
      countBytes(ctx, raw.length);
      ctx.stack.add(ref.sha256);
      const ancestor = await decodeDocument(JSON.parse(raw.toString("utf8")), ctx, depth + 1);
      ctx.stack.delete(ref.sha256);
      assert(valueHash(ancestor) === ref.valueSha256, "Improvement ancestry content changed");
      result.continuation[field] = ancestor;
    }
  }
  return materialized(result);
}

async function storeAncestor(directory, raw) {
  await checkDirectory(directory, true);
  const sha256 = hash(raw), file = path.join(directory, `${sha256}.json`);
  let target;
  try { target = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert((await privateBytes(file)).equals(raw), "Existing immutable improvement ancestry changed");
    return sha256;
  }
  try { await target.writeFile(raw); await target.sync(); } finally { await target.close(); }
  return sha256;
}

async function encodeDocument(document, ctx, depth = 0) {
  assert(object(document) && !Object.hasOwn(document, "receiptReference") && depth <= MAX_ANCESTRY_DEPTH,
    "Improvement receipt document is invalid");
  const result = { ...document };
  if (object(document.continuation)) {
    result.continuation = { ...document.continuation };
    for (const field of ancestorFields) {
      const value = document.continuation[field];
      if (value === undefined) continue;
      // Callers operate on materialized, already-verified evidence. Never turn
      // an unresolved caller-supplied link into a trusted ancestry reference.
      assert(!reference(value), "Resolve improvement ancestry before writing");
      countReference(ctx, depth + 1);
      const ancestor = await encodeDocument(value, ctx, depth + 1);
      const raw = encoded(ancestor);
      assert(raw.length < IMPROVEMENT_RECEIPT_MAX_BYTES, "Improvement ancestry receipt exceeds its byte bound");
      countBytes(ctx, raw.length);
      const sha256 = await storeAncestor(ctx.directory, raw);
      result.continuation[field] = { receiptReference: { version: 1, sha256, bytes: raw.length, valueSha256: valueHash(value) } };
    }
  }
  return result;
}

/** Resolve bounded local ancestry before any login or new paid work. */
export async function readImprovementReceipt(file, { expectedSha256 } = {}) {
  const raw = await privateBytes(file);
  if (expectedSha256 !== undefined) assert(/^[a-f0-9]{64}$/.test(expectedSha256) && hash(raw) === expectedSha256,
    "Pinned improvement receipt changed");
  const ctx = context(directoryFor(file)); countBytes(ctx, raw.length);
  return decodeDocument(JSON.parse(raw.toString("utf8")), ctx);
}

/** Validate before replacing the current receipt, then read the exact bytes back. */
export async function writeImprovementReceipt(file, evidence, { create = false } = {}) {
  const normalized = JSON.parse(JSON.stringify(materialized(evidence)));
  const ctx = context(directoryFor(file));
  const document = await encodeDocument(normalized, ctx);
  const raw = encoded(document);
  assert(raw.length < IMPROVEMENT_RECEIPT_MAX_BYTES, "Improvement receipt exceeds its byte bound");
  countBytes(ctx, raw.length);
  // The same decoder verifies all links while the previous current receipt is
  // still intact. Missing/changed ancestry can never produce an unreadable save.
  const preflight = context(directoryFor(file)); countBytes(preflight, raw.length);
  assert(valueHash(await decodeDocument(document, preflight)) === valueHash(normalized), "Improvement receipt roundtrip changed its content");
  if (create) {
    const target = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await target.writeFile(raw); await target.sync(); } finally { await target.close(); }
  } else {
    const before = await lstat(file);
    assert(privateInfo(before) && !before.isSymbolicLink(), "Private improvement receipt ownership changed");
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    const target = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await target.writeFile(raw); await target.sync(); await target.close();
      const current = await lstat(file);
      assert(privateInfo(current) && !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino,
        "Private improvement receipt changed before replacement");
      await rename(temporary, file);
    } finally { await target.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  assert(valueHash(await readImprovementReceipt(file)) === valueHash(normalized), "Saved improvement receipt is not readable");
}
