import type { RunTrajectory, TrajectoryVerification } from "@/lib/trajectories/types";

export type TrajectoryLearningEvaluation = {
  status: "pass" | "warn" | "fail";
  score: number;
  promotionEligible: boolean;
  checks: {
    integrity: boolean;
    completed: boolean;
    grounded: boolean;
    ownerAccepted: boolean | null;
    costKnown: boolean;
  };
  signals: string[];
};

/** Deterministic replay grade used before a trajectory can reinforce learning. */
export function evaluateTrajectoryLearning(
  trajectory: RunTrajectory,
  verification: TrajectoryVerification,
): TrajectoryLearningEvaluation {
  const groundingStatus = trajectory.learning.groundingStatus;
  const checks = {
    integrity: verification.valid,
    completed: trajectory.run.status === "completed",
    grounded: groundingStatus === "verified" || groundingStatus === "not_required",
    ownerAccepted: trajectory.learning.feedbackVerdict === undefined
      ? null
      : trajectory.learning.feedbackVerdict === "useful",
    costKnown: trajectory.usage.totalTokens === 0 || trajectory.usage.costKnown,
  };
  const scored = [checks.integrity, checks.completed, checks.grounded, checks.costKnown];
  if (checks.ownerAccepted !== null) scored.push(checks.ownerAccepted);
  const score = Math.round((scored.filter(Boolean).length / scored.length) * 1_000) / 1_000;
  const hardFailure = !checks.integrity || !checks.completed || checks.ownerAccepted === false;
  const promotionEligible = !hardFailure && checks.grounded && checks.ownerAccepted === true;
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
    promotionEligible,
    checks,
    signals,
  };
}
