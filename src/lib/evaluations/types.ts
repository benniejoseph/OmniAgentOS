export type EvalCaseType = "system" | "retrieval" | "tool" | "workflow" | "security" | "operations";
export type EvalRunStatus = "running" | "completed" | "failed";
export type EvalResultStatus = "pass" | "fail" | "warn";
export type EvalSafetyMode = "read_only" | "synthetic" | "mutation_allowed";
export type EvalCleanupPolicy = "none" | "self_cleaning" | "audit_retained" | "manual_review";

export type EvalCaseGovernance = {
  safetyMode: EvalSafetyMode;
  riskLevel: 0 | 1 | 2 | 3;
  writesToDatabase: boolean;
  cleanup: EvalCleanupPolicy;
  production: {
    allowedByDefault: boolean;
    requiresAdmin: boolean;
    requiresMutationApproval: boolean;
  };
  notes: string[];
};

export type EvalCaseDefinition = {
  id: string;
  name: string;
  description: string;
  type: EvalCaseType;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  governance: EvalCaseGovernance;
};

export type EvalRunSummary = {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
};

export type EvalRunRecord = {
  id: string;
  suite: string;
  status: EvalRunStatus;
  summary: EvalRunSummary;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvalResultRecord = {
  id: string;
  evalRunId: string;
  caseId: string;
  caseName: string;
  caseType: EvalCaseType;
  status: EvalResultStatus;
  score: number;
  latencyMs: number;
  estimatedCostUsd: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
};

export type EvalRunDetail = {
  run: EvalRunRecord;
  results: EvalResultRecord[];
};

export type EvalReportSigningKeyStatus = "active" | "verify_only" | "fallback" | "local_development";
export type EvalReportSigningKeySource = "primary_env" | "rotation_env" | "cron_fallback" | "local_development";

export type EvalReportSigningKeyMetadata = {
  keyId: string;
  algorithm: "HMAC-SHA256";
  status: EvalReportSigningKeyStatus;
  source: EvalReportSigningKeySource;
  verifier: "omniagent-eval-report-v1";
  notBefore?: string;
  notAfter?: string;
};

export type EvalReportSignature = {
  algorithm: "HMAC-SHA256";
  keyId: string;
  digest: string;
  signature: string;
  canonicalHash: string;
  signedAt: string;
  verifier: "omniagent-eval-report-v1";
  keyStatus?: EvalReportSigningKeyStatus;
  keySource?: EvalReportSigningKeySource;
  keyNotBefore?: string;
  keyNotAfter?: string;
};

export type EvalReportReleaseGate = {
  approved: boolean;
  status: "passed" | "blocked";
  checks: {
    completedRun: boolean;
    nonEmptySuite: boolean;
    noFailedCases: boolean;
    activeSigningKey: boolean;
    productionSigningKey: boolean;
  };
  warnings: string[];
  reasons: string[];
};

export type EvalReportSnapshot = {
  id: string;
  evalRunId: string;
  format: "json_audit_bundle";
  reportVersion: "2026-06-07";
  report: Record<string, unknown>;
  signature: EvalReportSignature;
  tenantId?: string;
  createdBy?: string;
  createdAt: string;
};

export type EvalReportVerificationResult = {
  valid: boolean;
  releaseGate?: EvalReportReleaseGate;
  reportId?: string;
  evalRunId?: string;
  reportVersion?: string;
  algorithm?: string;
  verifier?: string;
  keyId?: string;
  matchedKeyId?: string;
  keyStatus?: EvalReportSigningKeyStatus;
  digestValid: boolean;
  signatureValid: boolean;
  canonicalHash?: string;
  expectedDigest?: string;
  actualDigest?: string;
  signedAt?: string;
  verifiedAt: string;
  errors: string[];
};

export type EvalLedger = {
  runs: EvalRunRecord[];
  results: EvalResultRecord[];
  reports?: EvalReportSnapshot[];
};

export type EvalStats = {
  total: number;
  byStatus: Record<string, number>;
  latest?: EvalRunRecord;
  latestPassRate: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
};
