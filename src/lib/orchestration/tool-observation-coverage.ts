import { AvailabilityObservationSchema } from "@/lib/availability-watches/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ToolExecutionRecord } from "@/lib/tools/types";

/** Describes observed evidence without turning execution into claim verification. */
export function toolObservationCoverage(record: ToolExecutionRecord, result: unknown) {
  if (record.status !== "executed" || record.dryRun) return { execution: record.status, source: "not_observed", claims: "not_assessed", goal: "not_assessed" };
  if (record.toolId === "web.availability.inspect") {
    const parsed = AvailabilityObservationSchema.safeParse(result);
    if (parsed.success) return { execution: "executed", source: "observed", kind: "structured_provider",
      url: parsed.data.sourceUrl, capturedAt: parsed.data.checkedAt, providerObservedAt: parsed.data.providerObservedAt,
      contentSha256: parsed.data.sourceSha256, scope: parsed.data.scope, claims: "requires_field_comparison", goal: "not_assessed" };
  }
  return { execution: "executed", source: record.riskLevel === 0 ? "observed" : "effect_receipt_required", kind: "governed_result",
    executionId: record.id, contentSha256: canonicalJsonSha256(result ?? null), capturedAt: record.completedAt || record.createdAt,
    claims: "not_assessed", goal: "not_assessed" };
}
