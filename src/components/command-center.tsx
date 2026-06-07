"use client";

import {
  Activity,
  BarChart3,
  BookOpen,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  Download,
  FileText,
  GitBranch,
  Globe2,
  HardDrive,
  History,
  Layers3,
  LogIn,
  LogOut,
  Pencil,
  Play,
  Power,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";

type Role = "user" | "assistant";
type Mode = "orchestrate" | "research" | "execute" | "learn";

type Message = {
  role: Role;
  content: string;
};

type Capability = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
};

type RiskLevel = 0 | 1 | 2 | 3;
type ToolExecutionStatus = "dry_run" | "executed" | "approval_required" | "blocked" | "failed" | "rejected";

type GovernedTool = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
  riskLevel: RiskLevel;
  dryRunSupported: boolean;
  approvalRequired: boolean;
};

type ToolExecutionRecord = {
  id: string;
  tenantId?: string;
  actorId?: string;
  toolId: string;
  toolName: string;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  dryRun: boolean;
  approvalRequired: boolean;
  input: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  approvalDecision?: "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
  approvalReason?: string;
  createdAt: string;
  completedAt?: string;
};

type ToolAuditSummary = {
  total: number;
  byStatus: Record<string, number>;
  byRisk: Record<string, number>;
  latest: ToolExecutionRecord[];
};

type ToolsResponse = {
  tools: GovernedTool[];
  audits: ToolAuditSummary;
  policy: {
    riskLevels: {
      level: RiskLevel;
      label: string;
      approvalRequired: boolean;
    }[];
    defaultBehavior: string;
  };
};

type McpConnectorRecord = {
  id: string;
  name: string;
  endpoint: string;
  transport: "streamable_http";
  authType: "none" | "bearer_env";
  authTokenEnv?: string;
  status: "active" | "error" | "disabled";
  defaultRiskLevel: RiskLevel;
  approvalRequired: boolean;
  toolCount: number;
  lastDiscoveredAt?: string;
  lastError?: string;
  updatedAt: string;
};

type McpToolRecord = {
  id: string;
  connectorId: string;
  connectorName: string;
  name: string;
  title?: string;
  description?: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  status: "active" | "disabled";
  updatedAt: string;
};

type ConnectorStats = {
  total: number;
  active: number;
  error: number;
  toolCount: number;
  latest: McpConnectorRecord[];
};

type ConnectorsResponse = {
  connectors: McpConnectorRecord[];
  tools: McpToolRecord[];
  stats: ConnectorStats;
};

type OpenApiConnectorRecord = {
  id: string;
  name: string;
  specUrl?: string;
  baseUrl: string;
  authType: "none" | "bearer_env" | "api_key_header_env";
  authTokenEnv?: string;
  authHeaderName?: string;
  status: "active" | "error" | "disabled";
  defaultRiskLevel: RiskLevel;
  approvalRequired: boolean;
  operationCount: number;
  lastImportedAt?: string;
  lastError?: string;
  updatedAt: string;
};

type OpenApiOperationRecord = {
  id: string;
  connectorId: string;
  connectorName: string;
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  status: "active" | "disabled";
  updatedAt: string;
};

type OpenApiConnectorStats = {
  total: number;
  active: number;
  error: number;
  operationCount: number;
  latest: OpenApiConnectorRecord[];
};

type OpenApiConnectorsResponse = {
  connectors: OpenApiConnectorRecord[];
  operations: OpenApiOperationRecord[];
  stats: OpenApiConnectorStats;
};

type ApprovalQueueItem =
  | {
      kind: "tool";
      id: string;
      title: string;
      status: "approval_required";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: ToolExecutionRecord;
    }
  | {
      kind: "workflow";
      id: string;
      title: string;
      status: "waiting_approval";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: WorkflowRunRecord;
    }
  | {
      kind: "slo_policy";
      id: string;
      title: string;
      status: "pending";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: ObservabilitySloPolicyChange;
    };

type ApprovalQueueResponse = {
  items: ApprovalQueueItem[];
  stats: {
    total: number;
    tools: number;
    workflows: number;
    sloPolicies?: number;
  };
};

type OperationsResponse = {
  approvals: ApprovalQueueResponse;
  summary: {
    pendingApprovals: number;
    activeWorkflows: number;
    failedWorkflows: number;
    historicalFailedWorkflows?: number;
    liveWorkflowRisks?: number;
    recentUnhandledWorkflowFailures?: number;
    recoveredWorkflowFailures?: number;
    failedTools: number;
    connectorErrors: number;
    runningRuns: number;
    queuedJobs: number;
    runningJobs: number;
    failedJobs: number;
    runnableJobs: number;
    expiredLeases: number;
    staleWorkflows?: number;
    recoverableWorkflows?: number;
  };
  recovery?: OperationsRecoveryReport;
  latest: {
    workflows: WorkflowRunRecord[];
    toolExecutions: ToolExecutionRecord[];
    agentRuns: AgentRun[];
    operationJobs: OperationJobRecord[];
    recoveryEvents: WorkflowRecoveryEventRecord[];
    connectors: Array<{
      id: string;
      name: string;
      status: string;
      updatedAt: string;
    }>;
  };
};

type OperationsRecoveryReport = {
  mode: "inspect" | "repair" | "drain";
  inspectedAt: string;
  staleWorkflowMs: number;
  failAfterMs: number;
  limit: number;
  expiredLeasesRepaired: number;
  staleWorkflows: Array<{
    workflowRunId: string;
    status: WorkflowRunStatus;
    currentStep?: string;
    attempt: number;
    maxAttempts: number;
    staleMs: number;
    ageMs: number;
    disposition: "inspect" | "requeued" | "failed" | "skipped";
    reason: string;
    jobIds: string[];
  }>;
  requeuedWorkflows: number;
  failedWorkflows: number;
  skippedWorkflows: number;
  runnableJobsBefore: number;
  runnableJobsAfter: number;
  expiredLeasesBefore: number;
  expiredLeasesAfter: number;
  drain?: {
    requested: number;
    leased: number;
    completed: number;
    failed: number;
    requeued: number;
  };
};

type ConnectionCatalogItem = {
  id: string;
  name: string;
  category: "code" | "communication" | "knowledge" | "data" | "automation" | "browser";
  adapter: "mcp" | "openapi" | "native";
  status: "ready" | "requires_credentials" | "planned";
  baseUrl?: string;
  endpoint?: string;
  authEnvVars: string[];
  authHeaderName?: string;
  capabilities: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
};

type ConnectionCatalogResponse = {
  connectors: ConnectionCatalogItem[];
  stats: {
    total: number;
    mcp: number;
    openapi: number;
    planned: number;
  };
};

type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

type WorkflowRunRecord = {
  id: string;
  workflowType: string;
  status: WorkflowRunStatus;
  goal: string;
  currentStep?: string;
  attempt: number;
  maxAttempts: number;
  approvalRequired: boolean;
  approvedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type WorkflowRecoveryEventRecord = {
  id: string;
  workflowRunId: string;
  type: "workflow.recovery.requeued" | "workflow.recovery.failed";
  disposition: "requeued" | "failed";
  payload: {
    actorId?: string;
    staleMs?: number;
    ageMs?: number;
    reason?: string;
    previousStatus?: WorkflowRunStatus;
    jobIds?: string[];
    canceledJobIds?: string[];
  };
  workflow: {
    id: string;
    goal: string;
    status: WorkflowRunStatus;
    currentStep?: string;
    attempt: number;
    maxAttempts: number;
    error?: string;
  };
  createdAt: string;
};

type WorkflowStepRecord = {
  id: string;
  workflowRunId: string;
  stepKey: string;
  label: string;
  status: WorkflowStepStatus;
  attempt: number;
  maxAttempts: number;
  error?: string;
  updatedAt: string;
};

type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  steps: WorkflowStepRecord[];
};

type WorkflowStats = {
  total: number;
  byStatus: Record<string, number>;
  active: number;
  waitingApproval: number;
  latest: WorkflowRunRecord[];
};

type WorkflowPlanStats = {
  total: number;
  byStatus: Record<string, number>;
  approvalRequired: number;
  highRisk: number;
  averageConfidence: number;
  latest: Array<{
    id: string;
    status: "planned" | "failed";
    planner: "openai" | "deterministic";
    goal: string;
    confidence: number;
    highestRiskLevel: number;
    approvalRequired: boolean;
    createdAt: string;
  }>;
};

type WorkflowPlanExecutionStats = {
  total: number;
  byStatus: Record<string, number>;
  approvalRequired: number;
  blocked: number;
  failed: number;
  dryRunTools: number;
  executedTools: number;
  latest: Array<{
    id: string;
    workflowRunId: string;
    planId: string;
    nodeId: string;
    nodeLabel: string;
    status: string;
    policy: string;
    riskLevel: number;
    approvalRequired: boolean;
    updatedAt: string;
  }>;
};

type WorkflowTriggerStats = {
  total: number;
  active: number;
  byStatus: Record<string, number>;
  events: number;
  acceptedEvents: number;
  rejectedEvents: number;
  enqueuedEvents: number;
  failedEvents: number;
  latestTriggers: Array<{
    id: string;
    name: string;
    source: string;
    status: "active" | "paused";
    authMode: "none" | "hmac_sha256";
    workflowMode: string;
    requireApproval: boolean;
    triggerCount: number;
    failureCount: number;
    updatedAt: string;
  }>;
  latestEvents: Array<{
    id: string;
    triggerId: string;
    status: "accepted" | "rejected" | "enqueued" | "failed";
    source: string;
    eventType?: string;
    signatureVerified: boolean;
    workflowRunId?: string;
    receivedAt: string;
  }>;
};

type OperationJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

type OperationJobRecord = {
  id: string;
  type: "workflow.tick";
  status: OperationJobStatus;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  lockedAt?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  updatedAt: string;
};

type OperationJobStats = {
  total: number;
  byStatus: Record<string, number>;
  runnable: number;
  delayed: number;
  expiredLeases: number;
  latest: OperationJobRecord[];
};

type HealthStatus = "healthy" | "degraded" | "unhealthy";

type HealthStats = {
  total: number;
  byStatus: Record<string, number>;
  latestStatus: HealthStatus;
  incidents: number;
  recoveryActions: number;
  latest?: {
    id: string;
    status: HealthStatus;
    scope: "health" | "diagnostics" | "repair";
    latencyMs: number;
    createdAt: string;
  };
};

type IncidentSeverity = "info" | "warning" | "critical";
type IncidentStatus = "open" | "acknowledged" | "resolved";

type IncidentAlertTarget = {
  id: string;
  name: string;
  channel: "dashboard" | "ops" | "webhook" | "email" | "slack";
  status: "ready" | "requires_config";
  targetEnv?: string;
  description: string;
};

type IncidentPlaybook = {
  id: string;
  name: string;
  description: string;
  componentIds: string[];
  automation: "diagnostics_repair" | "health_recheck" | "manual";
  autoRunnable: boolean;
  riskLevel: RiskLevel;
};

type IncidentRecord = {
  id: string;
  fingerprint: string;
  componentId: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckId?: string;
  occurrenceCount: number;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgementReason?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  alertTargets: IncidentAlertTarget[];
  playbookIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type IncidentEventRecord = {
  id: string;
  incidentId: string;
  type: "opened" | "observed" | "reopened" | "acknowledged" | "resolved" | "playbook_run" | "alert_routed";
  actorId?: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type IncidentStats = {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  active: number;
  criticalOpen: number;
  warningOpen: number;
  byComponent: Record<string, number>;
  latest: IncidentRecord[];
  latestEvents: IncidentEventRecord[];
  playbooks: IncidentPlaybook[];
  alertTargets: IncidentAlertTarget[];
};

type IncidentsResponse = {
  incidents: IncidentRecord[];
  stats: IncidentStats;
  playbooks: IncidentPlaybook[];
  alertTargets: IncidentAlertTarget[];
};

type AlertDeliveryStatus = "queued" | "running" | "delivered" | "failed" | "skipped";

type AlertDeliveryRecord = {
  id: string;
  incidentId: string;
  incidentEventId?: string;
  targetId: string;
  channel: IncidentAlertTarget["channel"];
  status: AlertDeliveryStatus;
  severity: IncidentSeverity;
  dedupeKey: string;
  payload: Record<string, unknown>;
  response?: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  lockedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
};

type AlertDeliveryPolicy = {
  id: string;
  name: string;
  minSeverity: IncidentSeverity;
  channels: IncidentAlertTarget["channel"][];
  maxAttempts: number;
  retryBackoffSeconds: number[];
  escalationAfterMinutes: number;
};

type AlertSchedulerState = {
  enabled: boolean;
  path: string;
  schedule: string;
  cronSecretConfigured: boolean;
  queueLimit: number;
  dispatchLimit: number;
  readyTargets: number;
  configuredExternalTargets: number;
};

type AlertTargetProbeStatus = "healthy" | "missing_config" | "misconfigured";

type AlertTargetHealth = {
  id: string;
  name: string;
  channel: IncidentAlertTarget["channel"];
  targetStatus: IncidentAlertTarget["status"];
  probeStatus: AlertTargetProbeStatus;
  ready: boolean;
  configured: boolean;
  requiredEnv: string[];
  optionalEnv: string[];
  blockingReasons: string[];
  checkedAt: string;
  security: {
    secretValuesExposed: false;
    webhookSigned?: boolean;
  };
};

type AlertDeliveryStats = {
  total: number;
  queued: number;
  running: number;
  delivered: number;
  failed: number;
  skipped: number;
  runnable: number;
  retryableFailed: number;
  readyTargets: number;
  configuredExternalTargets: number;
  blockedExternalTargets: number;
  byChannel: Record<string, number>;
  latest: AlertDeliveryRecord[];
  policies: AlertDeliveryPolicy[];
  targets: IncidentAlertTarget[];
  targetHealth: AlertTargetHealth[];
  scheduler: AlertSchedulerState;
};

type AlertsResponse = {
  deliveries: AlertDeliveryRecord[];
  stats: AlertDeliveryStats;
  policies: AlertDeliveryPolicy[];
  targets: IncidentAlertTarget[];
  targetHealth: AlertTargetHealth[];
};

type RetrievalTraceRecord = {
  id: string;
  query: string;
  profile: {
    mode: string;
    intent: string;
    complexity: number;
  };
  resultCount: number;
  selectedCount: number;
  latencyMs: number;
  createdAt: string;
};

type ContextEngineStats = {
  traces: number;
  averageLatencyMs: number;
  averageSelectedCount: number;
  byMode: Record<string, number>;
  latest: RetrievalTraceRecord[];
};

type MemoryGraphStats = {
  nodes: number;
  edges: number;
  communities: number;
  averageDegree: number;
  latestBuild?: {
    id: string;
    status: "completed" | "failed";
    source: string;
    nodeCount: number;
    edgeCount: number;
    latencyMs: number;
    createdAt: string;
  };
  topNodes: Array<{
    id: string;
    kind: string;
    label: string;
    weight: number;
    sourceCount: number;
  }>;
};

type WorkflowsResponse = {
  runs: WorkflowRunRecord[];
  stats: WorkflowStats;
  queue: OperationJobStats;
};

type EvalResultStatus = "pass" | "fail" | "warn";
type EvalSafetyMode = "read_only" | "synthetic" | "mutation_allowed";
type EvalCleanupPolicy = "none" | "self_cleaning" | "audit_retained" | "manual_review";

type EvalCaseGovernance = {
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

type EvalCaseDefinition = {
  id: string;
  name: string;
  description: string;
  type: "system" | "retrieval" | "tool" | "workflow" | "security" | "operations";
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  governance: EvalCaseGovernance;
};

type EvalRunRecord = {
  id: string;
  suite: string;
  status: "running" | "completed" | "failed";
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    averageLatencyMs: number;
    estimatedCostUsd: number;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};

type EvalResultRecord = {
  id: string;
  evalRunId: string;
  caseId: string;
  caseName: string;
  caseType: string;
  status: EvalResultStatus;
  score: number;
  latencyMs: number;
  estimatedCostUsd: number;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
};

type EvalStats = {
  total: number;
  byStatus: Record<string, number>;
  latest?: EvalRunRecord;
  latestPassRate: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
};

type EvalGovernanceSummary = {
  production: boolean;
  totalCases: number;
  selectedCaseIds: string[];
  bySafetyMode: Record<EvalSafetyMode, number>;
  mutatingCases: number;
  maxRiskLevel: number;
  requiresMutationApproval: boolean;
};

type EvaluationsResponse = {
  cases: EvalCaseDefinition[];
  governance: EvalGovernanceSummary;
  defaults: {
    maxSafetyMode: EvalSafetyMode;
  };
  runs: EvalRunRecord[];
  stats: EvalStats;
};

type EvalRunDetail = {
  run: EvalRunRecord;
  results: EvalResultRecord[];
  governance?: EvalGovernanceSummary;
  override?: EvalOverrideEvidence;
  caseEvidence?: EvalCaseEvidence[];
  events?: ObservabilityEventRecord[];
};

type EvalReportSignature = {
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

type EvalReportSigningKeyStatus = "active" | "verify_only" | "fallback" | "local_development";
type EvalReportSigningKeySource = "primary_env" | "rotation_env" | "cron_fallback" | "local_development";

type EvalReportSigningKeyMetadata = {
  keyId: string;
  algorithm: "HMAC-SHA256";
  status: EvalReportSigningKeyStatus;
  source: EvalReportSigningKeySource;
  verifier: "omniagent-eval-report-v1";
  notBefore?: string;
  notAfter?: string;
};

type EvalReportSnapshot = {
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

type EvalReportResponse = {
  reports?: EvalReportSnapshot[];
  latest?: EvalReportSnapshot;
  report?: EvalReportSnapshot;
  keyring?: EvalReportSigningKeyMetadata[];
  verification?: EvalReportVerificationResult;
  error?: string;
};

type EvalReportVerificationResult = {
  valid: boolean;
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

type EvalOverrideEvidence = {
  requested: boolean;
  allowMutation: boolean;
  reasonProvided: boolean;
  reason?: string;
  role: SecurityRole;
  actorId: string;
  tenantId: string;
};

type EvalCaseEvidence = {
  result: EvalResultRecord;
  definition?: EvalCaseDefinition;
  governance?: EvalCaseGovernance;
};

type EvalDetailFilter = "all" | "failed" | "warn" | "gated";

type ObservabilityLevel = "info" | "warn" | "error";
type ObservabilityCategory = "api" | "workflow" | "alert" | "connector" | "diagnostics" | "evaluation" | "security" | "system";

type ObservabilityEventRecord = {
  id: string;
  level: ObservabilityLevel;
  category: ObservabilityCategory;
  action: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  correlationId: string;
  tenantId?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ObservabilityStats = {
  total: number;
  byLevel: Record<string, number>;
  byCategory: Record<string, number>;
  routeFailures: number;
  authFailures?: number;
  policyBlocks?: number;
  connectorFailures?: number;
  averageDurationMs: number;
  p95DurationMs: number;
  latest: ObservabilityEventRecord[];
  recentErrors: ObservabilityEventRecord[];
  slo: {
    healthy: boolean;
    availability: number;
    errorRate: number;
    errorBudgetRemaining: number;
    latencyP95Ms: number;
  };
};

type ObservabilityResponse = {
  events: ObservabilityEventRecord[];
  stats: ObservabilityStats;
};

type SloMetric =
  | "errorRate"
  | "availability"
  | "latencyP95Ms"
  | "routeFailures"
  | "authFailures"
  | "policyBlocks"
  | "connectorFailures";
type SloComparator = "greater_than" | "greater_than_or_equal" | "less_than" | "less_than_or_equal";

type ObservabilitySloPolicy = {
  id: string;
  name: string;
  description: string;
  metric: SloMetric;
  comparator: SloComparator;
  warningThreshold: number;
  criticalThreshold: number;
  warningSeverity: IncidentSeverity;
  criticalSeverity: IncidentSeverity;
  unit: "ratio" | "ms" | "count";
  componentId: string;
  enabled: boolean;
  alertTargetIds: string[];
  suppressionMinutes: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

type SloPolicyChangeAction =
  | "upsert_policy"
  | "toggle_policy"
  | "delete_policy"
  | "reset_defaults"
  | "rollback_policy";

type SloPolicyChangeStatus = "pending" | "applied" | "rejected";
type SloPolicyApprovalDecision = "approved" | "rejected";

type SloPolicyApprovalPolicy = {
  quorum: number;
  requiredRoles: SecurityRole[];
  allowRequesterApproval: boolean;
  attestationRequired: boolean;
  breakGlassAllowed: boolean;
  description: string;
};

type SloPolicyApprovalEvidence = {
  id: string;
  decision: SloPolicyApprovalDecision;
  actorId: string;
  actorRole: SecurityRole;
  tenantId?: string;
  reason?: string;
  breakGlass?: boolean;
  ticket?: string;
  createdAt: string;
  previousHash?: string;
  evidenceHash: string;
  signature: string;
};

type ObservabilitySloPolicyChange = {
  id: string;
  policyId: string;
  action: SloPolicyChangeAction;
  status: SloPolicyChangeStatus;
  riskLevel: number;
  tenantId?: string;
  requestedBy?: string;
  reviewedBy?: string;
  reason?: string;
  reviewReason?: string;
  beforePolicy?: ObservabilitySloPolicy | null;
  afterPolicy?: ObservabilitySloPolicy | null;
  rollbackChangeId?: string;
  approvalPolicy: SloPolicyApprovalPolicy;
  approvals: SloPolicyApprovalEvidence[];
  evidenceHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  appliedAt?: string;
};

type SloApprovalPolicyRule = {
  id: string;
  action?: SloPolicyChangeAction | "any";
  riskLevel?: number;
  quorum: number;
  requiredRoles: SecurityRole[];
  allowRequesterApproval: boolean;
  attestationRequired: boolean;
  breakGlassAllowed: boolean;
  description: string;
};

type SloBreakGlassPolicy = {
  enabled: boolean;
  requiredRole: SecurityRole;
  reasonMinLength: number;
  maxRiskLevel: number;
  requireTicket: boolean;
  description: string;
};

type ObservabilitySloApprovalPolicyConfig = {
  id: string;
  version: number;
  rules: SloApprovalPolicyRule[];
  breakGlass: SloBreakGlassPolicy;
  metadata: Record<string, unknown>;
  updatedBy?: string;
  updateReason?: string;
  createdAt: string;
  updatedAt: string;
  evidenceHash: string;
};

type ObservabilitySloApprovalPolicyVersion = {
  id: string;
  policyId: string;
  version: number;
  policy: ObservabilitySloApprovalPolicyConfig;
  changedBy?: string;
  changeReason?: string;
  previousHash?: string;
  evidenceHash: string;
  createdAt: string;
};

type ObservabilitySloEvaluation = {
  policy: ObservabilitySloPolicy;
  value: number;
  breached: boolean;
  severity?: IncidentSeverity;
  threshold?: number;
  margin: number;
  message: string;
};

type ObservabilitySloSnapshot = {
  checkedAt: string;
  healthy: boolean;
  stats: ObservabilityStats;
  policies: ObservabilitySloPolicy[];
  evaluations: ObservabilitySloEvaluation[];
  breaches: ObservabilitySloEvaluation[];
};

type ObservabilitySloPolicyResponse = {
  policies: ObservabilitySloPolicy[];
  defaults: ObservabilitySloPolicy[];
  alertTargets: IncidentAlertTarget[];
  changes: ObservabilitySloPolicyChange[];
  pendingChanges: ObservabilitySloPolicyChange[];
  approvalPolicy: ObservabilitySloApprovalPolicyConfig;
  approvalPolicyVersions: ObservabilitySloApprovalPolicyVersion[];
  snapshot: ObservabilitySloSnapshot;
};

type SecurityRole = "viewer" | "operator" | "admin" | "system";
type SecurityDecision = "allow" | "deny";

type SecurityContext = {
  tenantId: string;
  actorId: string;
  role: SecurityRole;
  source: "headers" | "default" | "session";
  auth?: {
    userId: string;
    email: string;
    sessionId: string;
    tenantName: string;
  };
};

type SecurityAuditRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  actorRole: SecurityRole;
  action: string;
  resourceType: string;
  resourceId?: string;
  decision: SecurityDecision;
  reason?: string;
  riskLevel?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type SecurityStats = {
  total: number;
  byDecision: Record<string, number>;
  byRole: Record<string, number>;
  latest: SecurityAuditRecord[];
};

type RbacRule = {
  action: string;
  description: string;
  roles: SecurityRole[];
};

type SecurityPolicy = {
  rbacRules: RbacRule[];
  secretVault: {
    storage: string;
    allowedEnvNamePattern: string;
    disallowedPrefixes: string[];
    redactedFields: string[];
  };
};

type SecurityState = {
  context?: SecurityContext;
  stats?: SecurityStats;
  records: SecurityAuditRecord[];
  policy?: SecurityPolicy;
};

type TenantIsolationTableReport = {
  tableName: string;
  category: "root" | "child";
  exists: boolean;
  tenantColumn: boolean;
  rlsEnabled: boolean;
  forceRls: boolean;
  policyPresent: boolean;
  status: "pass" | "fail";
};

type TenantIsolationReport = {
  tenantId: string;
  checkedAt: string;
  storageBackend: string;
  databaseConfigured: boolean;
  status: "passing" | "degraded" | "not_configured";
  summary: {
    expectedTables: number;
    protectedTables: number;
    childTables: number;
    failingTables: number;
    missingTables: string[];
    missingTenantColumns: string[];
    rlsDisabled: string[];
    forceRlsDisabled: string[];
    missingPolicies: string[];
  };
  tables: TenantIsolationTableReport[];
  latestEval?: {
    runId: string;
    runStatus: string;
    resultStatus: string;
    score: number;
    createdAt: string;
    completedAt?: string;
  };
  recommendations: string[];
};

type AuthTenant = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

type AuthUser = {
  id: string;
  email: string;
  name?: string;
  status: "active" | "disabled";
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

type AuthMembership = {
  id: string;
  tenantId: string;
  userId: string;
  role: SecurityRole;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

type AuthSessionResponse = {
  authEnabled: boolean;
  bootstrapConfigured: boolean;
  authenticated: boolean;
  context?: SecurityContext;
  user?: AuthUser;
  tenant?: AuthTenant;
  membership?: AuthMembership;
  stats?: AuthControlPlane["stats"];
};

type AuthControlPlane = {
  authEnabled: boolean;
  bootstrapConfigured: boolean;
  stats: {
    tenants: number;
    users: number;
    activeUsers: number;
    sessions: number;
  };
  tenants: AuthTenant[];
  users: AuthUser[];
  memberships: AuthMembership[];
  sessions: {
    id: string;
    userId: string;
    tenantId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  }[];
};

type CapabilityResponse = {
  openaiConfigured: boolean;
  databaseConfigured: boolean;
  storageBackend: "postgres" | "ephemeral" | "file";
  vectorStore: {
    configured: boolean;
    extensionInstalled?: boolean;
    extensionVersion?: string;
    dimensions: number;
    hnswSupported: boolean;
    memoryColumnDimensions?: number;
    knowledgeColumnDimensions?: number;
    memoryIndexed?: boolean;
    knowledgeIndexed?: boolean;
  };
  memory: {
    total: number;
    embedded: number;
    byType: Record<string, number>;
  };
  memoryGraph: MemoryGraphStats;
  knowledge: {
    documents: number;
    chunks: number;
    characters: number;
    embedded: number;
  };
  contextEngine: ContextEngineStats;
  runs: {
    total: number;
    byStatus: Record<string, number>;
    consolidated: {
      runs: number;
      memories: number;
    };
    latest: AgentRun[];
  };
  toolExecutions: ToolAuditSummary;
  mcpConnectors: ConnectorStats;
  openApiConnectors: OpenApiConnectorStats;
  workflows: WorkflowStats;
  workflowPlans: WorkflowPlanStats;
  workflowPlanExecutions: WorkflowPlanExecutionStats;
  workflowTriggers: WorkflowTriggerStats;
  operationJobs: OperationJobStats;
  health: HealthStats;
  incidents: IncidentStats;
  alerts: AlertDeliveryStats;
  observability: ObservabilityStats;
  observabilitySlo: ObservabilitySloSnapshot;
  evaluations: EvalStats;
  security: {
    context: SecurityContext;
    stats?: SecurityStats;
    policy: SecurityPolicy;
  };
  registry: {
    agents: Capability[];
    tools: Capability[];
    connectorTypes: Capability[];
  };
};

type AgentRun = {
  id: string;
  mode: Mode;
  status: "running" | "completed" | "failed";
  prompt: string;
  model?: string;
  memoryContextCount: number;
  consolidationCount?: number;
  consolidatedAt?: string;
  startedAt: string;
};

type MemoryRecord = {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  updatedAt: string;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  source: string;
  sourceType: string;
  tags: string[];
  chunkCount: number;
  totalCharacters: number;
  updatedAt: string;
};

type KnowledgeChunk = {
  id: string;
  documentId: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  tokenEstimate: number;
  updatedAt: string;
};

const starterMessages: Message[] = [
  {
    role: "assistant",
    content:
      "OmniAgent OS is online. Give me a goal, and I will route it through planning, memory retrieval, tool selection, execution strategy, and verification.",
  },
];

const modes: { id: Mode; label: string }[] = [
  { id: "orchestrate", label: "Orchestrate" },
  { id: "research", label: "Research" },
  { id: "execute", label: "Execute" },
  { id: "learn", label: "Learn" },
];

const evaluationSafeSafetyMode: EvalSafetyMode = "synthetic";
const evaluationOverrideReasonMinLength = 12;
const evaluationDetailFilters: Array<{ id: EvalDetailFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "warn", label: "Warned" },
  { id: "gated", label: "Gated" },
];

const defaultToolInputs: Record<string, string> = {
  "memory.search": JSON.stringify({ query: "structured memory consolidation", limit: 3 }, null, 2),
  "knowledge.search": JSON.stringify({ query: "RAG v2 production smoke", limit: 3 }, null, 2),
  "memory.write": JSON.stringify(
    {
      title: "Governed tool policy",
      content: "Tool executions should be schema-validated, dry-runnable, risk-scored, and audit logged.",
      type: "procedure",
      tags: ["tool-governance"],
      importance: 0.74,
    },
    null,
    2,
  ),
  "knowledge.ingest": JSON.stringify(
    {
      title: "Tool governance note",
      content:
        "A governed tool layer keeps low-risk reads fast while requiring explicit approval for external side effects.",
      source: "operator",
      tags: ["tool-governance"],
    },
    null,
    2,
  ),
  "runs.list": JSON.stringify({ limit: 3 }, null, 2),
  "connector.external_action": JSON.stringify(
    {
      connector: "example",
      action: "send",
      payload: { message: "dry run only" },
    },
    null,
    2,
  ),
};

export function CommandCenter() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [input, setInput] = useState("Design the first durable workflow for our agent OS.");
  const [mode, setMode] = useState<Mode>("orchestrate");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [riskActionInFlight, setRiskActionInFlight] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityResponse | null>(null);
  const [memoryTitle, setMemoryTitle] = useState("Project operating principles");
  const [memoryContent, setMemoryContent] = useState(
    "Prefer durable workflows, permissioned tools, and verifiable outputs over single-shot autonomous claims.",
  );
  const [knowledgeTitle, setKnowledgeTitle] = useState("Agent framework architecture notes");
  const [knowledgeContent, setKnowledgeContent] = useState(
    "Store source documents as chunks with embeddings, keep every chunk tied to provenance, and retrieve context with hybrid semantic and keyword ranking.",
  );
  const [browserQuery, setBrowserQuery] = useState("");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [toolState, setToolState] = useState<ToolsResponse | null>(null);
  const [selectedToolId, setSelectedToolId] = useState("memory.search");
  const [toolInput, setToolInput] = useState(defaultToolInputs["memory.search"]);
  const [toolResult, setToolResult] = useState("");
  const [connectorState, setConnectorState] = useState<ConnectorsResponse | null>(null);
  const [connectorName, setConnectorName] = useState("Primary MCP server");
  const [connectorEndpoint, setConnectorEndpoint] = useState("https://example.com/mcp");
  const [connectorAuthEnv, setConnectorAuthEnv] = useState("");
  const [editingConnectorId, setEditingConnectorId] = useState("");
  const [connectorResult, setConnectorResult] = useState("");
  const [openApiState, setOpenApiState] = useState<OpenApiConnectorsResponse | null>(null);
  const [openApiName, setOpenApiName] = useState("Public API connector");
  const [openApiSpecUrl, setOpenApiSpecUrl] = useState("https://petstore3.swagger.io/api/v3/openapi.json");
  const [openApiBaseUrl, setOpenApiBaseUrl] = useState("");
  const [openApiAuthEnv, setOpenApiAuthEnv] = useState("");
  const [openApiAuthHeader, setOpenApiAuthHeader] = useState("x-api-key");
  const [editingOpenApiConnectorId, setEditingOpenApiConnectorId] = useState("");
  const [openApiResult, setOpenApiResult] = useState("");
  const [workflowState, setWorkflowState] = useState<WorkflowsResponse | null>(null);
  const [workflowGoal, setWorkflowGoal] = useState("Run a durable Plan-Execute-Verify workflow for this agent OS.");
  const [workflowResult, setWorkflowResult] = useState("");
  const [approvalState, setApprovalState] = useState<ApprovalQueueResponse | null>(null);
  const [operationState, setOperationState] = useState<OperationsResponse | null>(null);
  const [approvalResult, setApprovalResult] = useState("");
  const [operationResult, setOperationResult] = useState("");
  const [diagnosticsResult, setDiagnosticsResult] = useState("");
  const [incidentState, setIncidentState] = useState<IncidentsResponse | null>(null);
  const [incidentResult, setIncidentResult] = useState("");
  const [alertState, setAlertState] = useState<AlertsResponse | null>(null);
  const [alertResult, setAlertResult] = useState("");
  const [connectionCatalog, setConnectionCatalog] = useState<ConnectionCatalogResponse | null>(null);
  const [evaluationState, setEvaluationState] = useState<EvaluationsResponse | null>(null);
  const [evaluationResult, setEvaluationResult] = useState("");
  const [selectedEvaluationRunId, setSelectedEvaluationRunId] = useState("");
  const [selectedEvaluationDetail, setSelectedEvaluationDetail] = useState<EvalRunDetail | null>(null);
  const [evaluationDetailFilter, setEvaluationDetailFilter] = useState<EvalDetailFilter>("all");
  const [evaluationReportsByRun, setEvaluationReportsByRun] = useState<Record<string, EvalReportSnapshot[]>>({});
  const [evaluationReportResult, setEvaluationReportResult] = useState("");
  const [evaluationAllowMutation, setEvaluationAllowMutation] = useState(false);
  const [evaluationOverrideReason, setEvaluationOverrideReason] = useState("");
  const [observabilityState, setObservabilityState] = useState<ObservabilityResponse | null>(null);
  const [observabilitySloState, setObservabilitySloState] = useState<ObservabilitySloSnapshot | null>(null);
  const [sloPolicyState, setSloPolicyState] = useState<ObservabilitySloPolicyResponse | null>(null);
  const [selectedSloPolicyId, setSelectedSloPolicyId] = useState("");
  const [sloWarningThreshold, setSloWarningThreshold] = useState("");
  const [sloCriticalThreshold, setSloCriticalThreshold] = useState("");
  const [sloWarningSeverity, setSloWarningSeverity] = useState<IncidentSeverity>("warning");
  const [sloCriticalSeverity, setSloCriticalSeverity] = useState<IncidentSeverity>("critical");
  const [sloSuppressionMinutes, setSloSuppressionMinutes] = useState("");
  const [sloPolicyEnabled, setSloPolicyEnabled] = useState(true);
  const [sloTargetIds, setSloTargetIds] = useState<string[]>([]);
  const [sloLowRiskQuorum, setSloLowRiskQuorum] = useState("1");
  const [sloHighRiskQuorum, setSloHighRiskQuorum] = useState("2");
  const [sloRollbackAttestation, setSloRollbackAttestation] = useState(true);
  const [sloBreakGlassEnabled, setSloBreakGlassEnabled] = useState(true);
  const [sloBreakGlassReasonMin, setSloBreakGlassReasonMin] = useState("24");
  const [observabilityResult, setObservabilityResult] = useState("");
  const [securityState, setSecurityState] = useState<SecurityState | null>(null);
  const [tenantIsolationReport, setTenantIsolationReport] = useState<TenantIsolationReport | null>(null);
  const [tenantIsolationResult, setTenantIsolationResult] = useState("");
  const [authState, setAuthState] = useState<AuthSessionResponse | null>(null);
  const [authControlPlane, setAuthControlPlane] = useState<AuthControlPlane | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [identityPassword, setIdentityPassword] = useState("");
  const [identityRole, setIdentityRole] = useState<SecurityRole>("viewer");
  const [identityResult, setIdentityResult] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);

  function beginRiskyAction(key: string, title: string, impact: string) {
    if (riskActionInFlight) {
      setStatus("another high-risk action is already running");
      return false;
    }

    const confirmed = window.confirm(`${title}\n\n${impact}\n\nProceed?`);
    if (!confirmed) {
      setStatus("high-risk action canceled");
      return false;
    }

    setRiskActionInFlight(key);
    return true;
  }

  function endRiskyAction(key: string) {
    setRiskActionInFlight((current) => (current === key ? null : current));
  }

  const activeTools = useMemo(
    () => capabilities?.registry.tools.filter((tool) => tool.status === "active") || [],
    [capabilities],
  );
  const governedActiveTools = useMemo(
    () => toolState?.tools.filter((tool) => tool.status === "active") || [],
    [toolState],
  );
  const latestRuns = capabilities?.runs.latest || [];
  const toolAuditStats = toolState?.audits || capabilities?.toolExecutions;
  const latestToolAudits = toolAuditStats?.latest || [];
  const selectedTool = toolState?.tools.find((tool) => tool.id === selectedToolId);
  const connectorStats = connectorState?.stats || capabilities?.mcpConnectors;
  const latestConnectors = connectorState?.connectors.slice(0, 5) || [];
  const latestMcpTools = connectorState?.tools.slice(0, 5) || [];
  const openApiStats = openApiState?.stats || capabilities?.openApiConnectors;
  const latestOpenApiConnectors = openApiState?.connectors.slice(0, 5) || [];
  const latestOpenApiOperations = openApiState?.operations.slice(0, 5) || [];
  const workflowStats = workflowState?.stats || capabilities?.workflows;
  const plannerStats = capabilities?.workflowPlans;
  const planExecutionStats = capabilities?.workflowPlanExecutions;
  const triggerStats = capabilities?.workflowTriggers;
  const queueStats = workflowState?.queue || capabilities?.operationJobs;
  const healthStats = capabilities?.health;
  const incidentStats = incidentState?.stats || capabilities?.incidents;
  const activeIncidents = incidentState?.incidents || incidentStats?.latest || [];
  const alertStats = alertState?.stats || capabilities?.alerts;
  const alertScheduler = alertStats?.scheduler;
  const latestAlertDeliveries = alertState?.deliveries || alertStats?.latest || [];
  const alertTargetHealth = alertState?.targetHealth || alertStats?.targetHealth || [];
  const contextStats = capabilities?.contextEngine;
  const graphStats = capabilities?.memoryGraph;
  const latestWorkflows = workflowState?.runs.slice(0, 5) || capabilities?.workflows.latest || [];
  const approvalQueue = approvalState?.items || operationState?.approvals.items || [];
  const approvalStats = approvalState?.stats || operationState?.approvals.stats;
  const operationSummary = operationState?.summary;
  const operationRecovery = operationState?.recovery;
  const latestRecoveryEvents = operationState?.latest.recoveryEvents || [];
  const historicalFailedWorkflows = operationSummary?.historicalFailedWorkflows ??
    operationSummary?.failedWorkflows ??
    workflowStats?.byStatus.failed ??
    0;
  const liveWorkflowRisks = operationSummary?.liveWorkflowRisks ??
    ((operationSummary?.staleWorkflows ?? operationRecovery?.staleWorkflows.length ?? 0) +
      (operationSummary?.recentUnhandledWorkflowFailures ?? 0));
  const recentUnhandledWorkflowFailures = operationSummary?.recentUnhandledWorkflowFailures ?? 0;
  const recoveredWorkflowFailures = operationSummary?.recoveredWorkflowFailures ?? 0;
  const connectionTemplates = connectionCatalog?.connectors || [];
  const securityContext = securityState?.context || capabilities?.security.context;
  const evaluationStats = evaluationState?.stats || capabilities?.evaluations;
  const evaluationGovernance = evaluationState?.governance;
  const evaluationDefaultSafetyMode = evaluationState?.defaults.maxSafetyMode || "synthetic";
  const evaluationCases = evaluationState?.cases || [];
  const safeEvaluationCases = evaluationCases.filter((evalCase) =>
    evalSafetyOrder(evalCase.governance.safetyMode) <= evalSafetyOrder(evaluationSafeSafetyMode)
  );
  const gatedEvaluationCases = evaluationCases.filter((evalCase) =>
    evalCase.governance.safetyMode === "mutation_allowed" || evalCase.governance.production.requiresMutationApproval
  );
  const evaluationRole = authState?.membership?.role || securityContext?.role || "admin";
  const evaluationOverrideReasonText = evaluationOverrideReason.trim();
  const canRunGatedEvaluations = ["admin", "system"].includes(evaluationRole) &&
    evaluationAllowMutation &&
    evaluationOverrideReasonText.length >= evaluationOverrideReasonMinLength &&
    gatedEvaluationCases.length > 0;
  const gatedEvaluationBlocker = gatedEvaluationCases.length === 0
    ? "no gated cases"
    : !["admin", "system"].includes(evaluationRole)
      ? "admin/system role"
      : !evaluationAllowMutation
        ? "mutation unchecked"
        : evaluationOverrideReasonText.length < evaluationOverrideReasonMinLength
          ? `${evaluationOverrideReasonMinLength}+ chars`
          : "ready";
  const selectedEvaluationCaseEvidence = selectedEvaluationDetail
    ? selectedEvaluationDetail.caseEvidence || selectedEvaluationDetail.results.map((result) => {
        const definition = evaluationCases.find((evalCase) => evalCase.id === result.caseId);
        return {
          result,
          definition,
          governance: definition?.governance,
        };
      })
    : [];
  const filteredEvaluationCaseEvidence = selectedEvaluationCaseEvidence.filter((evidence) => {
    if (evaluationDetailFilter === "failed") {
      return evidence.result.status === "fail";
    }

    if (evaluationDetailFilter === "warn") {
      return evidence.result.status === "warn";
    }

    if (evaluationDetailFilter === "gated") {
      return evidence.governance?.safetyMode === "mutation_allowed" ||
        Boolean(evidence.governance?.production.requiresMutationApproval);
    }

    return true;
  });
  const selectedEvaluationReports = selectedEvaluationRunId ? evaluationReportsByRun[selectedEvaluationRunId] || [] : [];
  const latestEvaluations = evaluationState?.runs.slice(0, 5) || (capabilities?.evaluations.latest ? [capabilities.evaluations.latest] : []);
  const latestEvaluationCases = evaluationCases.slice(0, 3);
  const observabilityStats = observabilityState?.stats || capabilities?.observability;
  const latestObservabilityEvents = observabilityState?.events || observabilityStats?.latest || [];
  const observabilitySlo = observabilitySloState || capabilities?.observabilitySlo;
  const sloPolicies = sloPolicyState?.policies || observabilitySlo?.policies || [];
  const sloPolicyChanges = sloPolicyState?.changes || [];
  const pendingSloPolicyChanges = sloPolicyState?.pendingChanges || sloPolicyChanges.filter((change) => change.status === "pending");
  const sloApprovalPolicy = sloPolicyState?.approvalPolicy;
  const sloApprovalPolicyVersions = sloPolicyState?.approvalPolicyVersions || [];
  const selectedSloPolicy = sloPolicies.find((policy) => policy.id === selectedSloPolicyId) || sloPolicies[0];
  const sloAlertTargets = sloPolicyState?.alertTargets || alertTargetHealth.map((target) => ({
    id: target.id,
    name: target.name,
    channel: target.channel,
    status: target.targetStatus,
    description: target.blockingReasons[0] || target.channel,
  }));
  const observabilityBreaches = observabilitySlo?.breaches || [];
  const securityStats = securityState?.stats || capabilities?.security.stats;
  const securityPolicy = securityState?.policy || capabilities?.security.policy;
  const latestSecurityAudits =
    securityState?.records.length ? securityState.records : securityStats?.latest || [];
  const securityRules = securityPolicy?.rbacRules.slice(0, 5) || [];
  const tenantIsolationFailingTables = tenantIsolationReport?.tables.filter((table) => table.status === "fail") || [];
  const tenantIsolationLatestEval = tenantIsolationReport?.latestEval;
  const authStats = authControlPlane?.stats || authState?.stats;
  const authUsers = authControlPlane?.users.slice(0, 5) || [];
  const currentIdentity = authState?.user?.email || securityContext?.actorId || "anonymous";
  const authMode = authState?.authEnabled ? "Enforced" : "Open";
  const storageLabel =
    capabilities?.storageBackend === "postgres"
      ? "Postgres"
      : capabilities?.storageBackend === "ephemeral"
        ? "Ephemeral"
        : "File";

  function loadSloPolicyForm(policy: ObservabilitySloPolicy) {
    setSelectedSloPolicyId(policy.id);
    setSloWarningThreshold(String(policy.warningThreshold));
    setSloCriticalThreshold(String(policy.criticalThreshold));
    setSloWarningSeverity(policy.warningSeverity);
    setSloCriticalSeverity(policy.criticalSeverity);
    setSloSuppressionMinutes(String(policy.suppressionMinutes));
    setSloPolicyEnabled(policy.enabled);
    setSloTargetIds(policy.alertTargetIds || []);
  }

  function loadSloApprovalPolicyForm(policy: ObservabilitySloApprovalPolicyConfig) {
    const lowRiskRule = findSloApprovalRule(policy, "risk_2_standard", 2);
    const highRiskRule = findSloApprovalRule(policy, "risk_3_high", 3);
    const rollbackRule = policy.rules.find((rule) => rule.id === "rollback_policy" || rule.action === "rollback_policy");

    setSloLowRiskQuorum(String(lowRiskRule?.quorum ?? 1));
    setSloHighRiskQuorum(String(highRiskRule?.quorum ?? rollbackRule?.quorum ?? 2));
    setSloRollbackAttestation(Boolean(rollbackRule?.attestationRequired ?? true));
    setSloBreakGlassEnabled(policy.breakGlass.enabled);
    setSloBreakGlassReasonMin(String(policy.breakGlass.reasonMinLength));
  }

  async function initializeWorkspace() {
    const auth = await refreshAuth();
    if (auth?.authEnabled && !auth.authenticated) {
      setStatus("sign-in required");
      return;
    }

    setStatus("idle");
    refreshWorkspace();
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthMessage("signing in");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || data.error || "Sign-in failed.");
      }
      setAuthPassword("");
      setAuthMessage("signed in");
      setStatus("idle");
      await refreshAuth();
      refreshWorkspace();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Sign-in failed.");
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuthControlPlane(null);
    setCapabilities(null);
    setSecurityState(null);
    setAuthMessage("signed out");
    setStatus("sign-in required");
    await refreshAuth();
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || isRunning) {
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content: prompt }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setIsRunning(true);
    setStatus("starting run");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, mode }),
      });

      if (!response.body) {
        throw new Error("No response body returned.");
      }

      await readEventStream(response.body, (event) => {
        if (event.type === "status") {
          setStatus(event.detail ? `${event.label}: ${event.detail}` : event.label);
        }

        if (event.type === "memory") {
          setStatus(`${event.title}${event.count ? ` (${event.count})` : ""}`);
        }

        if (event.type === "delta") {
          setMessages((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              ...last,
              content: `${last.content}${event.text}`,
            };
            return copy;
          });
        }

        if (event.type === "error") {
          setStatus(event.message);
        }

        if (event.type === "done") {
          setStatus("run complete");
          refreshWorkspace();
        }
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "run failed");
    } finally {
      setIsRunning(false);
    }
  }

  async function saveManualMemory() {
    if (!memoryTitle.trim() || !memoryContent.trim()) {
      return;
    }

    setStatus("saving memory");
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: memoryTitle,
        content: memoryContent,
        type: "procedure",
        tags: ["project", "operating-principle"],
        importance: 0.85,
      }),
    });
    setStatus("memory saved");
    refreshWorkspace();
  }

  async function saveKnowledgeDocument() {
    if (!knowledgeTitle.trim() || !knowledgeContent.trim()) {
      return;
    }

    setStatus("ingesting knowledge");
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: knowledgeTitle,
        content: knowledgeContent,
        source: "manual",
        sourceType: "manual",
        tags: ["workspace", "operator-ingest"],
      }),
    });

    if (!response.ok) {
      setStatus("knowledge ingest failed");
      return;
    }

    setStatus("knowledge ingested");
    refreshWorkspace();
  }

  async function searchWorkspace() {
    const query = browserQuery.trim();
    if (!query) {
      refreshWorkspace();
      return;
    }

    setStatus("searching memory");
    const [memoryResponse, knowledgeResponse] = await Promise.all([
      fetch(`/api/memory?q=${encodeURIComponent(query)}&limit=5`).then((response) => response.json()),
      fetch(`/api/knowledge?q=${encodeURIComponent(query)}&limit=5`).then((response) => response.json()),
    ]);
    setMemories((memoryResponse.results || []).map((result: { record: MemoryRecord }) => result.record));
    setDocuments([]);
    setChunks((knowledgeResponse.results || []).map((result: { chunk: KnowledgeChunk }) => result.chunk));
    setStatus("search complete");
  }

  async function runGovernedTool(dryRun: boolean) {
    let parsedInput: Record<string, unknown>;
    try {
      const parsed = JSON.parse(toolInput || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Tool input must be a JSON object.");
      }
      parsedInput = parsed as Record<string, unknown>;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Tool input must be valid JSON.");
      return;
    }

    setStatus(dryRun ? "dry-running tool" : "executing tool");

    try {
      const response = await fetch("/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolId: selectedToolId,
          input: parsedInput,
          dryRun,
        }),
      });
      const data = await response.json();
      setToolResult(formatToolResult(data.result ?? data.record ?? data));
      setStatus(data.record?.status ? `tool ${data.record.status}` : response.ok ? "tool complete" : "tool failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "tool execution failed");
    }
  }

  async function registerConnector(discover: boolean) {
    if (!connectorName.trim() || !connectorEndpoint.trim()) {
      return;
    }

    const isEditing = Boolean(editingConnectorId);
    setStatus(isEditing ? "updating MCP" : discover ? "registering and discovering MCP" : "registering MCP");
    setConnectorResult("");

    try {
      const body: Record<string, unknown> = {
        name: connectorName,
        endpoint: connectorEndpoint,
        defaultRiskLevel: 2,
        approvalRequired: true,
      };
      if (!isEditing || connectorAuthEnv.trim()) {
        body.authType = connectorAuthEnv.trim() ? "bearer_env" : "none";
        body.authTokenEnv = connectorAuthEnv.trim() || undefined;
      }
      if (!isEditing) {
        body.discover = discover;
      }

      const response = await fetch(isEditing ? `/api/connectors/${editingConnectorId}` : "/api/connectors", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      let result = data;
      if (response.ok && isEditing && discover) {
        const discoveryResponse = await fetch(`/api/connectors/${editingConnectorId}/discover`, { method: "POST" });
        const discoveryData = await discoveryResponse.json();
        result = { update: data, discovery: discoveryData };
      }
      setConnectorResult(formatToolResult(result));
      setStatus(data.error ? "MCP update held" : isEditing ? "MCP updated" : discover ? "MCP discovered" : "MCP registered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP update failed");
    }
  }

  function clearConnectorForm() {
    setEditingConnectorId("");
    setConnectorName("Primary MCP server");
    setConnectorEndpoint("https://example.com/mcp");
    setConnectorAuthEnv("");
    setConnectorResult("");
  }

  function loadConnectorForEdit(connector: McpConnectorRecord) {
    setEditingConnectorId(connector.id);
    setConnectorName(connector.name);
    setConnectorEndpoint(connector.endpoint);
    setConnectorAuthEnv("");
    setConnectorResult(`Editing ${connector.name}. Leave bearer env blank to keep the existing auth setting.`);
  }

  async function discoverConnector(connectorId: string) {
    setStatus("discovering MCP");
    setConnectorResult("");

    try {
      const response = await fetch(`/api/connectors/${connectorId}/discover`, {
        method: "POST",
      });
      const data = await response.json();
      setConnectorResult(formatToolResult(data));
      setStatus(data.error ? "MCP discovery held" : "MCP discovered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP discovery failed");
    }
  }

  async function updateConnectorStatus(connector: McpConnectorRecord) {
    const nextStatus = connector.status === "disabled" ? "active" : "disabled";
    setStatus(`${nextStatus === "active" ? "enabling" : "disabling"} MCP`);
    setConnectorResult("");

    try {
      const response = await fetch(`/api/connectors/${connector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json();
      setConnectorResult(formatToolResult(data));
      setStatus(response.ok ? `MCP ${nextStatus}` : "MCP status update failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP status update failed");
    }
  }

  async function deleteConnector(connector: McpConnectorRecord) {
    const actionKey = `delete-mcp-${connector.id}`;
    if (!beginRiskyAction(actionKey, "Delete MCP connector", `This removes ${connector.name} and its discovered tools.`)) {
      return;
    }

    setConnectorResult("");
    try {
      const response = await fetch(`/api/connectors/${connector.id}`, { method: "DELETE" });
      const data = await response.json();
      setConnectorResult(formatToolResult(data));
      setStatus(response.ok ? "MCP connector deleted" : "MCP delete failed");
      if (editingConnectorId === connector.id) {
        clearConnectorForm();
      }
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP delete failed");
    } finally {
      endRiskyAction(actionKey);
    }
  }

  async function registerOpenApiConnector(importSpec: boolean) {
    if (!openApiName.trim() || (!openApiSpecUrl.trim() && importSpec === true)) {
      return;
    }

    const isEditing = Boolean(editingOpenApiConnectorId);
    setStatus(isEditing ? "updating OpenAPI" : importSpec ? "registering and importing OpenAPI" : "registering OpenAPI");
    setOpenApiResult("");

    try {
      const authType = openApiAuthEnv.trim() ? "api_key_header_env" : "none";
      const body: Record<string, unknown> = {
        name: openApiName,
        specUrl: openApiSpecUrl.trim() || (isEditing ? null : undefined),
        baseUrl: openApiBaseUrl.trim() || undefined,
        defaultRiskLevel: 2,
        approvalRequired: true,
      };
      if (!isEditing || openApiAuthEnv.trim()) {
        body.authType = authType;
        body.authTokenEnv = openApiAuthEnv.trim() || undefined;
        body.authHeaderName = authType === "api_key_header_env" ? openApiAuthHeader.trim() || "x-api-key" : undefined;
      }
      if (!isEditing) {
        body.importSpec = importSpec;
      }

      const response = await fetch(
        isEditing ? `/api/openapi-connectors/${editingOpenApiConnectorId}` : "/api/openapi-connectors",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      let result = data;
      if (response.ok && isEditing && importSpec) {
        const importResponse = await fetch(`/api/openapi-connectors/${editingOpenApiConnectorId}/import`, {
          method: "POST",
        });
        const importData = await importResponse.json();
        result = { update: data, import: importData };
      }
      setOpenApiResult(formatToolResult(result));
      setStatus(data.error ? "OpenAPI update held" : isEditing ? "OpenAPI updated" : importSpec ? "OpenAPI imported" : "OpenAPI registered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI update failed");
    }
  }

  function clearOpenApiConnectorForm() {
    setEditingOpenApiConnectorId("");
    setOpenApiName("Public API connector");
    setOpenApiSpecUrl("https://petstore3.swagger.io/api/v3/openapi.json");
    setOpenApiBaseUrl("");
    setOpenApiAuthEnv("");
    setOpenApiAuthHeader("x-api-key");
    setOpenApiResult("");
  }

  function loadOpenApiConnectorForEdit(connector: OpenApiConnectorRecord) {
    setEditingOpenApiConnectorId(connector.id);
    setOpenApiName(connector.name);
    setOpenApiSpecUrl(connector.specUrl || "");
    setOpenApiBaseUrl(connector.baseUrl || "");
    setOpenApiAuthEnv("");
    setOpenApiAuthHeader(connector.authHeaderName || "x-api-key");
    setOpenApiResult(`Editing ${connector.name}. Leave API key env blank to keep the existing auth setting.`);
  }

  async function updateOpenApiConnectorStatus(connector: OpenApiConnectorRecord) {
    const nextStatus = connector.status === "disabled" ? "active" : "disabled";
    setStatus(`${nextStatus === "active" ? "enabling" : "disabling"} OpenAPI`);
    setOpenApiResult("");

    try {
      const response = await fetch(`/api/openapi-connectors/${connector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json();
      setOpenApiResult(formatToolResult(data));
      setStatus(response.ok ? `OpenAPI ${nextStatus}` : "OpenAPI status update failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI status update failed");
    }
  }

  async function deleteOpenApiConnector(connector: OpenApiConnectorRecord) {
    const actionKey = `delete-openapi-${connector.id}`;
    if (!beginRiskyAction(actionKey, "Delete OpenAPI connector", `This removes ${connector.name} and its imported operations.`)) {
      return;
    }

    setOpenApiResult("");
    try {
      const response = await fetch(`/api/openapi-connectors/${connector.id}`, { method: "DELETE" });
      const data = await response.json();
      setOpenApiResult(formatToolResult(data));
      setStatus(response.ok ? "OpenAPI connector deleted" : "OpenAPI delete failed");
      if (editingOpenApiConnectorId === connector.id) {
        clearOpenApiConnectorForm();
      }
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI delete failed");
    } finally {
      endRiskyAction(actionKey);
    }
  }

  async function importOpenApiConnector(connectorId: string) {
    setStatus("importing OpenAPI");
    setOpenApiResult("");

    try {
      const response = await fetch(`/api/openapi-connectors/${connectorId}/import`, {
        method: "POST",
      });
      const data = await response.json();
      setOpenApiResult(formatToolResult(data));
      setStatus(data.error ? "OpenAPI import held" : "OpenAPI imported");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI import failed");
    }
  }

  async function startWorkflow() {
    const goal = workflowGoal.trim();
    if (!goal) {
      return;
    }

    setStatus("starting workflow");
    setWorkflowResult("");

    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          mode,
          requireApproval: true,
          maxAttempts: 3,
        }),
      });
      const data = (await response.json()) as WorkflowRunDetail;
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow queued" : "workflow failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "workflow start failed");
    }
  }

  async function tickWorkflow(workflowId?: string) {
    setStatus(workflowId ? "ticking workflow" : "ticking queued workflows");
    setWorkflowResult("");

    try {
      const response = await fetch(workflowId ? `/api/workflows/${workflowId}/tick` : "/api/workflows/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: workflowId ? undefined : JSON.stringify({ limit: 3 }),
      });
      const data = await response.json();
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow tick complete" : "workflow tick failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "workflow tick failed");
    }
  }

  async function signalWorkflow(workflowId: string, signal: "pause" | "resume" | "cancel" | "approve" | "retry") {
    setStatus(`workflow ${signal}`);
    setWorkflowResult("");

    try {
      const response = await fetch(`/api/workflows/${workflowId}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal }),
      });
      const data = await response.json();
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow signal applied" : `workflow ${signal} failed`);
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `workflow ${signal} failed`);
    }
  }

  async function decideApproval(item: ApprovalQueueItem, decision: "approve" | "reject") {
    setStatus(`${item.kind} ${decision}`);
    setApprovalResult("");

    try {
      const response = await fetch(`/api/approvals/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: item.kind,
          decision,
          reason: item.kind === "slo_policy" && item.record.approvalPolicy.attestationRequired
            ? "Command Center rollback approval attestation."
            : undefined,
        }),
      });
      const data = await response.json();
      setApprovalResult(formatToolResult(data));
      setStatus(response.ok ? `${item.kind} ${decision} complete` : `${item.kind} ${decision} failed`);
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${item.kind} ${decision} failed`);
    }
  }

  async function runDiagnostics(repair = false) {
    const riskKey = repair ? "diagnostics-repair" : undefined;
    if (riskKey && !beginRiskyAction(riskKey, "Repair diagnostics", "This can execute configured recovery actions and mutate operational state.")) {
      return;
    }

    setStatus(repair ? "repairing diagnostics" : "running diagnostics");
    setDiagnosticsResult("");

    try {
      const response = await fetch("/api/diagnostics", {
        method: repair ? "POST" : "GET",
      });
      const data = await response.json();
      setDiagnosticsResult(formatToolResult(data));
      setStatus(data.check?.status ? `health ${data.check.status}` : response.ok ? "diagnostics complete" : "diagnostics failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "diagnostics failed");
    } finally {
      if (riskKey) {
        endRiskyAction(riskKey);
      }
    }
  }

  async function runOperationsRecovery(action: "inspect_recovery" | "repair_recovery" | "drain_recovery") {
    const riskKey = action === "inspect_recovery" ? undefined : action;
    if (
      riskKey &&
      !beginRiskyAction(
        riskKey,
        action === "drain_recovery" ? "Drain workflow queue" : "Repair operations",
        action === "drain_recovery"
          ? "This can lease and execute queued workflow jobs."
          : "This can requeue stale jobs and repair expired operational leases.",
      )
    ) {
      return;
    }

    setStatus(action === "drain_recovery" ? "draining recovery" : action === "repair_recovery" ? "repairing operations" : "inspecting recovery");
    setOperationResult("");

    try {
      const response = await fetch("/api/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          limit: 10,
          drainLimit: 5,
        }),
      });
      const data = await response.json();
      setOperationResult(formatToolResult(data.recovery || data));
      if (data.overview) {
        setOperationState(data.overview);
      }
      setStatus(response.ok ? "operations recovery complete" : "operations recovery failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "operations recovery failed");
    } finally {
      if (riskKey) {
        endRiskyAction(riskKey);
      }
    }
  }

  async function handleIncidentAction(
    incident: IncidentRecord,
    action: "acknowledge" | "resolve" | "run_playbook",
  ) {
    const playbookId = action === "run_playbook"
      ? incident.playbookIds.find((id) =>
          (incidentState?.playbooks || incidentStats?.playbooks || []).some((playbook) => playbook.id === id && playbook.autoRunnable),
        ) || incident.playbookIds[0]
      : undefined;
    setStatus(action === "run_playbook" ? "running incident playbook" : `${action} incident`);
    setIncidentResult("");

    try {
      const response = await fetch(`/api/incidents/${incident.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          playbookId,
          reason:
            action === "acknowledge"
              ? "Acknowledged from command center."
              : action === "resolve"
                ? "Resolved from command center."
                : undefined,
        }),
      });
      const data = await response.json();
      setIncidentResult(formatToolResult(data));
      setStatus(response.ok ? `incident ${action} complete` : "incident action failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "incident action failed");
    }
  }

  async function runAlertAction(action: "enqueue_active" | "dispatch" | "enqueue_and_dispatch" | "probe_targets" | "retry_failed") {
    const riskKey = ["dispatch", "enqueue_and_dispatch", "retry_failed"].includes(action) ? `alerts-${action}` : undefined;
    if (
      riskKey &&
      !beginRiskyAction(
        riskKey,
        "Run alert delivery",
        "This can send notifications through configured alert targets.",
      )
    ) {
      return;
    }

    setStatus(
      action === "dispatch"
        ? "dispatching alerts"
        : action === "probe_targets"
          ? "probing alert targets"
          : action === "retry_failed"
            ? "retrying failed alerts"
            : "queueing alerts",
    );
    setAlertResult("");

    try {
      const response = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, limit: 10, includeSkipped: true }),
      });
      const data = await response.json();
      setAlertResult(formatToolResult(data));
      setStatus(response.ok ? `alerts ${action.replaceAll("_", " ")} complete` : "alert action failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "alert action failed");
    } finally {
      if (riskKey) {
        endRiskyAction(riskKey);
      }
    }
  }

  async function runAlertScheduler() {
    const riskKey = "alert-scheduler";
    if (!beginRiskyAction(riskKey, "Run alert scheduler", "This can queue and dispatch SLO and incident alerts.")) {
      return;
    }

    setStatus("running alert scheduler");
    setAlertResult("");

    try {
      const response = await fetch("/api/workflows/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 3, slo: true, alerts: true, alertQueueLimit: 10, alertDispatchLimit: 10 }),
      });
      const data = await response.json();
      setAlertResult(formatToolResult(data));
      setStatus(response.ok ? "alert scheduler complete" : "alert scheduler failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "alert scheduler failed");
    } finally {
      endRiskyAction(riskKey);
    }
  }

  async function runSloMonitor() {
    const riskKey = "slo-monitor";
    if (!beginRiskyAction(riskKey, "Run SLO monitor", "This can open incidents, resolve recovered incidents, queue alerts, and dispatch notifications.")) {
      return;
    }

    setStatus("running SLO monitor");
    setObservabilityResult("");

    try {
      const response = await fetch("/api/observability/slo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_monitor",
          queueAlerts: true,
          resolveRecovered: true,
          dispatchAlerts: true,
          dispatchLimit: 10,
        }),
      });
      const data = await response.json();
      setObservabilityResult(formatToolResult(data));
      if (data.result) {
        setObservabilitySloState(data.result);
      }
      setStatus(response.ok ? "SLO monitor complete" : "SLO monitor failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "SLO monitor failed");
    } finally {
      endRiskyAction(riskKey);
    }
  }

  async function saveSloPolicy() {
    if (!selectedSloPolicy) {
      return;
    }
    setStatus("requesting SLO policy change");
    setObservabilityResult("");

    try {
      const response = await fetch("/api/observability/slo/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_policy",
          policy: {
            ...selectedSloPolicy,
            warningThreshold: Number(sloWarningThreshold),
            criticalThreshold: Number(sloCriticalThreshold),
            warningSeverity: sloWarningSeverity,
            criticalSeverity: sloCriticalSeverity,
            suppressionMinutes: Number(sloSuppressionMinutes),
            enabled: sloPolicyEnabled,
            alertTargetIds: sloTargetIds,
          },
          requireApproval: true,
          reason: "Command Center SLO policy update request.",
        }),
      });
      const data = await response.json();
      setObservabilityResult(formatToolResult(data));
      if (data.policies) {
        setSloPolicyState(data);
        setObservabilitySloState(data.snapshot);
        const savedPolicy = data.policies.find((policy: ObservabilitySloPolicy) => policy.id === selectedSloPolicy.id);
        if (savedPolicy) {
          loadSloPolicyForm(savedPolicy);
        }
      }
      setStatus(response.ok ? "SLO policy change requested" : "SLO policy request failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "SLO policy request failed");
    }
  }

  async function resetSloPolicies() {
    const riskKey = "slo-policy-reset";
    if (!beginRiskyAction(riskKey, "Reset SLO policies", "This requests replacement of configured SLO policies with defaults.")) {
      return;
    }

    setStatus("requesting SLO policy reset");
    setObservabilityResult("");

    try {
      const response = await fetch("/api/observability/slo/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_defaults",
          requireApproval: true,
          reason: "Command Center default SLO policy reset request.",
        }),
      });
      const data = await response.json();
      setObservabilityResult(formatToolResult(data));
      if (data.policies) {
        setSloPolicyState(data);
        setObservabilitySloState(data.snapshot);
        if (data.policies[0]) {
          loadSloPolicyForm(data.policies[0]);
        }
      }
      setStatus(response.ok ? "SLO policy reset requested" : "SLO policy reset request failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "SLO policy reset request failed");
    } finally {
      endRiskyAction(riskKey);
    }
  }

  async function saveSloApprovalPolicy() {
    if (!sloApprovalPolicy) {
      return;
    }

    setStatus("updating SLO approval policy");
    setObservabilityResult("");

    const lowQuorum = parseBoundedInt(sloLowRiskQuorum, 1, 1, 5);
    const highQuorum = parseBoundedInt(sloHighRiskQuorum, 2, 1, 5);
    const reasonMinLength = parseBoundedInt(sloBreakGlassReasonMin, 24, 12, 1000);
    const lowTemplate = findSloApprovalRule(sloApprovalPolicy, "risk_2_standard", 2);
    const highTemplate = findSloApprovalRule(sloApprovalPolicy, "risk_3_high", 3);
    const rollbackTemplate =
      sloApprovalPolicy.rules.find((rule) => rule.id === "rollback_policy" || rule.action === "rollback_policy") ||
      highTemplate;
    const preservedRules = sloApprovalPolicy.rules.filter((rule) =>
      rule.id !== "risk_2_standard" &&
      rule.id !== "risk_3_high" &&
      rule.id !== "rollback_policy" &&
      rule.action !== "rollback_policy" &&
      !(rule.action === "any" && (rule.riskLevel === 2 || rule.riskLevel === 3))
    );
    const policy: ObservabilitySloApprovalPolicyConfig = {
      ...sloApprovalPolicy,
      rules: [
        {
          ...(rollbackTemplate || createDefaultSloApprovalRule("rollback_policy", 3)),
          id: "rollback_policy",
          action: "rollback_policy",
          riskLevel: 3,
          quorum: highQuorum,
          requiredRoles: normalizeApprovalRoles(rollbackTemplate?.requiredRoles, ["admin", "system"]),
          allowRequesterApproval: false,
          attestationRequired: sloRollbackAttestation,
          breakGlassAllowed: sloBreakGlassEnabled,
        },
        {
          ...(highTemplate || createDefaultSloApprovalRule("risk_3_high", 3)),
          id: "risk_3_high",
          action: "any",
          riskLevel: 3,
          quorum: highQuorum,
          requiredRoles: normalizeApprovalRoles(highTemplate?.requiredRoles, ["admin", "system"]),
          allowRequesterApproval: false,
          breakGlassAllowed: sloBreakGlassEnabled,
        },
        {
          ...(lowTemplate || createDefaultSloApprovalRule("risk_2_standard", 2)),
          id: "risk_2_standard",
          action: "any",
          riskLevel: 2,
          quorum: lowQuorum,
          requiredRoles: normalizeApprovalRoles(lowTemplate?.requiredRoles, ["operator", "admin", "system"]),
          allowRequesterApproval: true,
          attestationRequired: false,
          breakGlassAllowed: false,
        },
        ...preservedRules,
      ],
      breakGlass: {
        ...sloApprovalPolicy.breakGlass,
        enabled: sloBreakGlassEnabled,
        reasonMinLength,
      },
      metadata: {
        ...sloApprovalPolicy.metadata,
        managedBy: "command-center",
      },
    };

    try {
      const response = await fetch("/api/observability/slo/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_approval_policy",
          policy,
          reason: "Command Center SLO approval policy administration update.",
        }),
      });
      const data = await response.json();
      setObservabilityResult(formatToolResult(data));
      if (data.approvalPolicy) {
        setSloPolicyState(data);
        setObservabilitySloState(data.snapshot);
        loadSloApprovalPolicyForm(data.approvalPolicy);
      }
      setStatus(response.ok ? "SLO approval policy updated" : "SLO approval policy update failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "SLO approval policy update failed");
    }
  }

  async function resetSloApprovalPolicy() {
    const riskKey = "slo-approval-policy-reset";
    if (!beginRiskyAction(riskKey, "Reset SLO approval policy", "This resets approval quorum, attestation, and break-glass administration rules.")) {
      return;
    }

    setStatus("resetting SLO approval policy");
    setObservabilityResult("");

    try {
      const response = await fetch("/api/observability/slo/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_approval_policy",
          reason: "Command Center SLO approval policy administration reset.",
        }),
      });
      const data = await response.json();
      setObservabilityResult(formatToolResult(data));
      if (data.approvalPolicy) {
        setSloPolicyState(data);
        setObservabilitySloState(data.snapshot);
        loadSloApprovalPolicyForm(data.approvalPolicy);
      }
      setStatus(response.ok ? "SLO approval policy reset" : "SLO approval policy reset failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "SLO approval policy reset failed");
    } finally {
      endRiskyAction(riskKey);
    }
  }

  function toggleSloTarget(targetId: string) {
    setSloTargetIds((current) =>
      current.includes(targetId)
        ? current.filter((id) => id !== targetId)
        : [...current, targetId],
    );
  }

  function applyConnectionTemplate(template: ConnectionCatalogItem) {
    const authEnv = template.authEnvVars[0] || "";

    if (template.adapter === "mcp") {
      setConnectorName(template.name);
      setConnectorEndpoint(template.endpoint || "https://example.com/mcp");
      setConnectorAuthEnv(authEnv);
      setConnectorResult(`Applied ${template.name} MCP template`);
      return;
    }

    setOpenApiName(template.name);
    setOpenApiSpecUrl("");
    setOpenApiBaseUrl(template.baseUrl || "");
    setOpenApiAuthEnv(authEnv);
    setOpenApiAuthHeader(template.authHeaderName || "authorization");
    setOpenApiResult(`Applied ${template.name} OpenAPI template`);
  }

  async function loadEvaluationRunDetail(runId: string, quiet = false) {
    setSelectedEvaluationRunId(runId);
    if (!quiet) {
      setStatus("loading evaluation detail");
    }

    try {
      const response = await fetch(`/api/evaluations/${runId}`);
      const data = (await response.json()) as EvalRunDetail & { error?: string };
      if (!response.ok) {
        setEvaluationResult(formatToolResult(data));
        if (!quiet) {
          setStatus(data.error || "evaluation detail failed");
        }
        return;
      }

      setSelectedEvaluationDetail(data);
      setEvaluationDetailFilter("all");
      await loadEvaluationReports(runId, true);
      if (!quiet) {
        setStatus("evaluation detail loaded");
      }
    } catch (error) {
      if (!quiet) {
        setStatus(error instanceof Error ? error.message : "evaluation detail failed");
      }
    }
  }

  async function loadEvaluationReports(runId: string, quiet = true) {
    try {
      const response = await fetch(`/api/evaluations/${runId}/report`);
      const data = (await response.json()) as EvalReportResponse;
      if (!response.ok) {
        if (!quiet) {
          setEvaluationReportResult(formatToolResult(data));
        }
        return;
      }

      const reports = data.reports || (data.latest ? [data.latest] : []);
      setEvaluationReportsByRun((current) => ({
        ...current,
        [runId]: reports,
      }));
    } catch (error) {
      if (!quiet) {
        setEvaluationReportResult(error instanceof Error ? error.message : "evaluation reports failed");
      }
    }
  }

  async function createEvaluationReport(runId: string) {
    if (!runId) {
      return;
    }

    setStatus("creating evaluation report");
    setEvaluationReportResult("");

    try {
      const response = await fetch(`/api/evaluations/${runId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Command Center signed evaluation report snapshot." }),
      });
      const data = (await response.json()) as EvalReportResponse;
      if (!response.ok || !data.report) {
        setEvaluationReportResult(formatToolResult(data));
        setStatus(data.error || "evaluation report failed");
        return;
      }

      setEvaluationReportsByRun((current) => ({
        ...current,
        [runId]: [
          data.report as EvalReportSnapshot,
          ...(current[runId] || []).filter((report) => report.id !== data.report?.id),
        ].slice(0, 5),
      }));
      setEvaluationReportResult(formatToolResult({
        reportId: data.report.id,
        format: data.report.format,
        reportVersion: data.report.reportVersion,
        signature: data.report.signature,
        createdAt: data.report.createdAt,
      }));
      setStatus("evaluation report signed");
      await loadEvaluationReports(runId, true);
    } catch (error) {
      setEvaluationReportResult(error instanceof Error ? error.message : "evaluation report failed");
      setStatus(error instanceof Error ? error.message : "evaluation report failed");
    }
  }

  async function downloadEvaluationReport(runId: string, reportId?: string) {
    if (!runId) {
      return;
    }

    const query = new URLSearchParams({ download: "1" });
    if (reportId) {
      query.set("reportId", reportId);
    }

    setStatus("downloading evaluation report");

    try {
      const response = await fetch(`/api/evaluations/${runId}/report?${query.toString()}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "evaluation report download failed" })) as { error?: string };
        setEvaluationReportResult(formatToolResult(error));
        setStatus(error.error || "evaluation report download failed");
        return;
      }

      const blob = await response.blob();
      const filename = extractDownloadFilename(
        response.headers.get("Content-Disposition"),
        `omniagent-eval-${runId}.json`,
      );
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);

      setEvaluationReportResult(formatToolResult({
        downloaded: filename,
        signature: response.headers.get("X-Omni-Report-Signature") || undefined,
      }));
      setStatus("evaluation report downloaded");
    } catch (error) {
      setEvaluationReportResult(error instanceof Error ? error.message : "evaluation report download failed");
      setStatus(error instanceof Error ? error.message : "evaluation report download failed");
    }
  }

  async function verifyEvaluationReport(runId: string, reportId?: string) {
    if (!runId || !reportId) {
      return;
    }

    const query = new URLSearchParams({ reportId });
    setStatus("verifying evaluation report");
    setEvaluationReportResult("");

    try {
      const response = await fetch(`/api/evaluations/${runId}/report/verify?${query.toString()}`);
      const data = (await response.json()) as EvalReportResponse;
      if (!response.ok || !data.verification) {
        setEvaluationReportResult(formatToolResult(data));
        setStatus(data.error || "evaluation report verification failed");
        return;
      }

      setEvaluationReportResult(formatToolResult({
        verification: data.verification,
        keyring: data.keyring,
      }));
      setStatus(data.verification.valid ? "evaluation report verified" : "evaluation report invalid");
    } catch (error) {
      setEvaluationReportResult(error instanceof Error ? error.message : "evaluation report verification failed");
      setStatus(error instanceof Error ? error.message : "evaluation report verification failed");
    }
  }

  async function runEvaluations(mode: "safe" | "gated") {
    const gated = mode === "gated";
    if (gated && !canRunGatedEvaluations) {
      setEvaluationResult(formatToolResult({
        error: "Evaluation override incomplete",
        requirement: gatedEvaluationBlocker,
        role: evaluationRole,
      }));
      setStatus("evaluation override incomplete");
      return;
    }

    setStatus(gated ? "running gated evaluations" : "running safe evaluations");
    setEvaluationResult("");

    try {
      const response = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gated
          ? {
              suite: "command-center-gated",
              maxSafetyMode: "mutation_allowed",
              allowMutation: true,
              reason: evaluationOverrideReasonText,
            }
          : {
              suite: "command-center-safe",
              maxSafetyMode: evaluationSafeSafetyMode,
            }),
      });
      const data = (await response.json()) as EvalRunDetail;
      setEvaluationResult(formatToolResult(data));
      setStatus(data.run?.status ? `evaluations ${data.run.status}` : response.ok ? "evaluations complete" : "evaluations failed");
      if (data.run?.id) {
        await loadEvaluationRunDetail(data.run.id, true);
      }
      if (gated && response.ok) {
        setEvaluationAllowMutation(false);
      }
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "evaluation run failed");
    }
  }

  async function createIdentityUser() {
    const email = identityEmail.trim();
    if (!email) {
      return;
    }

    setIdentityResult("creating user");

    try {
      const response = await fetch("/api/auth/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: identityName.trim() || undefined,
          role: identityRole,
          password: identityPassword.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || data.error || "User creation failed.");
      }

      setIdentityEmail("");
      setIdentityName("");
      setIdentityPassword("");
      setIdentityResult(
        data.generatedPassword
          ? `created ${data.user.email}; temporary password ${data.generatedPassword}`
          : `created ${data.user.email}`,
      );
      setAuthControlPlane(data.controlPlane || null);
      refreshSecurity();
    } catch (error) {
      setIdentityResult(error instanceof Error ? error.message : "User creation failed.");
    }
  }

  async function refreshAuth() {
    try {
      const data = (await fetch("/api/auth/session").then((response) => response.json())) as AuthSessionResponse;
      setAuthState(data);

      if (!data.authEnabled || data.authenticated) {
        refreshAuthControlPlane();
      } else {
        setAuthControlPlane(null);
      }

      return data;
    } catch {
      setAuthState({
        authEnabled: false,
        bootstrapConfigured: false,
        authenticated: false,
      });
      return null;
    }
  }

  function refreshAuthControlPlane() {
    fetch("/api/auth/control-plane")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setAuthControlPlane(data))
      .catch(() => undefined);
  }

  function refreshCapabilities() {
    fetch("/api/capabilities")
      .then((response) => response.json())
      .then(setCapabilities)
      .catch(() => undefined);
  }

  function refreshTools() {
    fetch("/api/tools")
      .then((response) => response.json())
      .then(setToolState)
      .catch(() => undefined);
  }

  function refreshConnectors() {
    fetch("/api/connectors")
      .then((response) => response.json())
      .then(setConnectorState)
      .catch(() => undefined);
  }

  function refreshOpenApiConnectors() {
    fetch("/api/openapi-connectors")
      .then((response) => response.json())
      .then(setOpenApiState)
      .catch(() => undefined);
  }

  function refreshWorkflows() {
    fetch("/api/workflows?limit=5")
      .then((response) => response.json())
      .then(setWorkflowState)
      .catch(() => undefined);
  }

  function refreshApprovals() {
    fetch("/api/approvals?limit=8")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setApprovalState(data))
      .catch(() => undefined);
  }

  function refreshOperations() {
    fetch("/api/operations")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setOperationState(data))
      .catch(() => undefined);
  }

  function refreshIncidents() {
    fetch("/api/incidents?status=active&limit=8")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setIncidentState(data))
      .catch(() => undefined);
  }

  function refreshAlerts() {
    fetch("/api/alerts?limit=8")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setAlertState(data))
      .catch(() => undefined);
  }

  function refreshConnectionCatalog() {
    fetch("/api/connection-catalog")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setConnectionCatalog(data))
      .catch(() => undefined);
  }

  function refreshEvaluations() {
    fetch("/api/evaluations?limit=5")
      .then((response) => response.json())
      .then(setEvaluationState)
      .catch(() => undefined);
  }

  function refreshObservability() {
    fetch("/api/observability?limit=8")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setObservabilityState(data))
      .catch(() => undefined);
  }

  function refreshObservabilitySlo() {
    fetch("/api/observability/slo")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setObservabilitySloState(data))
      .catch(() => undefined);
  }

  function refreshSloPolicies() {
    fetch("/api/observability/slo/policies")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) {
          setSloPolicyState(data);
          setObservabilitySloState(data.snapshot);
          const policy = data.policies.find((item: ObservabilitySloPolicy) => item.id === selectedSloPolicyId) || data.policies[0];
          if (policy) {
            loadSloPolicyForm(policy);
          }
          if (data.approvalPolicy) {
            loadSloApprovalPolicyForm(data.approvalPolicy);
          }
        }
      })
      .catch(() => undefined);
  }

  function refreshSecurity() {
    Promise.all([
      fetch("/api/security/context")
        .then((response) => response.json())
        .catch(() => null),
      fetch("/api/security/audits?limit=5")
        .then((response) => response.json())
        .catch(() => null),
    ])
      .then(([contextData, auditData]) => {
        setSecurityState({
          context: contextData?.context,
          stats: auditData?.stats || contextData?.stats,
          records: auditData?.records || contextData?.stats?.latest || [],
          policy: contextData?.policy,
        });
      })
      .catch(() => undefined);
  }

  async function refreshTenantIsolationReport(showResult = false) {
    if (showResult) {
      setTenantIsolationResult("Checking tenant isolation.");
    }

    try {
      const response = await fetch("/api/security/isolation-report");
      const data = response.ok ? await response.json() : null;
      if (data?.report) {
        setTenantIsolationReport(data.report);
        if (showResult) {
          setTenantIsolationResult(`Tenant isolation ${data.report.status}.`);
        }
      } else if (showResult) {
        setTenantIsolationResult("Tenant isolation report unavailable.");
      }
    } catch (error) {
      if (showResult) {
        setTenantIsolationResult(error instanceof Error ? error.message : "Tenant isolation report failed.");
      }
    }
  }

  function refreshWorkspace() {
    refreshCapabilities();
    fetch("/api/memory?limit=5")
      .then((response) => response.json())
      .then((data) => setMemories(data.memories || []))
      .catch(() => undefined);
    fetch("/api/knowledge?limit=5")
      .then((response) => response.json())
      .then((data) => {
        setDocuments(data.documents || []);
        setChunks(data.chunks || []);
      })
      .catch(() => undefined);
    refreshTools();
    refreshConnectors();
    refreshOpenApiConnectors();
    refreshWorkflows();
    refreshApprovals();
    refreshOperations();
    refreshIncidents();
    refreshAlerts();
    refreshConnectionCatalog();
    refreshEvaluations();
    refreshObservability();
    refreshObservabilitySlo();
    refreshSloPolicies();
    refreshSecurity();
    void refreshTenantIsolationReport();
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void initializeWorkspace();
    }, 0);
    return () => window.clearTimeout(timer);
    // Initial workspace load should run once; follow-up refreshes are explicit after mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  if (!authState) {
    return <LoadingShell label="Loading identity" />;
  }

  if (authState.authEnabled && !authState.authenticated) {
    return (
      <AuthGate
        email={authEmail}
        password={authPassword}
        message={authMessage}
        bootstrapConfigured={authState.bootstrapConfigured}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onSubmit={signIn}
      />
    );
  }

  return (
    <main className="min-h-screen subtle-grid px-4 py-4 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-4">
        <header className="panel flex min-w-0 flex-col gap-4 rounded-lg px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-ink">
              <Layers3 size={24} strokeWidth={2.4} />
            </div>
            <div>
              <p className="text-sm font-medium text-primary">OmniAgent OS</p>
              <h1 className="text-2xl font-semibold">Agentic orchestration command center</h1>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 xl:grid-cols-6">
            <StatusPill icon={<Brain size={15} />} label="Memory" value={`${capabilities?.memory.total ?? 0}`} />
            <StatusPill
              icon={<Database size={15} />}
              label="Learned"
              value={`${capabilities?.runs.consolidated.memories ?? 0}`}
            />
            <StatusPill icon={<GitBranch size={15} />} label="Graph" value={`${graphStats?.nodes ?? 0}`} />
            <StatusPill icon={<BookOpen size={15} />} label="Docs" value={`${capabilities?.knowledge.documents ?? 0}`} />
            <StatusPill icon={<Search size={15} />} label="Context" value={`${contextStats?.traces ?? 0}`} />
            <StatusPill icon={<History size={15} />} label="Runs" value={`${capabilities?.runs.total ?? 0}`} />
            <StatusPill icon={<Activity size={15} />} label="Flows" value={`${workflowStats?.active ?? 0}`} />
            <StatusPill icon={<Layers3 size={15} />} label="Plans" value={`${plannerStats?.total ?? 0}`} />
            <StatusPill icon={<CheckCircle2 size={15} />} label="Nodes" value={`${planExecutionStats?.total ?? 0}`} />
            <StatusPill icon={<Cable size={15} />} label="Triggers" value={`${triggerStats?.active ?? 0}`} />
            <StatusPill icon={<Activity size={15} />} label="Health" value={healthStats?.latestStatus || "unknown"} />
            <StatusPill icon={<ShieldCheck size={15} />} label="Incidents" value={`${incidentStats?.active ?? 0}`} />
            <StatusPill icon={<Send size={15} />} label="Alerts" value={`${alertStats?.queued ?? 0}`} />
            <StatusPill
              icon={<BarChart3 size={15} />}
              label="Evals"
              value={`${Math.round((evaluationStats?.latestPassRate ?? 0) * 100)}%`}
            />
            <StatusPill icon={<Cable size={15} />} label="Tools" value={`${governedActiveTools.length || activeTools.length}`} />
            <StatusPill icon={<Cable size={15} />} label="MCP" value={`${connectorStats?.toolCount ?? 0}`} />
            <StatusPill icon={<Globe2 size={15} />} label="REST" value={`${openApiStats?.operationCount ?? 0}`} />
            <StatusPill icon={<ShieldCheck size={15} />} label="Audits" value={`${toolAuditStats?.total ?? 0}`} />
            <StatusPill icon={<CheckCircle2 size={15} />} label="Approval" value={`${approvalStats?.total ?? 0}`} />
            <StatusPill icon={<Users size={15} />} label="Auth" value={authMode} />
            <StatusPill icon={<HardDrive size={15} />} label="Store" value={storageLabel} />
            <StatusPill
              icon={<Database size={15} />}
              label="Vector"
              value={capabilities?.vectorStore.configured ? "HNSW" : "JSON"}
            />
            <StatusPill
              icon={<Sparkles size={15} />}
              label="OpenAI"
              value={capabilities?.openaiConfigured ? "Live" : "Fallback"}
            />
          </div>
        </header>

        <section className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="panel flex min-h-[680px] min-w-0 flex-col rounded-lg">
            <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm text-muted">Run state</p>
                <p className="font-mono text-sm text-accent" role="status" aria-live="polite" aria-atomic="true">
                  {riskActionInFlight ? `${status} (${riskActionInFlight})` : status}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {modes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className={clsx(
                      "h-9 rounded-md border px-3 text-sm transition",
                      mode === item.id
                        ? "border-primary bg-primary text-primary-ink"
                        : "border-line bg-surface text-muted hover:border-primary hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={viewportRef}
              className="flex-1 overflow-y-auto px-5 py-5"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
            >
              <div className="flex flex-col gap-4">
                {messages.map((message, index) => (
                  <article
                    key={`${message.role}-${index}`}
                    className={clsx(
                      "max-w-[86%] rounded-lg border px-4 py-3",
                      message.role === "user"
                        ? "ml-auto border-primary/40 bg-primary/12"
                        : "border-line bg-background/62",
                    )}
                  >
                    <div className="mb-2 flex items-center gap-2 text-xs uppercase text-muted">
                      {message.role === "user" ? <Send size={13} /> : <Activity size={13} />}
                      {message.role}
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                      {message.content || (isRunning ? "Thinking..." : "")}
                    </p>
                  </article>
                ))}
              </div>
            </div>

            <form onSubmit={submitMessage} className="border-t border-line p-4">
              <label className="mb-2 block text-sm text-muted" htmlFor="agent-command">
                Command
              </label>
              <div className="flex flex-col gap-3 md:flex-row">
                <textarea
                  id="agent-command"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  className="min-h-24 flex-1 resize-none rounded-md border border-line bg-background px-3 py-3 text-sm leading-6 outline-none transition placeholder:text-muted focus:border-primary"
                  placeholder="Give the agent a goal..."
                />
                <button
                  type="submit"
                  disabled={isRunning}
                  className="flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 font-medium text-primary-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 md:self-end"
                >
                  <Play size={17} />
                  Run
                </button>
              </div>
            </form>
          </div>

          <aside className="flex min-w-0 flex-col gap-4">
            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <History className="text-primary" size={18} />
                <h2 className="font-semibold">Run ledger</h2>
              </div>
              <div className="flex flex-col gap-3">
                {latestRuns.length ? (
                  latestRuns.map((run) => <RunRow key={run.id} run={run} />)
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No runs recorded yet.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <BarChart3 className="text-primary" size={18} />
                <h2 className="font-semibold">Observability console</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Events" value={`${observabilityStats?.total ?? 0}`} />
                <MiniStat label="Errors" value={`${observabilityStats?.byLevel.error ?? 0}`} />
                <MiniStat label="Failures" value={`${observabilityStats?.routeFailures ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="SLO" value={observabilityStats?.slo.healthy ? "healthy" : "watch"} />
                <MiniStat label="Avail" value={`${Math.round((observabilityStats?.slo.availability ?? 1) * 1000) / 10}%`} />
                <MiniStat label="P95" value={`${observabilityStats?.p95DurationMs ?? 0}ms`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Breaches" value={`${observabilityBreaches.length}`} />
                <MiniStat label="Policies" value={`${observabilitySlo?.policies.length ?? 0}`} />
                <MiniStat label="Checked" value={observabilitySlo?.checkedAt ? new Date(observabilitySlo.checkedAt).toLocaleTimeString() : "never"} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Pending" value={`${pendingSloPolicyChanges.length}`} />
                <MiniStat label="Changes" value={`${sloPolicyChanges.length}`} />
                <MiniStat label="Governed" value={`${approvalStats?.sloPolicies ?? pendingSloPolicyChanges.length}`} />
              </div>
	              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
	                <MiniStat label="API" value={`${observabilityStats?.byCategory.api ?? 0}`} />
	                <MiniStat label="Workflow" value={`${observabilityStats?.byCategory.workflow ?? 0}`} />
	                <MiniStat label="Conn" value={`${observabilityStats?.byCategory.connector ?? 0}`} />
	              </div>
	              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
	                <MiniStat label="Auth" value={`${observabilityStats?.authFailures ?? 0}`} />
	                <MiniStat label="Policy" value={`${observabilityStats?.policyBlocks ?? 0}`} />
	                <MiniStat label="Conn fail" value={`${observabilityStats?.connectorFailures ?? 0}`} />
	              </div>
              <button
                type="button"
                onClick={runSloMonitor}
                disabled={Boolean(riskActionInFlight)}
                className="mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Activity size={14} />
                Run SLO monitor
              </button>
              {selectedSloPolicy ? (
                <div className="mb-3 rounded-md border border-line bg-background/54 p-3">
                  <div className="mb-2 grid grid-cols-1 gap-2">
                    <select
                      value={selectedSloPolicy.id}
                      onChange={(event) => {
                        const policy = sloPolicies.find((item) => item.id === event.target.value);
                        if (policy) {
                          loadSloPolicyForm(policy);
                        }
                      }}
                      className="h-9 rounded-md border border-line bg-background px-2 text-xs outline-none focus:border-primary"
                      aria-label="SLO policy"
                    >
                      {sloPolicies.map((policy) => (
                        <option key={policy.id} value={policy.id}>
                          {policy.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <input
                      value={sloWarningThreshold}
                      onChange={(event) => setSloWarningThreshold(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="Warning threshold"
                      inputMode="decimal"
                    />
                    <input
                      value={sloCriticalThreshold}
                      onChange={(event) => setSloCriticalThreshold(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="Critical threshold"
                      inputMode="decimal"
                    />
                  </div>
                  <div className="mb-2 grid grid-cols-3 gap-2">
                    <select
                      value={sloWarningSeverity}
                      onChange={(event) => setSloWarningSeverity(event.target.value as IncidentSeverity)}
                      className="h-9 rounded-md border border-line bg-background px-2 text-xs outline-none focus:border-primary"
                      aria-label="Warning severity"
                    >
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="critical">critical</option>
                    </select>
                    <select
                      value={sloCriticalSeverity}
                      onChange={(event) => setSloCriticalSeverity(event.target.value as IncidentSeverity)}
                      className="h-9 rounded-md border border-line bg-background px-2 text-xs outline-none focus:border-primary"
                      aria-label="Critical severity"
                    >
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="critical">critical</option>
                    </select>
                    <input
                      value={sloSuppressionMinutes}
                      onChange={(event) => setSloSuppressionMinutes(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="Suppression minutes"
                      inputMode="numeric"
                    />
                  </div>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {sloAlertTargets.slice(0, 5).map((target) => (
                      <label
                        key={target.id}
                        className={clsx(
                          "flex h-7 items-center gap-1.5 rounded border px-2 text-[11px] transition",
                          sloTargetIds.includes(target.id)
                            ? "border-primary bg-primary/14 text-primary"
                            : "border-line text-muted",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={sloTargetIds.includes(target.id)}
                          onChange={() => toggleSloTarget(target.id)}
                          className="size-3 accent-current"
                        />
                        {target.id}
                      </label>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={sloPolicyEnabled}
                        onChange={(event) => setSloPolicyEnabled(event.target.checked)}
                        className="size-3 accent-current"
                      />
                      Enabled
                    </label>
                    <button
                      type="button"
                      onClick={saveSloPolicy}
                      className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                    >
                      <CheckCircle2 size={14} />
                      Request
                    </button>
                    <button
                      type="button"
                      onClick={resetSloPolicies}
                      disabled={Boolean(riskActionInFlight)}
                      className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <History size={14} />
                      Defaults
                    </button>
                  </div>
                </div>
              ) : null}
              {sloApprovalPolicy ? (
                <div className="mb-3 rounded-md border border-line bg-background/54 p-3">
                  <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                    <MiniStat label="Policy v" value={`${sloApprovalPolicy.version}`} />
                    <MiniStat label="Low q" value={sloLowRiskQuorum} />
                    <MiniStat label="High q" value={sloHighRiskQuorum} />
                  </div>
                  <div className="mb-2 grid grid-cols-3 gap-2">
                    <input
                      value={sloLowRiskQuorum}
                      onChange={(event) => setSloLowRiskQuorum(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="Low risk approval quorum"
                      inputMode="numeric"
                    />
                    <input
                      value={sloHighRiskQuorum}
                      onChange={(event) => setSloHighRiskQuorum(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="High risk approval quorum"
                      inputMode="numeric"
                    />
                    <input
                      value={sloBreakGlassReasonMin}
                      onChange={(event) => setSloBreakGlassReasonMin(event.target.value)}
                      className="h-9 rounded-md border border-line bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                      aria-label="Break glass rationale minimum"
                      inputMode="numeric"
                    />
                  </div>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <label className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={sloRollbackAttestation}
                        onChange={(event) => setSloRollbackAttestation(event.target.checked)}
                        className="size-3 accent-current"
                      />
                      Attest
                    </label>
                    <label className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={sloBreakGlassEnabled}
                        onChange={(event) => setSloBreakGlassEnabled(event.target.checked)}
                        className="size-3 accent-current"
                      />
                      Emergency
                    </label>
                  </div>
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={saveSloApprovalPolicy}
                      className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                    >
                      <ShieldCheck size={14} />
                      Save policy
                    </button>
                    <button
                      type="button"
                      onClick={resetSloApprovalPolicy}
                      disabled={Boolean(riskActionInFlight)}
                      className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <History size={14} />
                      Reset policy
                    </button>
                  </div>
                  {sloApprovalPolicyVersions.length ? (
                    <div className="grid grid-cols-1 gap-1.5 font-mono text-[10px] text-muted">
                      {sloApprovalPolicyVersions.slice(0, 3).map((version) => (
                        <div key={version.id} className="flex min-w-0 items-center justify-between gap-3 rounded border border-line px-2 py-1.5">
                          <span className="shrink-0">v{version.version}</span>
                          <span className="truncate">{version.changedBy || "system"}</span>
                          <span className="shrink-0">{version.evidenceHash.slice(0, 10)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {sloPolicyChanges.length ? (
                <div className="mb-3 flex flex-col gap-2">
                  {sloPolicyChanges.slice(0, 3).map((change) => (
                    <SloPolicyChangeRow key={change.id} change={change} />
                  ))}
                </div>
              ) : null}
              {observabilityResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {observabilityResult}
                </pre>
              ) : null}
              <div className="flex flex-col gap-3">
                {observabilitySlo?.evaluations.length ? (
                  observabilitySlo.evaluations.slice(0, 4).map((evaluation) => (
                    <SloPolicyRow key={evaluation.policy.id} evaluation={evaluation} />
                  ))
                ) : null}
                {latestObservabilityEvents.length ? (
                  latestObservabilityEvents.slice(0, 8).map((event) => (
                    <ObservabilityEventRow key={event.id} event={event} />
                  ))
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No runtime events recorded yet.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Operations center</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Approvals" value={`${operationSummary?.pendingApprovals ?? approvalStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${operationSummary?.activeWorkflows ?? workflowStats?.active ?? 0}`} />
                <MiniStat label="Live risk" value={`${liveWorkflowRisks}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Tool fail" value={`${operationSummary?.failedTools ?? 0}`} />
                <MiniStat label="Hist fail" value={`${historicalFailedWorkflows}`} />
                <MiniStat label="Connectors" value={`${operationSummary?.connectorErrors ?? 0} errors`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Queued" value={`${operationSummary?.queuedJobs ?? queueStats?.byStatus.queued ?? 0}`} />
                <MiniStat label="Runnable" value={`${operationSummary?.runnableJobs ?? queueStats?.runnable ?? 0}`} />
                <MiniStat label="Leases" value={`${operationSummary?.expiredLeases ?? queueStats?.expiredLeases ?? 0} stale`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Stale" value={`${operationSummary?.staleWorkflows ?? operationRecovery?.staleWorkflows.length ?? 0}`} />
                <MiniStat label="Unhandled" value={`${recentUnhandledWorkflowFailures}`} />
                <MiniStat label="Recovered" value={`${recoveredWorkflowFailures}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Requeued" value={`${operationRecovery?.requeuedWorkflows ?? 0}`} />
                <MiniStat label="Recov fail" value={`${operationRecovery?.failedWorkflows ?? 0}`} />
                <MiniStat label="Runs" value={`${operationSummary?.runningRuns ?? 0} running`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Health" value={healthStats?.latestStatus || "unknown"} />
                <MiniStat label="Incidents" value={`${healthStats?.incidents ?? 0}`} />
                <MiniStat label="Recoveries" value={`${healthStats?.recoveryActions ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Open" value={`${incidentStats?.open ?? 0}`} />
                <MiniStat label="Ack" value={`${incidentStats?.acknowledged ?? 0}`} />
                <MiniStat label="Critical" value={`${incidentStats?.criticalOpen ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Alerts" value={`${alertStats?.queued ?? 0} queued`} />
                <MiniStat label="Sent" value={`${alertStats?.delivered ?? 0}`} />
                <MiniStat label="External" value={`${alertStats?.configuredExternalTargets ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Cron" value={alertScheduler?.enabled ? "enabled" : "secret"} />
                <MiniStat label="Schedule" value={alertScheduler?.schedule || "0 0 * * *"} />
                <MiniStat label="Limits" value={`${alertScheduler?.queueLimit ?? 10}/${alertScheduler?.dispatchLimit ?? 10}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Targets" value={`${alertStats?.readyTargets ?? 0} ready`} />
                <MiniStat label="Blocked" value={`${alertStats?.blockedExternalTargets ?? 0}`} />
                <MiniStat label="Retryable" value={`${alertStats?.retryableFailed ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => runDiagnostics(false)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary"
                >
                  <Activity size={14} />
                  Diagnostics
                </button>
                <button
                  type="button"
                  onClick={() => runDiagnostics(true)}
                  disabled={Boolean(riskActionInFlight)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Repair
                </button>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => runOperationsRecovery("inspect_recovery")}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary"
                >
                  <Search size={14} />
                  Inspect
                </button>
                <button
                  type="button"
                  onClick={() => runOperationsRecovery("repair_recovery")}
                  disabled={Boolean(riskActionInFlight)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Recover
                </button>
                <button
                  type="button"
                  onClick={() => runOperationsRecovery("drain_recovery")}
                  disabled={Boolean(riskActionInFlight)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Activity size={14} />
                  Drain
                </button>
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => runAlertAction("enqueue_active")}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary"
                >
                  <Send size={14} />
                  Queue alerts
                </button>
                <button
                  type="button"
                  onClick={() => runAlertAction("dispatch")}
                  disabled={Boolean(riskActionInFlight)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Activity size={14} />
                  Dispatch
                </button>
              </div>
              <button
                type="button"
                onClick={runAlertScheduler}
                disabled={Boolean(riskActionInFlight)}
                className="mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Activity size={14} />
                Scheduler tick
              </button>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => runAlertAction("probe_targets")}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-foreground transition hover:border-primary"
                >
                  <Search size={14} />
                  Probe targets
                </button>
                <button
                  type="button"
                  onClick={() => runAlertAction("retry_failed")}
                  disabled={Boolean(riskActionInFlight)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <History size={14} />
                  Retry failed
                </button>
              </div>
              {diagnosticsResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {diagnosticsResult}
                </pre>
              ) : null}
              {operationResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {operationResult}
                </pre>
              ) : null}
              <div className="mb-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Recovery history</p>
                  <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
                    {latestRecoveryEvents.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {latestRecoveryEvents.length ? (
                    latestRecoveryEvents.slice(0, 5).map((event) => (
                      <WorkflowRecoveryEventRow key={event.id} event={event} />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No recovery history.
                    </p>
                  )}
                </div>
              </div>
              {incidentResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {incidentResult}
                </pre>
              ) : null}
              {alertResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {alertResult}
                </pre>
              ) : null}
              {approvalResult ? (
                <pre className="mb-3 max-h-44 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                  {approvalResult}
                </pre>
              ) : null}
              <div className="flex flex-col gap-3">
                {activeIncidents.length ? (
                  activeIncidents.slice(0, 5).map((incident) => (
                    <IncidentRow
                      key={incident.id}
                      incident={incident}
                      onAction={handleIncidentAction}
                    />
                  ))
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No active incidents.
                  </p>
                )}
                {latestAlertDeliveries.length ? (
                  latestAlertDeliveries.slice(0, 4).map((delivery) => (
                    <AlertDeliveryRow key={delivery.id} delivery={delivery} />
                  ))
                ) : null}
                {alertTargetHealth.length ? (
                  alertTargetHealth.slice(0, 5).map((target) => (
                    <AlertTargetHealthRow key={target.id} target={target} />
                  ))
                ) : null}
                {approvalQueue.length ? (
                  approvalQueue.slice(0, 6).map((item) => (
                    <ApprovalQueueRow
                      key={`${item.kind}:${item.id}`}
                      item={item}
                      onDecide={decideApproval}
                    />
                  ))
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No pending approvals.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Activity className="text-primary" size={18} />
                <h2 className="font-semibold">Workflow runtime</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Total" value={`${workflowStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${workflowStats?.active ?? 0}`} />
                <MiniStat label="Approval" value={`${workflowStats?.waitingApproval ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Live risk" value={`${liveWorkflowRisks}`} />
                <MiniStat label="Hist fail" value={`${historicalFailedWorkflows}`} />
                <MiniStat label="Recovered" value={`${recoveredWorkflowFailures}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Queue" value={`${queueStats?.byStatus.queued ?? 0}`} />
                <MiniStat label="Running" value={`${queueStats?.byStatus.running ?? 0}`} />
                <MiniStat label="Failed jobs" value={`${queueStats?.byStatus.failed ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Plans" value={`${plannerStats?.total ?? 0}`} />
                <MiniStat label="Risk" value={`${plannerStats?.highRisk ?? 0}`} />
                <MiniStat label="Conf" value={`${Math.round((plannerStats?.averageConfidence ?? 0) * 100)}%`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Nodes" value={`${planExecutionStats?.total ?? 0}`} />
                <MiniStat label="Dry-runs" value={`${planExecutionStats?.dryRunTools ?? 0}`} />
                <MiniStat label="Live tools" value={`${planExecutionStats?.executedTools ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Triggers" value={`${triggerStats?.total ?? 0}`} />
                <MiniStat label="Events" value={`${triggerStats?.events ?? 0}`} />
                <MiniStat label="Enqueued" value={`${triggerStats?.enqueuedEvents ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <textarea
                  value={workflowGoal}
                  onChange={(event) => setWorkflowGoal(event.target.value)}
                  className="min-h-24 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Workflow goal"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={startWorkflow}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Play size={15} />
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => tickWorkflow()}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <Activity size={15} />
                    Tick queued
                  </button>
                </div>
                {workflowResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {workflowResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestWorkflows.length ? (
                    latestWorkflows.map((workflow) => (
                      <WorkflowRow
                        key={workflow.id}
                        workflow={workflow}
                        onTick={tickWorkflow}
                        onSignal={signalWorkflow}
                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No durable workflows recorded yet.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <BarChart3 className="text-primary" size={18} />
                <h2 className="font-semibold">Evaluation harness</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Pass" value={`${Math.round((evaluationStats?.latestPassRate ?? 0) * 100)}%`} />
                <MiniStat label="Latency" value={`${evaluationStats?.averageLatencyMs ?? 0}ms`} />
                <MiniStat label="Cost" value={`$${(evaluationStats?.estimatedCostUsd ?? 0).toFixed(4)}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Default" value={evaluationDefaultSafetyMode.replace("_", " ")} />
                <MiniStat label="Mutating" value={`${evaluationGovernance?.mutatingCases ?? 0}`} />
                <MiniStat label="Risk" value={`R${evaluationGovernance?.maxRiskLevel ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Read" value={`${evaluationGovernance?.bySafetyMode.read_only ?? 0}`} />
                <MiniStat label="Synthetic" value={`${evaluationGovernance?.bySafetyMode.synthetic ?? 0}`} />
                <MiniStat label="Gated" value={`${evaluationGovernance?.bySafetyMode.mutation_allowed ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => runEvaluations("safe")}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Play size={15} />
                    Safe suite
                  </button>
                  <button
                    type="button"
                    disabled={!canRunGatedEvaluations}
                    onClick={() => runEvaluations("gated")}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-danger/60 text-sm font-medium text-danger transition hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <ShieldCheck size={15} />
                    Gated suite
                  </button>
                </div>
                <div className="rounded-md border border-line bg-background/54 p-3">
                  <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                    <MiniStat label="Safe" value={`${safeEvaluationCases.length}`} />
                    <MiniStat label="Gated" value={`${gatedEvaluationCases.length}`} />
                    <MiniStat label="Role" value={evaluationRole} />
                  </div>
                  <label className="mb-3 flex items-center justify-between gap-3 text-xs text-muted">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={evaluationAllowMutation}
                        onChange={(event) => setEvaluationAllowMutation(event.target.checked)}
                        className="size-4 accent-primary"
                        aria-label="Allow mutation evaluations"
                      />
                      Allow mutation
                    </span>
                    <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", canRunGatedEvaluations ? "bg-primary/16 text-primary" : "bg-accent/14 text-accent")}>
                      {gatedEvaluationBlocker}
                    </span>
                  </label>
                  <textarea
                    value={evaluationOverrideReason}
                    onChange={(event) => setEvaluationOverrideReason(event.target.value)}
                    className="min-h-20 w-full resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                    placeholder="Override reason"
                    aria-label="Evaluation override reason"
                  />
                </div>
                {evaluationResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {evaluationResult}
                  </pre>
                ) : null}
                {selectedEvaluationDetail ? (
                  <EvaluationRunDetailPanel
                    detail={selectedEvaluationDetail}
                    caseEvidence={filteredEvaluationCaseEvidence}
                    filter={evaluationDetailFilter}
                    reports={selectedEvaluationReports}
                    reportResult={evaluationReportResult}
                    onFilterChange={setEvaluationDetailFilter}
                    onCreateReport={createEvaluationReport}
                    onDownloadReport={downloadEvaluationReport}
                    onVerifyReport={verifyEvaluationReport}
                  />
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestEvaluations.length ? (
                    latestEvaluations.map((run) => (
                      <EvaluationRunRow
                        key={run.id}
                        run={run}
                        selected={selectedEvaluationRunId === run.id}
                        onSelect={loadEvaluationRunDetail}
                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No evaluation runs recorded yet.
                    </p>
                  )}
                  {latestEvaluationCases.map((evalCase) => (
                    <EvaluationCaseRow key={evalCase.id} evalCase={evalCase} />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Security controls</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Role" value={securityContext?.role || "unknown"} />
                <MiniStat label="Allow" value={`${securityStats?.byDecision.allow ?? 0}`} />
                <MiniStat label="Deny" value={`${securityStats?.byDecision.deny ?? 0}`} />
              </div>
	              <div className="mb-3 rounded-md border border-line bg-background/54 p-3">
	                <div className="grid grid-cols-2 gap-3 text-xs">
	                  <div className="min-w-0">
	                    <p className="text-muted">Tenant</p>
                    <p className="mt-1 truncate font-mono text-foreground">{securityContext?.tenantId || "default"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted">Actor</p>
                    <p className="mt-1 truncate font-mono text-foreground">{securityContext?.actorId || "anonymous"}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(securityPolicy?.secretVault.disallowedPrefixes || []).map((prefix) => (
                    <span key={prefix} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      block {prefix}
                    </span>
                  ))}
                  <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    env refs only
	                  </span>
	                </div>
	              </div>
	              <div className="mb-3 rounded-md border border-line bg-background/54 p-3">
	                <div className="mb-3 flex items-center justify-between gap-3">
	                  <div className="min-w-0">
	                    <p className="text-xs text-muted">Tenant isolation</p>
	                    <p className="mt-1 truncate text-sm font-medium text-foreground">
	                      {tenantIsolationReport?.status || "unchecked"}
	                    </p>
	                  </div>
	                  <button
	                    type="button"
	                    onClick={() => void refreshTenantIsolationReport(true)}
	                    className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
	                  >
	                    <ShieldCheck size={13} />
	                    Verify
	                  </button>
	                </div>
	                <div className="grid grid-cols-3 gap-2 text-xs">
	                  <MiniStat label="Tables" value={`${tenantIsolationReport?.summary.protectedTables ?? 0}/${tenantIsolationReport?.summary.expectedTables ?? 0}`} />
	                  <MiniStat label="Child" value={`${tenantIsolationReport?.summary.childTables ?? 0}`} />
	                  <MiniStat label="Failing" value={`${tenantIsolationReport?.summary.failingTables ?? 0}`} />
	                </div>
	                <div className="mt-3 flex flex-wrap gap-1.5">
	                  <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", isolationTone(tenantIsolationReport?.status))}>
	                    {tenantIsolationReport?.databaseConfigured ? "db enforced" : "db missing"}
	                  </span>
	                  <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", resultTone(tenantIsolationLatestEval?.resultStatus))}>
	                    eval {tenantIsolationLatestEval?.resultStatus || "none"}
	                  </span>
	                  <span className="rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
	                    {tenantIsolationReport?.checkedAt ? new Date(tenantIsolationReport.checkedAt).toLocaleTimeString() : "not checked"}
	                  </span>
	                </div>
	                {tenantIsolationFailingTables.length ? (
	                  <p className="mt-3 line-clamp-2 text-xs leading-5 text-danger">
	                    {tenantIsolationFailingTables.slice(0, 4).map((table) => table.tableName).join(", ")}
	                  </p>
	                ) : (
	                  <p className="mt-3 text-xs leading-5 text-muted">
	                    {tenantIsolationReport?.recommendations[0] || "Awaiting tenant isolation evidence."}
	                  </p>
	                )}
	                {tenantIsolationResult ? (
	                  <p className="mt-2 rounded border border-line bg-background px-2 py-1.5 text-xs text-muted">
	                    {tenantIsolationResult}
	                  </p>
	                ) : null}
	              </div>
	              <div className="flex flex-col gap-3">
	                {securityRules.map((rule) => (
	                  <RbacRuleRow key={rule.action} rule={rule} />
                ))}
                {latestSecurityAudits.length ? (
                  latestSecurityAudits.map((record) => <SecurityAuditRow key={record.id} record={record} />)
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No security audits recorded yet.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Users className="text-primary" size={18} />
                  <h2 className="font-semibold">Identity control</h2>
                </div>
                <button
                  type="button"
                  onClick={signOut}
                  className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
                >
                  <LogOut size={13} />
                  Sign out
                </button>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Mode" value={authMode} />
                <MiniStat label="Users" value={`${authStats?.users ?? 0}`} />
                <MiniStat label="Sessions" value={`${authStats?.sessions ?? 0}`} />
              </div>
              <div className="mb-3 rounded-md border border-line bg-background/54 p-3 text-xs">
                <p className="text-muted">Current identity</p>
                <p className="mt-1 truncate font-mono text-foreground">{currentIdentity}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <span className="rounded border border-line px-1.5 py-1 font-mono text-[10px] text-muted">
                    {authState.tenant?.name || securityContext?.tenantId || "default"}
                  </span>
                  <span className="rounded border border-line px-1.5 py-1 font-mono text-[10px] text-muted">
                    {authState.membership?.role || securityContext?.role || "admin"}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={identityEmail}
                  onChange={(event) => setIdentityEmail(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="user@example.com"
                  aria-label="New user email"
                />
                <input
                  value={identityName}
                  onChange={(event) => setIdentityName(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="Display name"
                  aria-label="New user display name"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={identityRole}
                    onChange={(event) => setIdentityRole(event.target.value as SecurityRole)}
                    className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                    aria-label="New user role"
                  >
                    <option value="viewer">viewer</option>
                    <option value="operator">operator</option>
                    <option value="admin">admin</option>
                  </select>
                  <input
                    value={identityPassword}
                    onChange={(event) => setIdentityPassword(event.target.value)}
                    className="h-10 min-w-0 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                    placeholder="Password"
                    type="password"
                    aria-label="New user password"
                  />
                </div>
                <button
                  type="button"
                  onClick={createIdentityUser}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                >
                  <UserPlus size={15} />
                  Create user
                </button>
                {identityResult ? (
                  <pre className="max-h-32 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {identityResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {authUsers.length ? (
                    authUsers.map((user) => (
                      <AuthUserRow
                        key={user.id}
                        user={user}
                        membership={authControlPlane?.memberships.find((item) => item.userId === user.id)}
                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No identity users recorded yet.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Governed tools</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Audits" value={`${toolAuditStats?.total ?? 0}`} />
                <MiniStat label="Exec" value={`${toolAuditStats?.byStatus.executed ?? 0}`} />
                <MiniStat
                  label="Held"
                  value={`${(toolAuditStats?.byStatus.blocked ?? 0) + (toolAuditStats?.byStatus.approval_required ?? 0)}`}
                />
              </div>
              <div className="flex flex-col gap-3">
                <select
                  value={selectedToolId}
                  onChange={(event) => {
                    const nextToolId = event.target.value;
                    setSelectedToolId(nextToolId);
                    setToolInput(defaultToolInputs[nextToolId] || "{}");
                    setToolResult("");
                  }}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Governed tool"
                >
                  {(toolState?.tools || []).map((tool) => (
                    <option key={tool.id} value={tool.id}>
                      {tool.name}
                    </option>
                  ))}
                </select>
                {selectedTool ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background/54 px-3 py-2 text-xs">
                    <span className="line-clamp-1 text-muted">{selectedTool.description}</span>
                    <span className={clsx("shrink-0 rounded px-2 py-1 font-mono", riskTone(selectedTool.riskLevel))}>
                      R{selectedTool.riskLevel}
                    </span>
                  </div>
                ) : null}
                <textarea
                  value={toolInput}
                  onChange={(event) => setToolInput(event.target.value)}
                  className="min-h-44 resize-y rounded-md border border-line bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-primary"
                  aria-label="Tool input JSON"
                  spellCheck={false}
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => runGovernedTool(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <Search size={15} />
                    Dry run
                  </button>
                  <button
                    type="button"
                    onClick={() => runGovernedTool(false)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Play size={15} />
                    Execute
                  </button>
                </div>
                {toolResult ? (
                  <pre className="max-h-52 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {toolResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestToolAudits.length ? (
                    latestToolAudits.map((record) => <ToolAuditRow key={record.id} record={record} />)
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No tool audits recorded yet.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Cable className="text-primary" size={18} />
                <h2 className="font-semibold">Connection catalog</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Targets" value={`${connectionCatalog?.stats.total ?? 0}`} />
                <MiniStat label="MCP" value={`${connectionCatalog?.stats.mcp ?? 0}`} />
                <MiniStat label="REST" value={`${connectionCatalog?.stats.openapi ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                {connectionTemplates.length ? (
                  connectionTemplates.slice(0, 8).map((template) => (
                    <ConnectionTemplateRow
                      key={template.id}
                      template={template}
                      onApply={applyConnectionTemplate}
                    />
                  ))
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    Connection catalog is loading.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Cable className="text-primary" size={18} />
                <h2 className="font-semibold">MCP connectors</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Servers" value={`${connectorStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${connectorStats?.active ?? 0}`} />
                <MiniStat label="Tools" value={`${connectorStats?.toolCount ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={connectorName}
                  onChange={(event) => setConnectorName(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="MCP connector name"
                />
                <input
                  value={connectorEndpoint}
                  onChange={(event) => setConnectorEndpoint(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="MCP endpoint URL"
                />
	                <input
	                  value={connectorAuthEnv}
	                  onChange={(event) => setConnectorAuthEnv(event.target.value.toUpperCase())}
	                  className="h-10 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
	                  placeholder="TOKEN_ENV_NAME"
	                  aria-label="MCP bearer token environment variable"
	                />
	                {editingConnectorId ? (
	                  <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background/54 px-3 py-2 text-xs">
	                    <span className="min-w-0 truncate font-mono text-muted">{editingConnectorId}</span>
	                    <button
	                      type="button"
	                      onClick={clearConnectorForm}
	                      className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line px-2 font-medium text-foreground transition hover:border-primary"
	                    >
	                      <XCircle size={13} />
	                      New
	                    </button>
	                  </div>
	                ) : null}
	                <div className="grid grid-cols-2 gap-2">
	                  <button
	                    type="button"
	                    onClick={() => registerConnector(false)}
	                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
	                  >
	                    <CheckCircle2 size={15} />
	                    {editingConnectorId ? "Save" : "Register"}
	                  </button>
	                  <button
	                    type="button"
	                    onClick={() => registerConnector(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
	                  >
	                    <Search size={15} />
	                    {editingConnectorId ? "Save + discover" : "Discover"}
	                  </button>
	                </div>
                {connectorResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {connectorResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
	                  {latestConnectors.length ? (
	                    latestConnectors.map((connector) => (
	                      <McpConnectorRow
	                        key={connector.id}
	                        connector={connector}
	                        onDiscover={discoverConnector}
	                        onEdit={loadConnectorForEdit}
	                        onToggle={updateConnectorStatus}
	                        onDelete={deleteConnector}
	                      />
	                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No MCP connectors registered.
                    </p>
                  )}
                  {latestMcpTools.map((tool) => (
                    <McpToolRow key={tool.id} tool={tool} />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Globe2 className="text-primary" size={18} />
                <h2 className="font-semibold">OpenAPI connectors</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="APIs" value={`${openApiStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${openApiStats?.active ?? 0}`} />
                <MiniStat label="Ops" value={`${openApiStats?.operationCount ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={openApiName}
                  onChange={(event) => setOpenApiName(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="OpenAPI connector name"
                />
                <input
                  value={openApiSpecUrl}
                  onChange={(event) => setOpenApiSpecUrl(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="OpenAPI spec URL"
                />
                <input
                  value={openApiBaseUrl}
                  onChange={(event) => setOpenApiBaseUrl(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="Base URL override"
                  aria-label="OpenAPI base URL override"
                />
	                <div className="grid grid-cols-2 gap-2">
	                  <input
	                    value={openApiAuthEnv}
                    onChange={(event) => setOpenApiAuthEnv(event.target.value.toUpperCase())}
                    className="h-10 min-w-0 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
                    placeholder="API_KEY_ENV"
                    aria-label="OpenAPI API key environment variable"
                  />
                  <input
                    value={openApiAuthHeader}
                    onChange={(event) => setOpenApiAuthHeader(event.target.value)}
                    className="h-10 min-w-0 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
                    aria-label="OpenAPI API key header"
	                  />
	                </div>
	                {editingOpenApiConnectorId ? (
	                  <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background/54 px-3 py-2 text-xs">
	                    <span className="min-w-0 truncate font-mono text-muted">{editingOpenApiConnectorId}</span>
	                    <button
	                      type="button"
	                      onClick={clearOpenApiConnectorForm}
	                      className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line px-2 font-medium text-foreground transition hover:border-primary"
	                    >
	                      <XCircle size={13} />
	                      New
	                    </button>
	                  </div>
	                ) : null}
	                <div className="grid grid-cols-2 gap-2">
	                  <button
	                    type="button"
                    onClick={() => registerOpenApiConnector(false)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
	                  >
	                    <CheckCircle2 size={15} />
	                    {editingOpenApiConnectorId ? "Save" : "Register"}
	                  </button>
                  <button
                    type="button"
                    onClick={() => registerOpenApiConnector(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
	                  >
	                    <Search size={15} />
	                    {editingOpenApiConnectorId ? "Save + import" : "Import"}
	                  </button>
	                </div>
                {openApiResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {openApiResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestOpenApiConnectors.length ? (
                    latestOpenApiConnectors.map((connector) => (
	                      <OpenApiConnectorRow
	                        key={connector.id}
	                        connector={connector}
	                        onImport={importOpenApiConnector}
	                        onEdit={loadOpenApiConnectorForEdit}
	                        onToggle={updateOpenApiConnectorStatus}
	                        onDelete={deleteOpenApiConnector}
	                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No OpenAPI connectors registered.
                    </p>
                  )}
                  {latestOpenApiOperations.map((operation) => (
                    <OpenApiOperationRow key={operation.id} operation={operation} />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <UploadCloud className="text-primary" size={18} />
                <h2 className="font-semibold">Knowledge ingest</h2>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={knowledgeTitle}
                  onChange={(event) => setKnowledgeTitle(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Knowledge title"
                />
                <textarea
                  value={knowledgeContent}
                  onChange={(event) => setKnowledgeContent(event.target.value)}
                  className="min-h-32 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Knowledge content"
                />
                <button
                  type="button"
                  onClick={saveKnowledgeDocument}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                >
                  <UploadCloud size={16} />
                  Ingest
                </button>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Search className="text-primary" size={18} />
                <h2 className="font-semibold">Memory browser</h2>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  value={browserQuery}
                  onChange={(event) => setBrowserQuery(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="Search memory..."
                  aria-label="Search memory and knowledge"
                />
                <button
                  type="button"
                  onClick={searchWorkspace}
                  className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-ink transition hover:brightness-110"
                  aria-label="Search"
                >
                  <Search size={16} />
                </button>
              </div>
              <div className="flex flex-col gap-3">
                {memories.length ? (
                  memories.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No memories found.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <FileText className="text-primary" size={18} />
                <h2 className="font-semibold">Knowledge library</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Docs" value={`${capabilities?.knowledge.documents ?? 0}`} />
                <MiniStat label="Chunks" value={`${capabilities?.knowledge.chunks ?? 0}`} />
                <MiniStat label="Vectors" value={`${capabilities?.knowledge.embedded ?? 0}`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Traces" value={`${contextStats?.traces ?? 0}`} />
                <MiniStat label="Ctx avg" value={`${contextStats?.averageSelectedCount ?? 0}`} />
                <MiniStat label="Latency" value={`${contextStats?.averageLatencyMs ?? 0}ms`} />
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Graph" value={`${graphStats?.nodes ?? 0}`} />
                <MiniStat label="Edges" value={`${graphStats?.edges ?? 0}`} />
                <MiniStat label="Groups" value={`${graphStats?.communities ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                {documents.map((document) => (
                  <DocumentRow key={document.id} document={document} />
                ))}
                {chunks.map((chunk) => (
                  <ChunkRow key={chunk.id} chunk={chunk} />
                ))}
                {!documents.length && !chunks.length ? (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No knowledge documents found.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Specialist agents</h2>
              </div>
              <div className="flex flex-col gap-3">
                {capabilities?.registry.agents.map((agent) => (
                  <CapabilityRow key={agent.id} capability={agent} />
                ))}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Cable className="text-primary" size={18} />
                <h2 className="font-semibold">Tool surface</h2>
              </div>
              <div className="flex flex-col gap-3">
                {capabilities?.registry.tools.map((tool) => (
                  <CapabilityRow key={tool.id} capability={tool} />
                ))}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Brain className="text-primary" size={18} />
                <h2 className="font-semibold">Memory write</h2>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={memoryTitle}
                  onChange={(event) => setMemoryTitle(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Memory title"
                />
                <textarea
                  value={memoryContent}
                  onChange={(event) => setMemoryContent(event.target.value)}
                  className="min-h-28 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Memory content"
                />
                <button
                  type="button"
                  onClick={saveManualMemory}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                >
                  <CheckCircle2 size={16} />
                  Save memory
                </button>
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}

function StatusPill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-background/70 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-muted">
        {icon}
        <span className="whitespace-nowrap">{label}</span>
      </div>
      <p className="mt-1 whitespace-nowrap font-mono text-sm text-foreground sm:text-base" title={value}>
        {value}
      </p>
    </div>
  );
}

function LoadingShell({ label }: { label: string }) {
  return (
    <main className="min-h-screen subtle-grid px-4 py-4 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl items-center justify-center">
        <div className="panel w-full max-w-md rounded-lg p-5">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-ink">
              <Layers3 size={20} />
            </div>
            <div>
              <p className="text-sm font-medium text-primary">OmniAgent OS</p>
              <h1 className="text-xl font-semibold">{label}</h1>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-background">
            <div className="h-full w-1/2 rounded-full bg-primary" />
          </div>
        </div>
      </div>
    </main>
  );
}

function AuthGate({
  email,
  password,
  message,
  bootstrapConfigured,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: {
  email: string;
  password: string;
  message: string;
  bootstrapConfigured: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="min-h-screen subtle-grid px-4 py-4 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl items-center justify-center">
        <form onSubmit={onSubmit} className="panel w-full max-w-md rounded-lg p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-md bg-primary text-primary-ink">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p className="text-sm font-medium text-primary">OmniAgent OS</p>
              <h1 className="text-xl font-semibold">Sign in</h1>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <input
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              className="h-11 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
              placeholder="Email"
              type="email"
              autoComplete="email"
              aria-label="Email"
            />
            <input
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              className="h-11 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              aria-label="Password"
            />
            <button
              type="submit"
              className="flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 font-medium text-primary-ink transition hover:brightness-110"
            >
              <LogIn size={16} />
              Sign in
            </button>
          </div>
          {message ? <p className="mt-4 rounded-md border border-line bg-background/54 p-3 text-sm text-muted">{message}</p> : null}
          {!bootstrapConfigured ? (
            <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm leading-6 text-danger">
              Bootstrap credentials are not configured.
            </p>
          ) : null}
        </form>
      </div>
    </main>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-background/70 px-2 py-2">
      <p className="text-muted">{label}</p>
      <p className="mt-1 break-words font-mono text-sm text-foreground">{value}</p>
    </div>
  );
}

function AuthUserRow({ user, membership }: { user: AuthUser; membership?: AuthMembership }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", user.status === "active" ? "bg-primary/16 text-primary" : "bg-danger/14 text-danger")}>
          {user.status}
        </span>
        <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
          {membership?.role || "none"}
        </span>
      </div>
      <p className="truncate text-sm font-medium leading-5">{user.email}</p>
      {user.name ? <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted">{user.name}</p> : null}
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{membership?.tenantId || "default"}</span>
        <span>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "never"}</span>
      </div>
    </div>
  );
}

function ObservabilityEventRow({ event }: { event: ObservabilityEventRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", observabilityTone(event.level))}>
          {event.level}
        </span>
        <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
          {event.category}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{event.action}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{event.message}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span className="truncate">{event.route || event.resourceType || "system"}</span>
        <span>{event.durationMs ?? 0}ms</span>
        <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-muted" title={event.correlationId}>
        {event.correlationId}
      </p>
    </div>
  );
}

function SloPolicyRow({ evaluation }: { evaluation: ObservabilitySloEvaluation }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", evaluation.breached ? incidentSeverityTone(evaluation.severity || "warning") : "bg-primary/16 text-primary")}>
          {evaluation.breached ? evaluation.severity : "healthy"}
        </span>
        <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
          {evaluation.policy.metric}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{evaluation.policy.name}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{evaluation.message}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span>{formatSloMetric(evaluation.value, evaluation.policy.unit)}</span>
        <span>{evaluation.threshold === undefined ? "inside" : formatSloMetric(evaluation.threshold, evaluation.policy.unit)}</span>
        <span>{evaluation.policy.suppressionMinutes}m</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-muted">
        <span className="truncate">{evaluation.policy.alertTargetIds.length ? evaluation.policy.alertTargetIds.join(",") : "default targets"}</span>
        <span className="shrink-0">{evaluation.policy.enabled ? "enabled" : "off"}</span>
      </div>
    </div>
  );
}

function SloPolicyChangeRow({ change }: { change: ObservabilitySloPolicyChange }) {
  const label = change.afterPolicy?.name || change.beforePolicy?.name || change.policyId;
  const approvals = new Set(change.approvals.filter((approval) => approval.decision === "approved").map((approval) => approval.actorId)).size;
  const required = change.approvalPolicy.quorum;
  const breakGlassUsed = change.approvals.some((approval) => approval.breakGlass);

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", sloPolicyChangeTone(change.status))}>
          {change.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(change.riskLevel as RiskLevel))}>
          R{change.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{label}</p>
      <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span className="truncate">{change.action.replace(/_/g, " ")}</span>
        <span className="truncate">{approvals}/{required} approvals</span>
        <span>{breakGlassUsed ? "emergency" : new Date(change.createdAt).toLocaleTimeString()}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-muted">
        <span className="truncate">{change.approvalPolicy.requiredRoles.join(",")}</span>
        <span className="shrink-0">{change.evidenceHash.slice(0, 10)}</span>
      </div>
      {change.reason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{change.reason}</p> : null}
    </div>
  );
}

function SecurityAuditRow({ record }: { record: SecurityAuditRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", decisionTone(record.decision))}>
          {record.decision}
        </span>
        <span className="truncate font-mono text-[11px] text-muted">{record.actorRole}</span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{record.action}</p>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span className="truncate">{record.resourceType}</span>
        <span className="shrink-0">{new Date(record.createdAt).toLocaleTimeString()}</span>
      </div>
      {record.reason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{record.reason}</p> : null}
    </div>
  );
}

function RbacRuleRow({ rule }: { rule: RbacRule }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="truncate font-mono text-xs text-foreground">{rule.action}</p>
        <span className="shrink-0 rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {rule.roles.length} roles
        </span>
      </div>
      <p className="line-clamp-2 text-xs leading-5 text-muted">{rule.description}</p>
      <div className="mt-3 flex flex-wrap gap-1">
        {rule.roles.map((role) => (
          <span key={role} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {role}
          </span>
        ))}
      </div>
    </div>
  );
}

function ToolAuditRow({ record }: { record: ToolExecutionRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", statusTone(record.status))}>
          {record.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(record.riskLevel))}>
          R{record.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{record.toolName}</p>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{record.dryRun ? "dry" : "live"}</span>
        <span>{new Date(record.createdAt).toLocaleTimeString()}</span>
      </div>
      {record.approvalDecision ? (
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
          <span>{record.approvalDecision}</span>
          <span className="truncate">{record.approvedBy || "operator"}</span>
        </div>
      ) : null}
      {record.reason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{record.reason}</p> : null}
    </div>
  );
}

function IncidentRow({
  incident,
  onAction,
}: {
  incident: IncidentRecord;
  onAction: (incident: IncidentRecord, action: "acknowledge" | "resolve" | "run_playbook") => void;
}) {
  const canAcknowledge = incident.status === "open";
  const canPlaybook = incident.playbookIds.length > 0;

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", incidentStatusTone(incident.status))}>
          {incident.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", incidentSeverityTone(incident.severity))}>
          {incident.severity}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{incident.title}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{incident.message}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span className="truncate">{incident.componentId}</span>
        <span>{incident.occurrenceCount} seen</span>
        <span>{new Date(incident.lastSeenAt).toLocaleTimeString()}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          disabled={!canAcknowledge}
          onClick={() => onAction(incident, "acknowledge")}
          className="flex h-8 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          <CheckCircle2 size={12} />
          Ack
        </button>
        <button
          type="button"
          disabled={!canPlaybook}
          onClick={() => onAction(incident, "run_playbook")}
          className="flex h-8 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Activity size={12} />
          Fix
        </button>
        <button
          type="button"
          onClick={() => onAction(incident, "resolve")}
          className="flex h-8 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-xs font-medium text-foreground transition hover:border-danger"
        >
          <XCircle size={12} />
          Resolve
        </button>
      </div>
    </div>
  );
}

function AlertDeliveryRow({ delivery }: { delivery: AlertDeliveryRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", alertDeliveryTone(delivery.status))}>
          {delivery.status}
        </span>
        <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
          {delivery.channel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{delivery.targetId}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span>{delivery.severity}</span>
        <span>{delivery.attempt}/{delivery.maxAttempts}</span>
        <span>{new Date(delivery.updatedAt).toLocaleTimeString()}</span>
      </div>
      {delivery.lastError ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{delivery.lastError}</p> : null}
    </div>
  );
}

function AlertTargetHealthRow({ target }: { target: AlertTargetHealth }) {
  const requirements = target.requiredEnv.concat(target.optionalEnv.map((env) => `${env}?`));

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", alertTargetHealthTone(target.probeStatus))}>
          {target.probeStatus}
        </span>
        <span className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-muted">
          {target.channel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{target.name}</p>
      <p className="mt-1 line-clamp-1 font-mono text-[11px] text-muted">{requirements.join(" / ") || "internal"}</p>
      {target.blockingReasons.length ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">
          {target.blockingReasons.join(" ")}
        </p>
      ) : (
        <p className="mt-2 text-xs leading-5 text-muted">
          {target.security.webhookSigned === undefined ? "Ready" : target.security.webhookSigned ? "Signed webhook ready" : "Webhook unsigned"}
        </p>
      )}
    </div>
  );
}

function ApprovalQueueRow({
  item,
  onDecide,
}: {
  item: ApprovalQueueItem;
  onDecide: (item: ApprovalQueueItem, decision: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", approvalQueueTone(item.status))}>
          {item.kind}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(item.riskLevel as RiskLevel))}>
          R{item.riskLevel}
        </span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{item.title}</p>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span className="truncate">{item.requestedBy || item.tenantId || "operator"}</span>
        <span className="shrink-0">{new Date(item.createdAt).toLocaleTimeString()}</span>
      </div>
      {item.reason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{item.reason}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onDecide(item, "approve")}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-primary/60 px-2 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
        >
          <CheckCircle2 size={13} />
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecide(item, "reject")}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-danger hover:text-danger"
        >
          <XCircle size={13} />
          Reject
        </button>
      </div>
    </div>
  );
}

function ConnectionTemplateRow({
  template,
  onApply,
}: {
  template: ConnectionCatalogItem;
  onApply: (template: ConnectionCatalogItem) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {template.adapter}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(template.riskLevel))}>
          R{template.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{template.name}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
        {template.capabilities.slice(0, 4).join(", ")}
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {template.authEnvVars.slice(0, 2).map((envName) => (
          <span key={envName} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {envName}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onApply(template)}
        className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
      >
        <CheckCircle2 size={13} />
        Apply template
      </button>
    </div>
  );
}

function McpConnectorRow({
  connector,
  onDiscover,
  onEdit,
  onToggle,
  onDelete,
}: {
  connector: McpConnectorRecord;
  onDiscover: (connectorId: string) => void;
  onEdit: (connector: McpConnectorRecord) => void;
  onToggle: (connector: McpConnectorRecord) => void;
  onDelete: (connector: McpConnectorRecord) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", connectorTone(connector.status))}>
          {connector.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(connector.defaultRiskLevel))}>
          R{connector.defaultRiskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{connector.name}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{connector.endpoint}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-muted">{connector.toolCount} tools</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onEdit(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Pencil size={13} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => onDiscover(connector.id)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Search size={13} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => onToggle(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Power size={13} />
          {connector.status === "disabled" ? "Enable" : "Disable"}
        </button>
        <button
          type="button"
          onClick={() => onDelete(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-danger/50 px-2 text-xs font-medium text-danger transition hover:bg-danger hover:text-white"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
      {connector.lastError ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{connector.lastError}</p>
      ) : null}
    </div>
  );
}

function McpToolRow({ tool }: { tool: McpToolRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">mcp tool</span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(tool.riskLevel))}>
          R{tool.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{tool.title || tool.name}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">
        {tool.description || tool.connectorName}
      </p>
    </div>
  );
}

function OpenApiConnectorRow({
  connector,
  onImport,
  onEdit,
  onToggle,
  onDelete,
}: {
  connector: OpenApiConnectorRecord;
  onImport: (connectorId: string) => void;
  onEdit: (connector: OpenApiConnectorRecord) => void;
  onToggle: (connector: OpenApiConnectorRecord) => void;
  onDelete: (connector: OpenApiConnectorRecord) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", connectorTone(connector.status))}>
          {connector.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(connector.defaultRiskLevel))}>
          R{connector.defaultRiskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{connector.name}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{connector.baseUrl}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-muted">{connector.operationCount} ops</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onEdit(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Pencil size={13} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => onImport(connector.id)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Search size={13} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => onToggle(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          <Power size={13} />
          {connector.status === "disabled" ? "Enable" : "Disable"}
        </button>
        <button
          type="button"
          onClick={() => onDelete(connector)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-danger/50 px-2 text-xs font-medium text-danger transition hover:bg-danger hover:text-white"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
      {connector.lastError ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{connector.lastError}</p>
      ) : null}
    </div>
  );
}

function OpenApiOperationRow({ operation }: { operation: OpenApiOperationRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-accent/14 px-2 py-1 font-mono text-[11px] text-accent">
          {operation.method}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(operation.riskLevel))}>
          R{operation.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{operation.summary || operation.operationId}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{operation.path}</p>
    </div>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {memory.type}
        </span>
        <span className="font-mono text-[11px] text-muted">{memory.importance.toFixed(2)}</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{memory.title}</p>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{memory.content}</p>
      <TagList tags={memory.tags} />
    </div>
  );
}

function DocumentRow({ document }: { document: KnowledgeDocument }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {document.sourceType}
        </span>
        <span className="font-mono text-[11px] text-muted">{document.chunkCount} chunks</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{document.title}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{document.source}</p>
      <TagList tags={document.tags} />
    </div>
  );
}

function ChunkRow({ chunk }: { chunk: KnowledgeChunk }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-accent/14 px-2 py-1 font-mono text-[11px] text-accent">
          chunk
        </span>
        <span className="font-mono text-[11px] text-muted">{chunk.tokenEstimate} tokens</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{chunk.title}</p>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{chunk.content}</p>
      <TagList tags={chunk.tags} />
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {tags.slice(0, 4).map((tag) => (
        <span key={tag} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {tag}
        </span>
      ))}
    </div>
  );
}

function CapabilityRow({ capability }: { capability: Capability }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{capability.name}</p>
        <span
          className={clsx(
            "rounded px-2 py-1 font-mono text-[11px]",
            capability.status === "active"
              ? "bg-primary/16 text-primary"
              : "bg-accent/14 text-accent",
          )}
        >
          {capability.status}
        </span>
      </div>
      <p className="text-xs leading-5 text-muted">{capability.description}</p>
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span
          className={clsx(
            "rounded px-2 py-1 font-mono text-[11px]",
            run.status === "completed"
              ? "bg-primary/16 text-primary"
              : run.status === "failed"
                ? "bg-danger/14 text-danger"
                : "bg-accent/14 text-accent",
          )}
        >
          {run.status}
        </span>
        <span className="font-mono text-[11px] text-muted">{run.mode}</span>
      </div>
      <p className="line-clamp-2 text-sm leading-5">{run.prompt || "Untitled run"}</p>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{run.model || "model pending"}</span>
        <span>{run.memoryContextCount} ctx</span>
        <span>{run.consolidationCount || 0} learned</span>
      </div>
    </div>
  );
}

function WorkflowRow({
  workflow,
  onTick,
  onSignal,
}: {
  workflow: WorkflowRunRecord;
  onTick: (workflowId: string) => void;
  onSignal: (workflowId: string, signal: "pause" | "resume" | "cancel" | "approve" | "retry") => void;
}) {
  const canTick = workflow.status === "queued" || workflow.status === "running";
  const canApprove = workflow.status === "waiting_approval";
  const canPause = workflow.status === "queued" || workflow.status === "running";
  const canResume = workflow.status === "paused";
  const canRetry = workflow.status === "failed";
  const isTerminal = ["completed", "canceled"].includes(workflow.status);

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", workflowTone(workflow.status))}>
          {workflow.status}
        </span>
        <span className="font-mono text-[11px] text-muted">
          {workflow.currentStep || "done"}
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-5">{workflow.goal}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          disabled={!canTick}
          onClick={() => onTick(workflow.id)}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Tick
        </button>
        <button
          type="button"
          disabled={!canApprove}
          onClick={() => onSignal(workflow.id, "approve")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!canRetry}
          onClick={() => onSignal(workflow.id, "retry")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Retry
        </button>
        <button
          type="button"
          disabled={!canPause}
          onClick={() => onSignal(workflow.id, "pause")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Pause
        </button>
        <button
          type="button"
          disabled={!canResume}
          onClick={() => onSignal(workflow.id, "resume")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Resume
        </button>
        <button
          type="button"
          disabled={isTerminal}
          onClick={() => onSignal(workflow.id, "cancel")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-danger disabled:cursor-not-allowed disabled:opacity-45"
        >
          Cancel
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{workflow.workflowType}</span>
        <span>{workflow.attempt}/{workflow.maxAttempts}</span>
      </div>
      {workflow.error ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{workflow.error}</p> : null}
    </div>
  );
}

function WorkflowRecoveryEventRow({ event }: { event: WorkflowRecoveryEventRecord }) {
  const jobIds = event.payload.jobIds || event.payload.canceledJobIds || [];
  const reason = event.payload.reason || event.workflow.error || "Recovery action completed.";

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", workflowRecoveryTone(event.disposition))}>
          {event.disposition}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", workflowTone(event.workflow.status))}>
          {event.workflow.status}
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-5">{event.workflow.goal}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{reason}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span>{formatDurationMs(event.payload.staleMs)} stale</span>
        <span>{event.workflow.attempt}/{event.workflow.maxAttempts} tries</span>
        <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 font-mono text-[10px] text-muted">
        <span className="truncate" title={event.workflow.id}>{event.workflow.id}</span>
        <span className="shrink-0">{event.payload.actorId || "system"}</span>
      </div>
      {jobIds.length ? (
        <p className="mt-2 truncate font-mono text-[10px] text-muted" title={jobIds.join(", ")}>
          jobs {jobIds.length}
        </p>
      ) : null}
    </div>
  );
}

function EvaluationRunDetailPanel({
  detail,
  caseEvidence,
  filter,
  reports,
  reportResult,
  onFilterChange,
  onCreateReport,
  onDownloadReport,
  onVerifyReport,
}: {
  detail: EvalRunDetail;
  caseEvidence: EvalCaseEvidence[];
  filter: EvalDetailFilter;
  reports: EvalReportSnapshot[];
  reportResult: string;
  onFilterChange: (filter: EvalDetailFilter) => void;
  onCreateReport: (runId: string) => void;
  onDownloadReport: (runId: string, reportId?: string) => void;
  onVerifyReport: (runId: string, reportId?: string) => void;
}) {
  const passRate = detail.run.summary.total ? Math.round((detail.run.summary.passed / detail.run.summary.total) * 100) : 0;
  const override = detail.override;
  const governance = detail.governance;
  const event = detail.events?.[0];
  const latestReport = reports[0];

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium leading-5">{detail.run.suite}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">{detail.run.id}</p>
        </div>
        <span className={clsx("shrink-0 rounded px-2 py-1 font-mono text-[11px]", evaluationRunTone(detail.run.status))}>
          {passRate}%
        </span>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="Cases" value={`${detail.run.summary.total}`} />
        <MiniStat label="Risk" value={`R${governance?.maxRiskLevel ?? 0}`} />
        <MiniStat label="Mutating" value={`${governance?.mutatingCases ?? 0}`} />
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="Override" value={override?.requested ? "yes" : "no"} />
        <MiniStat label="Role" value={override?.role || "unknown"} />
        <MiniStat label="Event" value={event?.statusCode ? `${event.statusCode}` : "none"} />
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="Reports" value={`${reports.length}`} />
        <MiniStat label="Key" value={latestReport?.signature.keyId || "none"} />
        <MiniStat label="Sig" value={latestReport ? latestReport.signature.signature.slice(0, 10) : "none"} />
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onCreateReport(detail.run.id)}
          className="flex h-9 items-center justify-center gap-2 rounded-md border border-primary/60 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
        >
          <FileText size={14} />
          Create report
        </button>
        <button
          type="button"
          disabled={!latestReport}
          onClick={() => onVerifyReport(detail.run.id, latestReport?.id)}
          className="flex h-9 items-center justify-center gap-2 rounded-md border border-accent/60 text-xs font-medium text-accent transition hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ShieldCheck size={14} />
          Verify
        </button>
        <button
          type="button"
          disabled={!latestReport}
          onClick={() => onDownloadReport(detail.run.id, latestReport?.id)}
          className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-muted transition hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Download size={14} />
          Download
        </button>
      </div>
      {latestReport ? (
        <div className="mb-3 rounded-md border border-line bg-background/70 p-2 font-mono text-[10px] leading-5 text-muted">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="truncate" title={latestReport.id}>{latestReport.id}</span>
            <span className="shrink-0">{latestReport.signature.keyStatus || latestReport.reportVersion}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
            <span className="truncate" title={latestReport.signature.digest}>{latestReport.signature.digest}</span>
            <span className="shrink-0">{new Date(latestReport.createdAt).toLocaleTimeString()}</span>
          </div>
        </div>
      ) : null}
      {reportResult ? (
        <pre className="mb-3 max-h-36 overflow-auto rounded-md border border-line bg-background/70 p-2 font-mono text-[10px] leading-4 text-muted">
          {reportResult}
        </pre>
      ) : null}
      <div className="mb-3 grid grid-cols-4 gap-1.5">
        {evaluationDetailFilters.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onFilterChange(item.id)}
            className={clsx(
              "h-8 rounded-md border px-1.5 text-xs font-medium transition",
              filter === item.id
                ? "border-primary bg-primary text-primary-ink"
                : "border-line text-muted hover:border-primary hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {override?.reason ? (
        <p className="mb-3 rounded-md border border-line bg-background/70 p-2 text-xs leading-5 text-muted">
          {override.reason}
        </p>
      ) : null}
      <div className="flex max-h-96 flex-col gap-2 overflow-auto pr-1">
        {caseEvidence.length ? (
          caseEvidence.map((evidence) => (
            <EvaluationCaseEvidenceRow key={evidence.result.id} evidence={evidence} />
          ))
        ) : (
          <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
            No cases match this filter.
          </p>
        )}
      </div>
      {event ? (
        <div className="mt-3 rounded-md border border-line bg-background/54 p-2 font-mono text-[10px] leading-5 text-muted">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">{event.correlationId}</span>
            <span>{event.durationMs ?? 0}ms</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="truncate">{event.actorId || "unknown"}</span>
            <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EvaluationCaseEvidenceRow({ evidence }: { evidence: EvalCaseEvidence }) {
  const { result, definition, governance } = evidence;
  const output = formatCompactJson(result.output);

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", resultTone(result.status))}>
          {result.status}
        </span>
        {governance ? (
          <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", evalSafetyTone(governance.safetyMode))}>
            {governance.safetyMode}
          </span>
        ) : null}
        {governance ? (
          <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(governance.riskLevel))}>
            R{governance.riskLevel}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{result.caseName}</p>
      {definition?.description ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{definition.description}</p>
      ) : null}
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span>{Math.round(result.score * 100)}%</span>
        <span>{result.latencyMs}ms</span>
        <span>${result.estimatedCostUsd.toFixed(4)}</span>
      </div>
      {governance ? (
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3 font-mono text-[10px] text-muted">
          <span>{governance.cleanup}</span>
          <span>{governance.writesToDatabase ? "writes" : "read"}</span>
          <span>{governance.production.requiresMutationApproval ? "gated" : "safe"}</span>
        </div>
      ) : null}
      {result.error ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{result.error}</p> : null}
      {output ? (
        <pre className="mt-2 max-h-28 overflow-auto rounded-md border border-line bg-background/70 p-2 font-mono text-[10px] leading-4 text-muted">
          {output}
        </pre>
      ) : null}
    </div>
  );
}

function EvaluationRunRow({
  run,
  selected,
  onSelect,
}: {
  run: EvalRunRecord;
  selected: boolean;
  onSelect: (runId: string) => void;
}) {
  const passRate = run.summary.total ? Math.round((run.summary.passed / run.summary.total) * 100) : 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={clsx(
        "rounded-md border p-3 text-left transition hover:border-primary",
        selected ? "border-primary/60 bg-primary/8" : "border-line bg-background/54",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", evaluationRunTone(run.status))}>
          {run.status}
        </span>
        <span className="font-mono text-[11px] text-muted">{passRate}%</span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{run.suite}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono text-[11px] text-muted">
        <span>{run.summary.passed} pass</span>
        <span>{run.summary.warnings} warn</span>
        <span>{run.summary.failed} fail</span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{run.summary.averageLatencyMs}ms avg</span>
        <span>${run.summary.estimatedCostUsd.toFixed(4)}</span>
      </div>
      {run.error ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{run.error}</p> : null}
    </button>
  );
}

function EvaluationCaseRow({ evalCase }: { evalCase: EvalCaseDefinition }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", evalSafetyTone(evalCase.governance.safetyMode))}>
          {evalCase.governance.safetyMode}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(evalCase.governance.riskLevel))}>
          R{evalCase.governance.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{evalCase.name}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{evalCase.description}</p>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span className="truncate">{evalCase.type}</span>
        <span>{evalCase.governance.cleanup}</span>
        <span>{evalCase.governance.writesToDatabase ? "writes" : "read"}</span>
      </div>
    </div>
  );
}

function statusTone(status: ToolExecutionStatus) {
  if (status === "executed") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed" || status === "blocked" || status === "rejected") {
    return "bg-danger/14 text-danger";
  }

  if (status === "approval_required") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function approvalQueueTone(status: ApprovalQueueItem["status"]) {
  if (status === "approval_required" || status === "waiting_approval" || status === "pending") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function sloPolicyChangeTone(status: SloPolicyChangeStatus) {
  if (status === "applied") {
    return "bg-primary/16 text-primary";
  }

  if (status === "rejected") {
    return "bg-danger/14 text-danger";
  }

  return "bg-accent/14 text-accent";
}

function evaluationRunTone(status: EvalRunRecord["status"]) {
  if (status === "completed") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed") {
    return "bg-danger/14 text-danger";
  }

  return "bg-accent/14 text-accent";
}

function resultTone(status?: EvalResultStatus | string) {
  if (status === "pass") {
    return "bg-primary/16 text-primary";
  }

  if (status === "fail") {
    return "bg-danger/14 text-danger";
  }

  return "bg-accent/14 text-accent";
}

function isolationTone(status?: TenantIsolationReport["status"]) {
  if (status === "passing") {
    return "bg-primary/16 text-primary";
  }
  if (status === "degraded") {
    return "bg-danger/14 text-danger";
  }
  return "bg-background text-muted";
}

function evalSafetyTone(mode: EvalSafetyMode) {
  if (mode === "read_only") {
    return "bg-primary/16 text-primary";
  }

  if (mode === "mutation_allowed") {
    return "bg-danger/14 text-danger";
  }

  return "bg-accent/14 text-accent";
}

function evalSafetyOrder(mode: EvalSafetyMode) {
  if (mode === "read_only") {
    return 0;
  }

  if (mode === "synthetic") {
    return 1;
  }

  return 2;
}

function decisionTone(decision: SecurityDecision) {
  if (decision === "allow") {
    return "bg-primary/16 text-primary";
  }

  return "bg-danger/14 text-danger";
}

function incidentStatusTone(status: IncidentStatus) {
  if (status === "open") {
    return "bg-danger/14 text-danger";
  }

  if (status === "acknowledged") {
    return "bg-accent/14 text-accent";
  }

  return "bg-primary/16 text-primary";
}

function incidentSeverityTone(severity: IncidentSeverity) {
  if (severity === "critical") {
    return "bg-danger/14 text-danger";
  }

  if (severity === "warning") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function alertDeliveryTone(status: AlertDeliveryStatus) {
  if (status === "delivered") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed") {
    return "bg-danger/14 text-danger";
  }

  if (status === "running" || status === "queued") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function alertTargetHealthTone(status: AlertTargetProbeStatus) {
  if (status === "healthy") {
    return "bg-primary/16 text-primary";
  }
  if (status === "misconfigured") {
    return "bg-danger/14 text-danger";
  }
  return "bg-accent/16 text-accent";
}

function observabilityTone(level: ObservabilityLevel) {
  if (level === "error") {
    return "bg-danger/14 text-danger";
  }
  if (level === "warn") {
    return "bg-accent/16 text-accent";
  }
  return "bg-primary/16 text-primary";
}

function formatSloMetric(value: number, unit: ObservabilitySloPolicy["unit"]) {
  if (unit === "ratio") {
    return `${Math.round(value * 10000) / 100}%`;
  }
  if (unit === "ms") {
    return `${value}ms`;
  }
  return `${value}`;
}

function workflowTone(status: WorkflowRunStatus) {
  if (status === "completed") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed" || status === "canceled") {
    return "bg-danger/14 text-danger";
  }

  if (status === "waiting_approval" || status === "paused") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function workflowRecoveryTone(disposition: WorkflowRecoveryEventRecord["disposition"]) {
  return disposition === "requeued"
    ? "bg-primary/16 text-primary"
    : "bg-danger/14 text-danger";
}

function formatDurationMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0ms";
  }

  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }

  if (value < 60_000) {
    return `${Math.round(value / 1000)}s`;
  }

  if (value < 3_600_000) {
    return `${Math.round(value / 60_000)}m`;
  }

  return `${Math.round(value / 3_600_000)}h`;
}

function riskTone(riskLevel: RiskLevel) {
  if (riskLevel === 0) {
    return "bg-primary/16 text-primary";
  }

  if (riskLevel === 1) {
    return "bg-accent/14 text-accent";
  }

  return "bg-danger/14 text-danger";
}

function connectorTone(status: McpConnectorRecord["status"]) {
  if (status === "active") {
    return "bg-primary/16 text-primary";
  }

  if (status === "error") {
    return "bg-danger/14 text-danger";
  }

  return "bg-background text-muted";
}

function findSloApprovalRule(
  policy: ObservabilitySloApprovalPolicyConfig,
  id: string,
  riskLevel: number,
) {
  return policy.rules.find((rule) => rule.id === id) ||
    policy.rules.find((rule) => rule.action === "any" && rule.riskLevel === riskLevel);
}

function parseBoundedInt(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function createDefaultSloApprovalRule(id: string, riskLevel: number): SloApprovalPolicyRule {
  const highRisk = riskLevel >= 3;
  return {
    id,
    action: "any",
    riskLevel,
    quorum: highRisk ? 2 : 1,
    requiredRoles: highRisk ? ["admin", "system"] : ["operator", "admin", "system"],
    allowRequesterApproval: !highRisk,
    attestationRequired: false,
    breakGlassAllowed: highRisk,
    description: highRisk
      ? "High-risk SLO changes require two distinct admin/system approvals."
      : "Standard SLO changes require one operator, admin, or system approval.",
  };
}

function normalizeApprovalRoles(roles: SecurityRole[] | undefined, fallback: SecurityRole[]) {
  const allowed = new Set<SecurityRole>(["operator", "admin", "system"]);
  const next = [...new Set((roles || []).filter((role) => allowed.has(role)))];
  return next.length ? next : fallback;
}

function formatToolResult(value: unknown) {
  const formatted = JSON.stringify(value, null, 2) || "";
  return formatted.length > 2600 ? `${formatted.slice(0, 2600)}\n...` : formatted;
}

function formatCompactJson(value: unknown) {
  if (!value) {
    return "";
  }
  const formatted = JSON.stringify(value, null, 2) || "";
  return formatted.length > 900 ? `${formatted.slice(0, 900)}\n...` : formatted;
}

function extractDownloadFilename(contentDisposition: string | null, fallback: string) {
  if (!contentDisposition) {
    return fallback;
  }

  const filenameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
  return filenameMatch?.[1] ? decodeURIComponent(filenameMatch[1]) : fallback;
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, string>) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (!dataLine) {
        continue;
      }

      onEvent(JSON.parse(dataLine.slice(6)));
    }
  }
}
