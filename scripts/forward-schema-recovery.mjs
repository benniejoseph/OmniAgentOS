import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const REVISION = /^[a-f0-9]{40}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const TABLE = /^omni_[a-z][a-z0-9_]{0,57}$/;
const PIN_KEYS = ["previousRevision", "candidateRevision", "migrationVersion", "migrationChecksum", "unclassifiedTables"];
const CORE_GATES = [
  "tenant_isolation_database", "latest_tenant_isolation_eval", "internal_smoke_auth",
  "openai_provider", "cron_auth", "runtime_database_role", "dedicated_worker",
  "observability_slo", "eval_report_signing",
];
const EMPTY_ISOLATION_ARRAYS = [
  "missingTables", "missingTenantColumns", "rlsDisabled", "forceRlsDisabled", "missingPolicies",
];
const MAX_AGE_MS = 300_000;

/**
 * @typedef {{previousRevision:string, candidateRevision:string,
 * migrationVersion:number, migrationChecksum:string,
 * unclassifiedTables:readonly string[]}} ForwardSchemaRecoveryPin
 */

/**
 * Parse an explicit operator pin against the exact candidate's checked-in
 * migration manifest and SQL bytes. This authorizes no deployment by itself.
 * @param {unknown} raw
 * @param {{candidateRevision:string, manifestPath:string, repositoryRoot:string}} options
 * @returns {Readonly<ForwardSchemaRecoveryPin>|undefined}
 */
export function parseForwardSchemaRecovery(raw, { candidateRevision, manifestPath, repositoryRoot }) {
  if (raw === undefined || raw === null || typeof raw === "string" && !raw.trim()) return undefined;
  requireThat(typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= 8192,
    "pin must be bounded JSON");
  let pin;
  try {
    pin = JSON.parse(raw);
  } catch {
    reject("pin must be valid JSON");
  }
  validatePin(pin);
  // JSON.parse alone accepts repeated keys. Count actual JSON string tokens
  // used as property names, including escaped spellings, before admitting it.
  const propertyNames = [...raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)]
    .filter((match) => /^\s*:/.test(raw.slice(match.index + match[0].length)))
    .map((match) => JSON.parse(match[0]));
  requireThat(propertyNames.length === PIN_KEYS.length && new Set(propertyNames).size === PIN_KEYS.length,
    "pin must have exactly one of each required key");
  requireThat(REVISION.test(candidateRevision) && pin.candidateRevision === candidateRevision,
    "pin must identify the checked-out candidate revision");

  let manifest;
  let migrationBytes;
  let migrationChecksums;
  try {
    const root = realpathSync(repositoryRoot);
    const manifestFile = realpathSync(path.resolve(root, manifestPath));
    requireThat(isWithin(root, manifestFile), "manifest must belong to the candidate checkout");
    manifest = JSON.parse(readBoundedFile(manifestFile, 1_048_576).toString("utf8"));
    requireThat(Array.isArray(manifest) && manifest.length > 0 && manifest.length <= 5000 &&
      manifest.every((entry, index) => record(entry) && entry.version === index + 1),
    "candidate migration manifest must be ordered and contiguous");
    const latest = manifest.at(-1);
    requireThat(latest.version === pin.migrationVersion && latest.checksum === pin.migrationChecksum &&
      latest.sha256 === pin.migrationChecksum,
    "pin must match the latest candidate migration version and checksum");
    requireThat(typeof latest.file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.sql$/.test(latest.file) &&
      path.basename(latest.file) === latest.file,
    "candidate migration must name a bounded SQL file");
    const directory = realpathSync(path.join(root, "supabase", "migrations"));
    requireThat(isWithin(root, directory), "migration directory must belong to the candidate checkout");
    const migrationFile = realpathSync(path.join(directory, latest.file));
    requireThat(isWithin(directory, migrationFile), "migration file must belong to the candidate checkout");
    migrationBytes = readBoundedFile(migrationFile, 4_194_304);
    const fileEntries = manifest.filter((entry) => entry.file === latest.file);
    requireThat(fileEntries.every((entry) => typeof entry.checksum === "string" &&
      CHECKSUM.test(entry.checksum) && entry.sha256 === latest.sha256),
    "candidate migration file must have consistent ledger digests");
    migrationChecksums = fileEntries.map((entry) => entry.checksum);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Forward-schema recovery: ")) throw error;
    reject("candidate migration evidence could not be read");
  }
  let migrationText;
  try {
    migrationText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(migrationBytes);
  } catch {
    reject("candidate migration must be valid UTF-8");
  }
  // Match sqlMigrationFileDigest: a SQL file cannot contain its own digest,
  // so normalize only this file's manifest-recorded ledger checksums.
  for (const checksum of migrationChecksums) migrationText = migrationText.replaceAll(checksum, "0".repeat(64));
  requireThat(createHash("sha256").update(migrationText, "utf8").digest("hex") === pin.migrationChecksum,
    "candidate migration bytes do not match the pinned checksum");
  return Object.freeze({ ...pin, unclassifiedTables: Object.freeze([...pin.unclassifiedTables]) });
}

/**
 * Admit only the old build's exact known table-classification gap. The original
 * report stays blocked and is never rewritten into a passing release report.
 * @param {unknown} artifact
 * @param {ForwardSchemaRecoveryPin} pin
 * @param {{baseUrl:string, previousRevision:string, now?:Date|number}} options
 * @returns {{priorExpectedTables:number}}
 */
export function validateForwardSchemaPriorArtifact(artifact, pin, { baseUrl, previousRevision, now = Date.now() }) {
  validatePin(pin);
  const time = currentTime(now);
  requireThat(record(artifact) && artifact.httpStatus === 200 && artifact.baseUrl === baseUrl &&
    typeof baseUrl === "string" && baseUrl.length > 0 && baseUrl.length <= 2048,
  "prior evidence must be a successful report from the pinned origin");
  requireThat(previousRevision === pin.previousRevision && record(artifact.deployment) &&
    artifact.deployment.commitSha === previousRevision,
  "prior evidence must identify the observed previous revision");
  const generated = freshInstant(artifact.generatedAt, time);
  const reported = freshInstant(artifact.reportCheckedAt, time);
  requireThat(reported <= generated, "prior report cannot postdate its artifact");
  requireThat(Array.isArray(artifact.gates) && artifact.gates.length >= CORE_GATES.length && artifact.gates.length <= 50,
    "prior evidence must contain its bounded core gates");
  const gates = new Map();
  for (const gate of artifact.gates) {
    requireThat(record(gate) && typeof gate.id === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(gate.id) &&
      !gates.has(gate.id), "prior evidence has an invalid or duplicate gate");
    requireThat(gate.status === (gate.id === "tenant_isolation_database" ? "fail" : "pass"),
      "only the prior database isolation gate may fail");
    gates.set(gate.id, gate);
  }
  requireThat(CORE_GATES.every((id) => gates.has(id)), "prior evidence is missing a required core gate");
  const absence = artifact.previousReleaseCompatibility;
  requireThat(gates.has("agent_error_budget") ? absence === undefined
    : exactKeys(absence, ["missingAgentErrorBudget"]) && absence.missingAgentErrorBudget === true,
  "budget absence requires the existing previous-release compatibility evidence");
  const isolation = gates.get("tenant_isolation_database");
  requireThat(boundedText(isolation.name, 200) && boundedText(isolation.summary, 2000),
    "prior isolation gate must have bounded explanatory evidence");
  const gate = artifact.releaseGate;
  requireThat(record(gate) && gate.approved === false && gate.status === "blocked" &&
    Array.isArray(gate.reasons) && gate.reasons.length === 1 &&
    gate.reasons[0] === `${isolation.name}: ${isolation.summary}` &&
    Array.isArray(gate.warnings) && gate.warnings.length === 0,
  "prior release must be blocked solely by the matched isolation reason");
  if (gate.summary !== undefined) {
    requireThat(exactKeys(gate.summary, ["total", "passed", "warnings", "failures"]) &&
      gate.summary.total === gates.size && gate.summary.passed === gates.size - 1 &&
      gate.summary.warnings === 0 && gate.summary.failures === 1,
    "prior release gate counts must agree with its exact gate list");
  }
  const summary = artifact.tenantIsolation;
  requireThat(artifact.tenantIsolationStatus === "degraded" && record(summary) &&
    positiveInteger(summary.expectedTables) && summary.protectedTables === summary.expectedTables &&
    summary.failingTables === 0 && nonnegativeInteger(summary.childTables) &&
    summary.childTables <= summary.expectedTables,
  "all prior classified tables must remain protected");
  requireThat(Array.isArray(summary.unclassifiedTables) &&
    sameStrings(summary.unclassifiedTables, pin.unclassifiedTables) &&
    EMPTY_ISOLATION_ARRAYS.every((field) => Array.isArray(summary[field]) && summary[field].length === 0),
  "prior isolation discrepancy must be exactly the pinned unclassified tables");
  return { priorExpectedTables: summary.expectedTables };
}

/**
 * Validate stdout only after the runner's fresh candidate db:verify exits zero.
 * npm banner text is allowed; repeated completion or failure evidence is not.
 * @param {unknown} stdout
 * @param {ForwardSchemaRecoveryPin} pin
 * @param {{priorExpectedTables:number, now?:Date|number}} options
 * @returns {{migrations:number, tenantTables:number, completedAt:string}}
 */
export function validateForwardSchemaDatabaseVerification(stdout, pin, { priorExpectedTables, now = Date.now() }) {
  validatePin(pin);
  requireThat(typeof stdout === "string" && Buffer.byteLength(stdout, "utf8") <= 262_144 &&
    positiveInteger(priorExpectedTables), "database verification output must be bounded");
  const time = currentTime(now);
  const completed = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      reject("database verification contains malformed JSON evidence");
    }
    requireThat(record(value) && value.level !== "error" && value.event !== "database_verification_failed",
      "database verification contains failure evidence");
    if (value.event === "database_verification_completed") completed.push(value);
  }
  requireThat(completed.length === 1, "database verification must report exactly one completion");
  const result = completed[0];
  requireThat(exactKeys(result, ["level", "event", "migrations", "tenantTables", "completedAt"]) &&
    result.level === "info" && result.migrations === pin.migrationVersion &&
    result.tenantTables === priorExpectedTables + pin.unclassifiedTables.length,
  "database verification must match the pinned migration and complete table count");
  freshInstant(result.completedAt, time);
  return { migrations: result.migrations, tenantTables: result.tenantTables, completedAt: result.completedAt };
}

function validatePin(pin) {
  requireThat(exactKeys(pin, PIN_KEYS) && typeof pin.previousRevision === "string" &&
    REVISION.test(pin.previousRevision) && typeof pin.candidateRevision === "string" &&
    REVISION.test(pin.candidateRevision) && pin.previousRevision !== pin.candidateRevision &&
    positiveInteger(pin.migrationVersion) && typeof pin.migrationChecksum === "string" &&
    CHECKSUM.test(pin.migrationChecksum), "pin has invalid identity fields");
  requireThat(Array.isArray(pin.unclassifiedTables) && pin.unclassifiedTables.length >= 1 &&
    pin.unclassifiedTables.length <= 4 && pin.unclassifiedTables.every((name, index, names) =>
      typeof name === "string" && TABLE.test(name) && (index === 0 || names[index - 1] < name)),
  "pin must name one to four sorted unique application tables");
}

function currentTime(now) {
  const time = now instanceof Date ? now.getTime() : now;
  requireThat(typeof time === "number" && Number.isFinite(time), "verification clock is invalid");
  return time;
}

function freshInstant(value, now) {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    "evidence requires a canonical UTC timestamp");
  const time = Date.parse(value);
  requireThat(Number.isFinite(time) && new Date(time).toISOString() === value &&
    time <= now && now - time <= MAX_AGE_MS, "evidence must be fresh within five minutes");
  return time;
}

function readBoundedFile(file, maximum) {
  const stat = statSync(file);
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= maximum, "candidate evidence file is invalid or oversized");
  const bytes = readFileSync(file);
  requireThat(bytes.length === stat.size && bytes.length <= maximum, "candidate evidence changed while being read");
  return bytes;
}

function isWithin(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function boundedText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function sameStrings(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function requireThat(condition, message) { if (!condition) reject(message); }
function reject(message) { throw new Error(`Forward-schema recovery: ${message}.`); }
