export const OWNER_LIVE_AUTHORIZATION_ENV = "OMNIAGENT_RELEASE_OWNER_LIVE_AUTHORIZATION";
export const OWNER_LIVE_VERIFICATION_MODE = "owner-authorized-live";
export const OWNER_LIVE_LOCAL_COMMANDS = Object.freeze(["typecheck", "build"]);
export const OWNER_LIVE_DEFERRED_COMMANDS = Object.freeze([
  "verify",
  "test:production-smoke",
  "smoke:security",
  "smoke:tenant",
  "smoke:eval",
  "benchmark:preview",
  "benchmark:dashboard",
]);

const REVISION = /^[a-f0-9]{40}$/;
const MAX_LIFETIME_MS = 4 * 3_600_000;

/**
 * An operator-supplied authorization for one release pair. It is not an app
 * permission or a claim that CI passed. The runner never forwards this env var.
 */
export function readOwnerLiveAuthorization(env = process.env, now = Date.now()) {
  const raw = env[OWNER_LIVE_AUTHORIZATION_ENV]?.trim();
  if (!raw) return undefined;
  let pin;
  try { if (raw.length <= 2048) pin = JSON.parse(raw); } catch { /* Validated below. */ }
  const problem = ownerLiveAuthorizationProblem(pin, now);
  if (problem) throw new Error(`${OWNER_LIVE_AUTHORIZATION_ENV} ${problem}.`);
  return Object.freeze({ ...pin });
}

/** Recheck expiry at every admission boundary, and bind both actual revisions. */
export function assertOwnerLiveAuthorization(pin, {
  candidateRevision,
  previousRevision,
  now = Date.now(),
}) {
  const problem = ownerLiveAuthorizationProblem(pin, now);
  if (problem) throw new Error(`Owner live authorization ${problem}.`);
  if (pin.candidateRevision !== candidateRevision ||
    (previousRevision !== undefined && pin.previousRevision !== previousRevision)) {
    throw new Error("Owner live authorization does not match the exact candidate and previous release pair.");
  }
}

/**
 * The manifest verifier supplies its signedAt time here. Expiry limits release
 * admission, not later inspection of a signed historical release or rollback.
 */
export function ownerLiveAuthorizationProblem(pin, now = Date.now()) {
  if (!pin || typeof pin !== "object" || Array.isArray(pin) ||
    Object.keys(pin).sort().join() !== "candidateRevision,expiresAt,previousRevision,reason" ||
    !REVISION.test(pin.candidateRevision) || !REVISION.test(pin.previousRevision) ||
    pin.candidateRevision === pin.previousRevision ||
    typeof pin.reason !== "string" || !pin.reason.trim() || pin.reason !== pin.reason.trim() ||
    pin.reason.length > 200 || /[\u0000-\u001f\u007f]/.test(pin.reason) ||
    typeof pin.expiresAt !== "string" || !Number.isFinite(Date.parse(pin.expiresAt)) ||
    new Date(Date.parse(pin.expiresAt)).toISOString() !== pin.expiresAt ||
    !Number.isFinite(now) || Date.parse(pin.expiresAt) <= now ||
    Date.parse(pin.expiresAt) > now + MAX_LIFETIME_MS) {
    return "requires distinct full candidate/previous revisions, a bounded reason, and canonical UTC expiry within four hours";
  }
  return undefined;
}
