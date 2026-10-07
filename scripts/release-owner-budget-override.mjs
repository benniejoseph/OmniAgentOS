import { selectedErrorBudgetProof } from "./release-error-budget-scope.mjs";

export const OWNER_BUDGET_OVERRIDE_ENV = "OMNIAGENT_RELEASE_OWNER_ERROR_BUDGET_OVERRIDE";
const VERDICTS = new Set(["insufficient", "within", "recovering", "exhausted"]);
const REVISION = /^[a-f0-9]{40}$/;
const REQUIRED_GATES = [
  "deployment_environment", "internal_smoke_auth", "openai_us_egress_gateway",
  "openai_provider", "cron_auth", "runtime_database_role", "maintenance_database_role",
  "dedicated_worker", "tenant_isolation_database", "latest_tenant_isolation_eval",
  "observability_slo", "agent_error_budget", "eval_report_signing",
];

// Deployment authorization only: never persisted as an application setting or
// used to grant a tool, tenant, actor, or provider permission.
/** @param {Record<string, string | undefined>} [env] */
export function readOwnerBudgetOverride(env = process.env, now = Date.now()) {
  const raw = env[OWNER_BUDGET_OVERRIDE_ENV]?.trim();
  if (!raw) return undefined;
  let pin;
  try { if (raw.length <= 2048) pin = JSON.parse(raw); } catch { /* Validated below. */ }
  if (!pin || typeof pin !== "object" || Array.isArray(pin) ||
    Object.keys(pin).sort().join() !== "candidateRevision,expiresAt,previousRevision,reason" ||
    !REVISION.test(pin.candidateRevision) || !REVISION.test(pin.previousRevision) ||
    pin.candidateRevision === pin.previousRevision ||
    typeof pin.reason !== "string" || !pin.reason.trim() || pin.reason !== pin.reason.trim() ||
    pin.reason.length > 200 || /[\u0000-\u001f\u007f]/.test(pin.reason) ||
    typeof pin.expiresAt !== "string" || !Number.isFinite(Date.parse(pin.expiresAt)) ||
    Date.parse(pin.expiresAt) <= now || Date.parse(pin.expiresAt) > now + 4 * 3_600_000 ||
    env.OMNIAGENT_RELEASE_ERROR_BUDGET_EXCEPTION?.trim()) {
    throw new Error(`${OWNER_BUDGET_OVERRIDE_ENV} requires distinct full candidate/previous revisions, a bounded reason, and expiry within four hours; do not combine exception modes.`);
  }
  return pin;
}

// Admit only one measured reliability failure, on the exact authorized release
// pair. Keep the server's blocked report intact in the evidence artifact.
export function ownerBudgetOverrideEvidence(report, pin, previousRelease = false, now = Date.now()) {
  if (!pin) return undefined;
  const expectedRevision = previousRelease ? pin.previousRevision : pin.candidateRevision;
  const gates = report?.gates;
  const gate = gates?.find((item) => item.id === "agent_error_budget");
  const proof = selectedErrorBudgetProof(gate);
  const objectives = proof.objectives;
  const checkedAt = Date.parse(report?.checkedAt);
  const release = report?.releaseGate;
  if (Date.parse(pin.expiresAt) <= now || report?.deployment?.commitSha !== expectedRevision ||
    !Number.isFinite(checkedAt) || checkedAt > now + 30_000 || checkedAt < now - 600_000 ||
    !Array.isArray(gates) || gates.length < REQUIRED_GATES.length || gates.length > 50 ||
    REQUIRED_GATES.some((id) => !gates.some((item) => item.id === id)) ||
    new Set(gates.map((item) => item.id)).size !== gates.length ||
    gates.some((item) => item.id !== "agent_error_budget" && item.status !== "pass") ||
    proof.measured !== true || proof.exception.applied !== null || proof.exception.reason !== null ||
    !Array.isArray(objectives) || objectives.length !== 2 ||
    objectives.find((item) => item.id === "agent_runs")?.objective !== 0.95 ||
    objectives.find((item) => item.id === "tool_calls")?.objective !== 0.9 ||
    objectives.some((item) => !VERDICTS.has(item.verdict)) ||
    !Array.isArray(release?.warnings) || release.warnings.length !== 0 ||
    !Array.isArray(release?.reasons) ||
    release.summary?.total !== gates.length || release.summary?.warnings !== 0) return undefined;
  const exhausted = objectives.some((item) => item.verdict === "exhausted");
  if (exhausted
    ? gate.status !== "fail" || release.approved !== false || release.status !== "blocked" ||
      release.reasons.length !== 1 || release.summary.failures !== 1 || release.summary.passed !== gates.length - 1
    : gate.status !== "pass" || release.approved !== true || release.status !== "passed" ||
      release.reasons.length !== 0 || release.summary.failures !== 0 || release.summary.passed !== gates.length) return undefined;
  return { ...pin, observedRevision: expectedRevision, applied: exhausted, proof };
}
