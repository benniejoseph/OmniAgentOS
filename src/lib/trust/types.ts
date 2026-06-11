/**
 * Earned autonomy. An action class accrues trust through track record; trust
 * (plus reversibility and risk tier) decides whether an action gates for human
 * approval or flows automatically with alerting.
 */

export type AutonomyMode = "approve_each" | "auto_with_alert";

export type ActionOutcomeKind = "success" | "failure" | "rejected";

export type ActionOutcome = {
  actionClass: string;
  toolId: string;
  tenantId: string;
  kind: ActionOutcomeKind;
  reversible: boolean;
  riskLevel: number;
  humanApproved: boolean;
  at: string;
};

export type TrustProfile = {
  actionClass: string;
  toolId: string;
  tenantId: string;
  riskLevel: number;
  reversible: boolean;
  total: number;
  successes: number;
  failures: number;
  rejections: number;
  humanApprovals: number;
  /** Consecutive successes since the last failure or rejection. Resets to 0 on either. */
  cleanStreak: number;
  autonomyMode: AutonomyMode;
  lastOutcomeAt?: string;
  lastFailureAt?: string;
  updatedAt: string;
};

export type TrustLedger = {
  profiles: TrustProfile[];
};

export type AutonomyDecision = {
  mode: AutonomyMode;
  reason: string;
  cleanStreak: number;
  threshold: number;
  /** 0..1 progress toward graduation, for UI. 1 when already graduated. */
  progress: number;
  eligible: boolean;
};
