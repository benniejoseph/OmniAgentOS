import type { AutonomyDecision, TrustProfile } from "@/lib/trust/types";

type TrustEvidence = Pick<TrustProfile, "cleanStreak" | "reversible" | "riskLevel"> &
  Partial<
    Pick<
      TrustProfile,
      | "total"
      | "successes"
      | "failures"
      | "rejections"
      | "lastOutcomeAt"
      | "lastFailureAt"
    >
  >;

export function graduationThreshold() {
  const parsed = Number(process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 25;
}

export function isGraduatedAutonomyEnabled() {
  return process.env.OMNIAGENT_GRADUATED_AUTONOMY === "true";
}

/**
 * Decide whether an action class has earned autonomy. Conservative by design:
 * irreversible actions and risk-3 tools never graduate regardless of track
 * record. Failures are weighted more heavily than successes, stale evidence
 * decays, and every automatic action remains inside a rate budget.
 */
export function computeAutonomy(
  profile: TrustEvidence,
  now = new Date(),
): AutonomyDecision {
  const threshold = graduationThreshold();
  const total = Math.max(0, profile.total ?? profile.cleanStreak);
  const successes = Math.max(0, profile.successes ?? profile.cleanStreak);
  const failures = Math.max(0, profile.failures ?? 0);
  const rejections = Math.max(0, profile.rejections ?? 0);
  const freshness = evidenceFreshness(profile.lastOutcomeAt, now);
  const effectiveSampleSize = round(total * freshness);
  const weightedFailures = failures * 3 + rejections * 2;
  const score = round(wilsonLowerBound(successes, successes + weightedFailures));
  const confidence = round((1 - Math.exp(-effectiveSampleSize / 10)) * freshness);
  const budget = autonomyBudget(profile.riskLevel);
  const base = {
    cleanStreak: profile.cleanStreak,
    threshold,
    score,
    confidence,
    effectiveSampleSize,
    freshness,
    budget,
  };

  if (profile.riskLevel >= 3) {
    return {
      ...base,
      mode: "approve_each",
      stage: "manual",
      eligible: false,
      progress: 0,
      reason: "Risk 3 actions require a two-admin quorum and never graduate to autonomy.",
    };
  }

  if (!profile.reversible) {
    return {
      ...base,
      mode: "approve_each",
      stage: "manual",
      eligible: false,
      progress: 0,
      reason: "Irreversible actions always require human approval, regardless of track record.",
    };
  }

  const recentFailure = hasUnresolvedRecentFailure(profile, now);
  const autonomous =
    profile.cleanStreak >= threshold &&
    effectiveSampleSize >= threshold &&
    score >= 0.6 &&
    freshness >= 0.5 &&
    !recentFailure;

  if (autonomous) {
    return {
      ...base,
      mode: "auto_with_alert",
      stage: "autonomous",
      eligible: true,
      progress: 1,
      reason: `Earned autonomy: ${profile.cleanStreak} clean executions, reliability ${formatPercent(score)}, confidence ${formatPercent(confidence)}. Runs automatically with alerting inside a ${budget.maxActions}-action hourly budget.`,
    };
  }

  const supervised =
    profile.cleanStreak >= Math.max(3, Math.ceil(threshold * 0.4)) &&
    effectiveSampleSize >= Math.max(3, Math.ceil(threshold * 0.4)) &&
    score >= 0.5 &&
    !recentFailure;

  const progress = Math.min(
    profile.cleanStreak / threshold,
    effectiveSampleSize / threshold,
    score / 0.6,
    freshness / 0.5,
    0.999,
  );

  return {
    ...base,
    mode: "approve_each",
    stage: supervised ? "supervised" : "shadow",
    eligible: true,
    progress: Math.max(0, progress),
    reason: recentFailure
      ? "Autonomy was demoted after a recent failure. Asael will observe clean outcomes before restoring supervised operation."
      : freshness < 0.5
        ? "Trust evidence is stale. Asael requires fresh supervised outcomes before autonomous execution resumes."
        : `${supervised ? "Supervised" : "Shadow"} learning: ${profile.cleanStreak}/${threshold} clean executions, reliability ${formatPercent(score)}.`,
  };
}

function autonomyBudget(riskLevel: number) {
  return {
    windowSeconds: 60 * 60,
    maxActions: riskLevel >= 2 ? 3 : riskLevel === 1 ? 8 : 20,
  };
}

function evidenceFreshness(lastOutcomeAt: string | undefined, now: Date) {
  if (!lastOutcomeAt) return 1;
  const time = Date.parse(lastOutcomeAt);
  if (!Number.isFinite(time)) return 0;
  const ageDays = Math.max(0, now.getTime() - time) / 86_400_000;
  return round(Math.exp(-ageDays / 60));
}

function isRecent(value: string | undefined, now: Date, days: number) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && now.getTime() - time <= days * 86_400_000;
}

function hasUnresolvedRecentFailure(profile: TrustEvidence, now: Date) {
  if (!isRecent(profile.lastFailureAt, now, 30)) return false;
  const failureAt = Date.parse(profile.lastFailureAt || "");
  const outcomeAt = Date.parse(profile.lastOutcomeAt || "");
  return !Number.isFinite(outcomeAt) || failureAt >= outcomeAt;
}

function wilsonLowerBound(successes: number, total: number) {
  if (total <= 0) return 0;
  const z = 1.2815515655446004; // 80% two-sided interval; conservative without freezing learning.
  const probability = Math.min(Math.max(successes / total, 0), 1);
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = probability + zSquared / (2 * total);
  const margin = z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
