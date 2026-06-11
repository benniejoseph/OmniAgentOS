import type { AutonomyDecision, TrustProfile } from "@/lib/trust/types";

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
 * record; any failure or rejection resets the clean streak to zero.
 */
export function computeAutonomy(
  profile: Pick<TrustProfile, "cleanStreak" | "reversible" | "riskLevel">,
): AutonomyDecision {
  const threshold = graduationThreshold();
  const base = {
    cleanStreak: profile.cleanStreak,
    threshold,
  };

  if (profile.riskLevel >= 3) {
    return {
      ...base,
      mode: "approve_each",
      eligible: false,
      progress: 0,
      reason: "Risk 3 actions require a two-admin quorum and never graduate to autonomy.",
    };
  }

  if (!profile.reversible) {
    return {
      ...base,
      mode: "approve_each",
      eligible: false,
      progress: 0,
      reason: "Irreversible actions always require human approval, regardless of track record.",
    };
  }

  if (profile.cleanStreak >= threshold) {
    return {
      ...base,
      mode: "auto_with_alert",
      eligible: true,
      progress: 1,
      reason: `Earned autonomy: ${profile.cleanStreak} consecutive clean executions (threshold ${threshold}). Runs automatically with alerting.`,
    };
  }

  return {
    ...base,
    mode: "approve_each",
    eligible: true,
    progress: Math.min(profile.cleanStreak / threshold, 0.999),
    reason: `Building trust: ${profile.cleanStreak}/${threshold} clean executions toward autonomy.`,
  };
}
