import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendDomainEventSafely } from "@/lib/events/store";
import { computeAutonomy } from "@/lib/trust/policy";
import type { ActionOutcome, AutonomyDecision, TrustLedger, TrustProfile } from "@/lib/trust/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

/**
 * Action class identifies the unit that earns trust. Today it is the tool id;
 * keeping it a separate concept lets us later key on (tool, target, operation).
 */
export function actionClassFor(toolId: string) {
  return toolId;
}

function emptyProfile(input: {
  actionClass: string;
  toolId: string;
  tenantId: string;
  riskLevel: number;
  reversible: boolean;
}): TrustProfile {
  return {
    actionClass: input.actionClass,
    toolId: input.toolId,
    tenantId: input.tenantId,
    riskLevel: input.riskLevel,
    reversible: input.reversible,
    total: 0,
    successes: 0,
    failures: 0,
    rejections: 0,
    humanApprovals: 0,
    cleanStreak: 0,
    autonomyMode: "approve_each",
    updatedAt: new Date().toISOString(),
  };
}

export function applyOutcome(profile: TrustProfile, outcome: ActionOutcome): TrustProfile {
  const next: TrustProfile = {
    ...profile,
    riskLevel: outcome.riskLevel,
    reversible: outcome.reversible,
    total: profile.total + 1,
    lastOutcomeAt: outcome.at,
    updatedAt: outcome.at,
  };

  if (outcome.kind === "success") {
    next.successes += 1;
    next.cleanStreak += 1;
    if (outcome.humanApproved) {
      next.humanApprovals += 1;
    }
  } else if (outcome.kind === "failure") {
    next.failures += 1;
    next.cleanStreak = 0;
    next.lastFailureAt = outcome.at;
  } else {
    next.rejections += 1;
    next.cleanStreak = 0;
  }

  next.autonomyMode = computeAutonomy(next).mode;
  return next;
}

export async function recordActionOutcome(
  input: Omit<ActionOutcome, "at"> & { at?: string },
): Promise<TrustProfile> {
  const outcome: ActionOutcome = { ...input, at: input.at || new Date().toISOString() };

  // The outcome is also a domain event; the profile is its projection.
  await appendDomainEventSafely({
    streamId: `trust:${outcome.actionClass}`,
    type: `trust.outcome.${outcome.kind}`,
    tenantId: outcome.tenantId,
    actorId: "system",
    payload: {
      toolId: outcome.toolId,
      reversible: outcome.reversible,
      riskLevel: outcome.riskLevel,
      humanApproved: outcome.humanApproved,
    },
  });

  if (hasDatabaseUrl()) {
    return recordActionOutcomeDb(outcome);
  }

  let saved: TrustProfile | undefined;
  await updateJsonFile<TrustLedger>(getLedgerFile(), { profiles: [] }, (ledger) => {
    const index = ledger.profiles.findIndex(
      (profile) => profile.actionClass === outcome.actionClass && profile.tenantId === outcome.tenantId,
    );
    const existing =
      index >= 0
        ? ledger.profiles[index]
        : emptyProfile({
            actionClass: outcome.actionClass,
            toolId: outcome.toolId,
            tenantId: outcome.tenantId,
            riskLevel: outcome.riskLevel,
            reversible: outcome.reversible,
          });
    const updated = applyOutcome(existing, outcome);
    saved = updated;
    if (index >= 0) {
      ledger.profiles[index] = updated;
    } else {
      ledger.profiles.push(updated);
    }
    return ledger;
  });

  return saved as TrustProfile;
}

async function recordActionOutcomeDb(outcome: ActionOutcome): Promise<TrustProfile> {
  await ensureDatabaseSchema();
  const isSuccess = outcome.kind === "success";
  const isFailure = outcome.kind === "failure";
  const isRejection = outcome.kind === "rejected";
  // Single atomic upsert: counters and streak are computed in SQL so
  // concurrent executions cannot lose updates.
  const rows = await getSql()`
    INSERT INTO omni_trust_profiles (
      tenant_id, action_class, tool_id, risk_level, reversible,
      total, successes, failures, rejections, human_approvals, clean_streak,
      last_outcome_at, last_failure_at, updated_at
    )
    VALUES (
      ${outcome.tenantId}, ${outcome.actionClass}, ${outcome.toolId}, ${outcome.riskLevel}, ${outcome.reversible},
      1, ${isSuccess ? 1 : 0}, ${isFailure ? 1 : 0}, ${isRejection ? 1 : 0},
      ${isSuccess && outcome.humanApproved ? 1 : 0}, ${isSuccess ? 1 : 0},
      ${outcome.at}, ${isFailure ? outcome.at : null}, ${outcome.at}
    )
    ON CONFLICT (tenant_id, action_class) DO UPDATE SET
      tool_id = EXCLUDED.tool_id,
      risk_level = EXCLUDED.risk_level,
      reversible = EXCLUDED.reversible,
      total = omni_trust_profiles.total + 1,
      successes = omni_trust_profiles.successes + ${isSuccess ? 1 : 0},
      failures = omni_trust_profiles.failures + ${isFailure ? 1 : 0},
      rejections = omni_trust_profiles.rejections + ${isRejection ? 1 : 0},
      human_approvals = omni_trust_profiles.human_approvals + ${isSuccess && outcome.humanApproved ? 1 : 0},
      clean_streak = CASE WHEN ${isSuccess} THEN omni_trust_profiles.clean_streak + 1 ELSE 0 END,
      last_outcome_at = ${outcome.at},
      last_failure_at = CASE WHEN ${isFailure} THEN ${outcome.at}::timestamptz ELSE omni_trust_profiles.last_failure_at END,
      updated_at = ${outcome.at}
    RETURNING *
  `;
  return profileFromRow(rows[0]);
}

export async function getTrustProfile(
  actionClass: string,
  options: { tenantId: string },
): Promise<TrustProfile | undefined> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_trust_profiles
      WHERE tenant_id = ${options.tenantId} AND action_class = ${actionClass}
      LIMIT 1
    `;
    return rows[0] ? profileFromRow(rows[0]) : undefined;
  }

  const ledger = await readLedger();
  return ledger.profiles.find(
    (profile) => profile.actionClass === actionClass && profile.tenantId === options.tenantId,
  );
}

export async function resolveAutonomy(
  input: { toolId: string; tenantId: string; riskLevel: number; reversible: boolean },
): Promise<AutonomyDecision> {
  const profile = await getTrustProfile(actionClassFor(input.toolId), { tenantId: input.tenantId });
  return computeAutonomy(
    profile ?? { cleanStreak: 0, reversible: input.reversible, riskLevel: input.riskLevel },
  );
}

export async function listTrustProfiles(options: { tenantId: string }): Promise<TrustProfile[]> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_trust_profiles
      WHERE tenant_id = ${options.tenantId}
      ORDER BY clean_streak DESC
      LIMIT 200
    `;
    return rows.map(profileFromRow);
  }

  const ledger = await readLedger();
  return ledger.profiles
    .filter((profile) => profile.tenantId === options.tenantId)
    .sort((left, right) => right.cleanStreak - left.cleanStreak);
}

function profileFromRow(row: Record<string, unknown>): TrustProfile {
  const partial = {
    actionClass: String(row.action_class),
    toolId: String(row.tool_id),
    tenantId: String(row.tenant_id),
    riskLevel: Number(row.risk_level || 0),
    reversible: Boolean(row.reversible),
    total: Number(row.total || 0),
    successes: Number(row.successes || 0),
    failures: Number(row.failures || 0),
    rejections: Number(row.rejections || 0),
    humanApprovals: Number(row.human_approvals || 0),
    cleanStreak: Number(row.clean_streak || 0),
    lastOutcomeAt: row.last_outcome_at ? normalizeDate(row.last_outcome_at) : undefined,
    lastFailureAt: row.last_failure_at ? normalizeDate(row.last_failure_at) : undefined,
    updatedAt: normalizeDate(row.updated_at),
  };
  // Autonomy mode is derived, never stored: policy changes (e.g. a new
  // threshold) apply immediately to every profile.
  return { ...partial, autonomyMode: computeAutonomy(partial).mode };
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function readLedger() {
  return readJsonFile<TrustLedger>(getLedgerFile(), { profiles: [] });
}

function getLedgerFile() {
  return getDataPath("trust.json");
}
