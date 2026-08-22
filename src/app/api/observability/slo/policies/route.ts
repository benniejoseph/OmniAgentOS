import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getIncidentAlertTargets } from "@/lib/diagnostics/incidents";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  listObservabilitySloPolicyChanges,
  requestObservabilitySloPolicyChange,
  rollbackObservabilitySloPolicyChange,
  getDefaultObservabilitySloPolicies,
  getObservabilitySloPolicy,
  getObservabilitySloApprovalPolicyConfig,
  listObservabilitySloApprovalPolicyVersions,
  listObservabilitySloPolicies,
  resetObservabilitySloApprovalPolicyConfig,
  saveObservabilitySloApprovalPolicyConfig,
  SloApprovalPolicyVersionConflictError,
} from "@/lib/observability/slo-policy-store";
import { getObservabilitySloSnapshot } from "@/lib/observability/slo-monitor";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const metrics = ["errorRate", "availability", "latencyP95Ms", "routeFailures"] as const;
const comparators = ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"] as const;
const severities = ["info", "warning", "critical"] as const;
const units = ["ratio", "ms", "count"] as const;
const approvalActions = ["upsert_policy", "toggle_policy", "delete_policy", "reset_defaults", "rollback_policy", "any"] as const;
const approvalRoles = ["operator", "admin", "system"] as const;
const changeReason = z.string().max(1000).optional();

const policySchema = z.object({
  id: z.string().min(2).max(80).regex(/^[a-z0-9_.:-]+$/),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().default(""),
  metric: z.enum(metrics),
  comparator: z.enum(comparators),
  warningThreshold: z.number().finite(),
  criticalThreshold: z.number().finite(),
  warningSeverity: z.enum(severities).optional().default("warning"),
  criticalSeverity: z.enum(severities).optional().default("critical"),
  unit: z.enum(units),
  componentId: z.string().min(1).max(120).optional().default("observability"),
  enabled: z.boolean(),
  alertTargetIds: z.array(z.string().min(1).max(80)).max(10).optional().default([]),
  suppressionMinutes: z.number().int().min(0).max(10080).optional().default(120),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const approvalPolicyRuleSchema = z.object({
  id: z.string().min(1).max(80),
  action: z.enum(approvalActions).optional(),
  riskLevel: z.number().int().min(0).max(3).optional(),
  quorum: z.number().int().min(1).max(5),
  requiredRoles: z.array(z.enum(approvalRoles)).min(1).max(3),
  allowRequesterApproval: z.boolean(),
  attestationRequired: z.boolean(),
  breakGlassAllowed: z.boolean(),
  description: z.string().max(500).optional().default(""),
}).strict();

const breakGlassPolicySchema = z.object({
  enabled: z.boolean(),
  requiredRole: z.enum(approvalRoles),
  reasonMinLength: z.number().int().min(12).max(1000),
  maxRiskLevel: z.number().int().min(0).max(3),
  requireTicket: z.boolean(),
  description: z.string().max(500).optional().default(""),
}).strict();

const approvalPolicyConfigSchema = z.object({
  rules: z.array(approvalPolicyRuleSchema).min(1).max(10),
  breakGlass: breakGlassPolicySchema,
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert_policy"),
    policy: policySchema,
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("toggle_policy"),
    id: z.string().min(2).max(80),
    enabled: z.boolean(),
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("reset_defaults"),
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("delete_policy"),
    id: z.string().min(2).max(80),
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("rollback_policy"),
    changeId: z.string().min(2).max(120),
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("update_approval_policy"),
    expectedVersion: z.number().int().min(1),
    policy: approvalPolicyConfigSchema,
    reason: changeReason,
  }).strict(),
  z.object({
    action: z.literal("reset_approval_policy"),
    expectedVersion: z.number().int().min(1),
    reason: changeReason,
  }).strict(),
]);

type SloPolicyAction = z.infer<typeof actionSchema>;

async function GETHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "slo-policies");
  let context;

  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "observability_slo_policy",
      metadata: { includeDisabled: true },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    // Approval-policy configuration/version records are intentionally
    // platform-global; tenant operators may manage only tenant-owned SLOs.
    const canReadPlatformPolicy = context.role === "system";
    const [policies, snapshot, approvalPolicy, approvalPolicyVersions] = await Promise.all([
      listObservabilitySloPolicies({ tenantId: context.tenantId, includeDisabled: true }),
      getObservabilitySloSnapshot({ tenantId: context.tenantId }),
      canReadPlatformPolicy ? getObservabilitySloApprovalPolicyConfig() : Promise.resolve(undefined),
      canReadPlatformPolicy
        ? listObservabilitySloApprovalPolicyVersions({ limit: 10 })
        : Promise.resolve([]),
    ]);
    const changes = await listObservabilitySloPolicyChanges({ limit: 20, tenantId: context.tenantId });
    await recordRuntimeEventSafely({
      category: "api",
      action: "observability.slo_policies.read",
      route: "/api/observability/slo/policies",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo_policy",
      message: "Read observability SLO policies.",
      metadata: { policies: policies.length, enabled: policies.filter((policy) => policy.enabled).length },
    });
    return Response.json({
      policies,
      defaults: getDefaultObservabilitySloPolicies(),
      alertTargets: getIncidentAlertTargets("critical"),
      changes,
      pendingChanges: changes.filter((change) => change.status === "pending"),
      approvalPolicy,
      approvalPolicyVersions,
      snapshot,
    });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: "observability.slo_policies.read_failed",
      route: "/api/observability/slo/policies",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo_policy",
      message: "Observability SLO policy read failed.",
      metadata: { error: error instanceof Error ? error.message : "SLO policy read failed." },
    });
    return Response.json({ error: "Observability SLO policy read failed." }, { status: 500 });
  }
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "slo-policies");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = actionSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid SLO policy action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "observability_slo_policy",
      metadata: {
        action: parsed.data.action,
        policyId:
          parsed.data.action === "upsert_policy"
            ? parsed.data.policy.id
            : "id" in parsed.data
            ? parsed.data.id
            : undefined,
        changeId:
          "changeId" in parsed.data ? parsed.data.changeId : undefined,
        hasReason: Boolean(parsed.data.reason),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (
    (parsed.data.action === "update_approval_policy" ||
      parsed.data.action === "reset_approval_policy") &&
    context.role !== "system"
  ) {
    // Platform-global approval policy mutation is never delegated to a tenant
    // operator, even when they can manage that tenant's individual SLOs.
    return forbiddenResponse(
      new SecurityPolicyError(
        "Platform SLO approval policy administration requires a system role.",
      ),
    );
  }

  try {
    const result = await handleSloPolicyAction(parsed.data, context);
    const snapshot = await getObservabilitySloSnapshot({ tenantId: context.tenantId });
    const [policies, changes, approvalPolicy, approvalPolicyVersions] = await Promise.all([
      listObservabilitySloPolicies({ tenantId: context.tenantId, includeDisabled: true }),
      listObservabilitySloPolicyChanges({ limit: 20, tenantId: context.tenantId }),
      context.role === "system"
        ? getObservabilitySloApprovalPolicyConfig()
        : Promise.resolve(undefined),
      context.role === "system"
        ? listObservabilitySloApprovalPolicyVersions({ limit: 10 })
        : Promise.resolve([]),
    ]);
    await recordRuntimeEventSafely({
      category: "api",
      action: `observability.slo_policies.${parsed.data.action}`,
      route: "/api/observability/slo/policies",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo_policy",
      message: "Updated observability SLO policy configuration.",
      metadata: {
        action: parsed.data.action,
        policyIds: result.policies.map((policy) => policy.id),
        changeId: result.change?.id,
        changeStatus: result.change?.status,
        enabled: result.policies.filter((policy) => policy.enabled).length,
      },
    });
    return Response.json({
      policies,
      changed: result.policies,
      change: result.change,
      changes,
      pendingChanges: changes.filter((change) => change.status === "pending"),
      approvalPolicy,
      approvalPolicyVersions,
      alertTargets: getIncidentAlertTargets("critical"),
      snapshot,
    });
  } catch (error) {
    const conflict =
      error instanceof SloApprovalPolicyVersionConflictError;
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: `observability.slo_policies.${parsed.data.action}.failed`,
      route: "/api/observability/slo/policies",
      method: "POST",
      statusCode: conflict ? 409 : 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo_policy",
      message: "Observability SLO policy update failed.",
      metadata: { error: error instanceof Error ? error.message : "SLO policy update failed." },
    });
    return Response.json(
      {
        error: conflict
          ? "SLO approval policy version conflict"
          : error instanceof Error
            ? error.message
            : "Observability SLO policy update failed.",
        message: error instanceof Error ? error.message : undefined,
      },
      { status: conflict ? 409 : 500 },
    );
  }
}

async function requirePolicy(policyId: string, tenantId: string) {
  const policy = await getObservabilitySloPolicy(policyId, { tenantId });
  if (!policy) {
    throw new Error(`SLO policy ${policyId} was not found.`);
  }
  return policy;
}

async function handleSloPolicyAction(
  action: SloPolicyAction,
  context: Awaited<ReturnType<typeof authorizeRequest>>,
) {
  if (action.action === "upsert_policy") {
    const beforePolicy = await getObservabilitySloPolicy(action.policy.id, {
      tenantId: context.tenantId,
    });
    const change = await requestObservabilitySloPolicyChange({
      policyId: action.policy.id,
      action: "upsert_policy",
      tenantId: context.tenantId,
      requestedBy: context.actorId,
      reason: action.reason || "Operator requested SLO policy update.",
      beforePolicy,
      afterPolicy: action.policy,
    });
    return { policies: [], change };
  }

  if (action.action === "toggle_policy") {
    const beforePolicy = await requirePolicy(action.id, context.tenantId);
    const afterPolicy = { ...beforePolicy, enabled: action.enabled };
    const change = await requestObservabilitySloPolicyChange({
      policyId: action.id,
      action: "toggle_policy",
      tenantId: context.tenantId,
      requestedBy: context.actorId,
      reason: action.reason || "Operator requested SLO policy enablement change.",
      beforePolicy,
      afterPolicy,
    });
    return { policies: [], change };
  }

  if (action.action === "delete_policy") {
    const beforePolicy = await requirePolicy(action.id, context.tenantId);
    const change = await requestObservabilitySloPolicyChange({
      policyId: action.id,
      action: "delete_policy",
      tenantId: context.tenantId,
      requestedBy: context.actorId,
      reason: action.reason || "Operator requested SLO policy deletion.",
      beforePolicy,
      afterPolicy: null,
    });
    return { policies: [], change };
  }

  if (action.action === "reset_defaults") {
    const beforePolicies = await listObservabilitySloPolicies({
      tenantId: context.tenantId,
      includeDisabled: true,
    });
    const change = await requestObservabilitySloPolicyChange({
      policyId: "defaults",
      action: "reset_defaults",
      tenantId: context.tenantId,
      requestedBy: context.actorId,
      reason: action.reason || "Operator requested default SLO policy reset.",
      beforePolicy: null,
      afterPolicy: null,
      metadata: {
        beforePolicies,
        defaultPolicyIds: getDefaultObservabilitySloPolicies().map((policy) => policy.id),
      },
    });
    return { policies: [], change };
  }

  if (action.action === "update_approval_policy") {
    const approvalPolicy = await saveObservabilitySloApprovalPolicyConfig(action.policy, {
      changedBy: context.actorId,
      changeReason: action.reason || "Operator updated SLO approval policy administration.",
      expectedVersion: action.expectedVersion,
    });
    return { policies: [], change: undefined, approvalPolicy };
  }

  if (action.action === "reset_approval_policy") {
    const approvalPolicy = await resetObservabilitySloApprovalPolicyConfig({
      changedBy: context.actorId,
      changeReason: action.reason || "Operator reset SLO approval policy administration.",
      expectedVersion: action.expectedVersion,
    });
    return { policies: [], change: undefined, approvalPolicy };
  }

  return rollbackObservabilitySloPolicyChange(action.changeId, {
    tenantId: context.tenantId,
    requestedBy: context.actorId,
    reason: action.reason,
    autoApply: false,
  });
}
