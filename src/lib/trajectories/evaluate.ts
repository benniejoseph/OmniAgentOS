import type { RunTrajectory, TrajectoryVerification } from "@/lib/trajectories/types";

export type TrajectoryOutcomeEvaluation = {
  status: "pass" | "warn" | "fail";
  score: number;
  retentionEligible: boolean;
  checks: {
    integrity: boolean;
    completed: boolean;
    grounded: boolean;
    ownerAccepted: boolean | null;
    costKnown: boolean;
  };
  signals: string[];
};

/** Deterministic outcome grade. It can qualify evidence for retention but never activates an Agent adaptation. */
export function evaluateTrajectoryOutcome(
  trajectory: RunTrajectory,
  verification: TrajectoryVerification,
): TrajectoryOutcomeEvaluation {
  const groundingStatus = trajectory.outcomeEvidence.groundingStatus;
  const checks = {
    integrity: verification.valid,
    completed: trajectory.run.status === "completed",
    grounded: groundingStatus === "verified" || groundingStatus === "not_required",
    ownerAccepted: trajectory.outcomeEvidence.feedbackVerdict === undefined
      ? null
      : trajectory.outcomeEvidence.feedbackVerdict === "useful",
    costKnown: trajectory.usage.totalTokens === 0 || trajectory.usage.costKnown,
  };
  const scored = [checks.integrity, checks.completed, checks.grounded, checks.costKnown];
  if (checks.ownerAccepted !== null) scored.push(checks.ownerAccepted);
  const score = Math.round((scored.filter(Boolean).length / scored.length) * 1_000) / 1_000;
  const hardFailure = !checks.integrity || !checks.completed || checks.ownerAccepted === false;
  const retentionEligible = !hardFailure && checks.grounded && checks.ownerAccepted === true;
  const signals = [
    !checks.integrity ? "Trajectory integrity verification failed." : "",
    !checks.completed ? `Run ended as ${trajectory.run.status}.` : "",
    !checks.grounded
      ? groundingStatus === undefined
        ? "Grounding evidence is absent."
        : `Grounding ended as ${groundingStatus}.`
      : "",
    checks.ownerAccepted === false ? "The owner marked this outcome as needing work." : "",
    checks.ownerAccepted === null ? "The owner has not graded this outcome yet." : "",
    !checks.costKnown ? "Provider pricing is not configured; cost is unknown." : "",
  ].filter(Boolean);
  return {
    status: hardFailure ? "fail" : signals.length ? "warn" : "pass",
    score,
    retentionEligible,
    checks,
    signals,
  };
}
