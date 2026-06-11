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

export async function getTrustProfile(
  actionClass: string,
  options: { tenantId: string },
): Promise<TrustProfile | undefined> {
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
  const ledger = await readLedger();
  return ledger.profiles
    .filter((profile) => profile.tenantId === options.tenantId)
    .sort((left, right) => right.cleanStreak - left.cleanStreak);
}

async function readLedger() {
  return readJsonFile<TrustLedger>(getLedgerFile(), { profiles: [] });
}

function getLedgerFile() {
  return getDataPath("trust.json");
}
