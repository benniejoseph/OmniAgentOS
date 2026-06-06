import { z } from "zod";
import { getIncidentAlertTargets } from "@/lib/diagnostics/incidents";
import {
  deleteObservabilitySloPolicy,
  getDefaultObservabilitySloPolicies,
  getObservabilitySloPolicy,
  listObservabilitySloPolicies,
  resetObservabilitySloPolicies,
  saveObservabilitySloPolicy,
} from "@/lib/observability/slo-policy-store";
import { getObservabilitySloSnapshot } from "@/lib/observability/slo-monitor";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const metrics = ["errorRate", "availability", "latencyP95Ms", "routeFailures"] as const;
const comparators = ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"] as const;
const severities = ["info", "warning", "critical"] as const;
const units = ["ratio", "ms", "count"] as const;

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
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert_policy"),
    policy: policySchema,
  }),
  z.object({
    action: z.literal("toggle_policy"),
    id: z.string().min(2).max(80),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal("reset_defaults"),
  }),
  z.object({
    action: z.literal("delete_policy"),
    id: z.string().min(2).max(80),
  }),
]);

export async function GET(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "slo-policies");

  try {
    await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "observability_slo_policy",
      metadata: { includeDisabled: true },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const [policies, snapshot] = await Promise.all([
      listObservabilitySloPolicies({ includeDisabled: true }),
      getObservabilitySloSnapshot(),
    ]);
    await recordRuntimeEventSafely({
      category: "api",
      action: "observability.slo_policies.read",
      route: "/api/observability/slo/policies",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "observability_slo_policy",
      message: "Read observability SLO policies.",
      metadata: { policies: policies.length, enabled: policies.filter((policy) => policy.enabled).length },
    });
    return Response.json({
      policies,
      defaults: getDefaultObservabilitySloPolicies(),
      alertTargets: getIncidentAlertTargets("critical"),
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
      resourceType: "observability_slo_policy",
      message: "Observability SLO policy read failed.",
      metadata: { error: error instanceof Error ? error.message : "SLO policy read failed." },
    });
    return Response.json({ error: "Observability SLO policy read failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "slo-policies");
  const parsed = actionSchema.safeParse(await request.json().catch(() => ({})));

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
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const policies = parsed.data.action === "reset_defaults"
      ? await resetObservabilitySloPolicies()
      : parsed.data.action === "toggle_policy"
        ? [await saveObservabilitySloPolicy({
            ...(await requirePolicy(parsed.data.id)),
            enabled: parsed.data.enabled,
          })]
        : parsed.data.action === "delete_policy"
          ? (await deleteObservabilitySloPolicy(parsed.data.id), [])
        : [await saveObservabilitySloPolicy(parsed.data.policy)];
    const snapshot = await getObservabilitySloSnapshot();
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
        policyIds: policies.map((policy) => policy.id),
        enabled: policies.filter((policy) => policy.enabled).length,
      },
    });
    return Response.json({
      policies: await listObservabilitySloPolicies({ includeDisabled: true }),
      changed: policies,
      alertTargets: getIncidentAlertTargets("critical"),
      snapshot,
    });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: `observability.slo_policies.${parsed.data.action}.failed`,
      route: "/api/observability/slo/policies",
      method: "POST",
      statusCode: 500,
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
      { error: error instanceof Error ? error.message : "Observability SLO policy update failed." },
      { status: 500 },
    );
  }
}

async function requirePolicy(policyId: string) {
  const policy = await getObservabilitySloPolicy(policyId);
  if (!policy) {
    throw new Error(`SLO policy ${policyId} was not found.`);
  }
  return policy;
}
