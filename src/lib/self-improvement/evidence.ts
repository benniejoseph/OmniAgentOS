import type { z } from "zod";
import { buildExecutionFailureFixture } from "@/lib/agents/execution-improvement";
import type { AgentRunRecord } from "@/lib/runs/types";
import { redactSensitive } from "@/lib/security/context";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import {
  engineeringSignalBodySchema, engineeringSignalSchema, selfImprovementScopeSchema, selfImprovementSha256,
  type EngineeringObservation, type EngineeringSignal, type SelfImprovementScope,
} from "@/lib/self-improvement/contracts";

export function sealEngineeringSignal(input: z.input<typeof engineeringSignalBodySchema>): EngineeringSignal {
  const body = engineeringSignalBodySchema.parse(input);
  body.observations.sort((left, right) => `${left.observedAt}:${left.sourceKind}:${left.sourceId}`.localeCompare(`${right.observedAt}:${right.sourceKind}:${right.sourceId}`));
  const signalSha256 = selfImprovementSha256("engineering_signal", body);
  return engineeringSignalSchema.parse({ ...body, id: `self_signal_${signalSha256}`, signalSha256 });
}

const priorities: Readonly<Record<EngineeringSignal["kind"], number>> = {
  regression: 0, recurrent_tool_failure: 1, failed_run: 2, owner_correction: 3, code_defect: 4, performance_regression: 5, requested_enhancement: 6,
};

export type EngineeringSignalSelection = Readonly<{
  outcome: "selected" | "no_change";
  signal: EngineeringSignal | null;
  examined: number;
  ignored: Readonly<Record<string, number>>;
  selectionSha256: string;
}>;

/** Pure selection. Input must come from scoped, canonical readers, never a model-authored issue list. */
export function selectEngineeringSignal(input: {
  scope: SelfImprovementScope;
  signals: readonly EngineeringSignal[];
  now: string;
  previouslyHandledSymptomSha256?: readonly string[];
  maxAgeMs?: number;
}): EngineeringSignalSelection {
  const scope = selfImprovementScopeSchema.parse(input.scope);
  const now = Date.parse(input.now);
  const maxAgeMs = input.maxAgeMs ?? 7 * 86_400_000;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 31 * 86_400_000) throw new Error("Engineering observation window is invalid.");
  const ignored: Record<string, number> = {};
  const skip = (reason: string) => { ignored[reason] = (ignored[reason] || 0) + 1; };
  const handled = new Set(input.previouslyHandledSymptomSha256 || []);
  const eligible: EngineeringSignal[] = [];
  const seen = new Set<string>();
  for (const item of input.signals) {
    const parsed = engineeringSignalSchema.safeParse(item);
    if (!parsed.success) { skip("invalid_evidence"); continue; }
    const signal = parsed.data;
    if (selfImprovementSha256("scope", scope) !== selfImprovementSha256("scope", signal.scope)) { skip("foreign_scope"); continue; }
    if (seen.has(signal.signalSha256)) { skip("duplicate"); continue; }
    seen.add(signal.signalSha256);
    if (handled.has(signal.symptomSha256)) { skip("already_handled"); continue; }
    if (signal.observations.some((observation) => Date.parse(observation.observedAt) > now || now - Date.parse(observation.observedAt) > maxAgeMs)) { skip("outside_observation_window"); continue; }
    // A single incidental failure is recorded but does not initiate an autonomous repair.
    if (["recurrent_tool_failure", "failed_run", "performance_regression"].includes(signal.kind) && signal.observations.length < 2) { skip("insufficient_recurrence"); continue; }
    eligible.push(signal);
  }
  eligible.sort((left, right) => priorities[left.kind] - priorities[right.kind] ||
    right.observations.length - left.observations.length || left.signalSha256.localeCompare(right.signalSha256));
  const body = { outcome: eligible.length ? "selected" as const : "no_change" as const, signal: eligible[0] || null, examined: input.signals.length, ignored };
  return Object.freeze({ ...body, selectionSha256: selfImprovementSha256("signal_selection", body) });
}

function safeSummary(value: string): string {
  return String(redactSensitive(value)).replace(/\s+/g, " ").slice(0, 1_000).trim() || "Recorded execution failure.";
}

/** Converts existing execution evidence; it neither runs a model nor replays a side effect. */
export function collectEngineeringSignalsFromRuns(input: {
  scope: SelfImprovementScope;
  runs: readonly Readonly<{ run: AgentRunRecord; receipts: readonly ToolExecutionRecord[] }>[];
}): EngineeringSignal[] {
  const scope = selfImprovementScopeSchema.parse(input.scope);
  const groups = new Map<string, { kind: EngineeringSignal["kind"]; summary: string; observations: Map<string, EngineeringObservation> }>();
  const add = (kind: EngineeringSignal["kind"], symptom: unknown, summary: string, observation: EngineeringObservation) => {
    const symptomSha256 = selfImprovementSha256("symptom", { kind, symptom });
    const group = groups.get(symptomSha256) || { kind, summary: safeSummary(summary), observations: new Map() };
    const key = `${observation.sourceKind}:${observation.sourceId}`;
    const prior = group.observations.get(key);
    // Contradictory versions of the same canonical receipt cannot create recurrence.
    if (prior && prior.sourceSha256 !== observation.sourceSha256) throw new Error("Conflicting engineering source receipt versions.");
    group.observations.set(key, observation);
    groups.set(symptomSha256, group);
  };
  for (const { run, receipts } of input.runs) {
    if (run.tenantId !== scope.tenantId || run.ownerActorId !== scope.ownerActorId) continue;
    const scopedReceipts = receipts.filter((receipt) => receipt.tenantId === scope.tenantId && receipt.actorId === scope.ownerActorId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const fixture = buildExecutionFailureFixture(run, scopedReceipts);
    if (run.status === "failed" && run.error && run.completedAt) {
      const error = safeSummary(run.error);
      add("failed_run", { error }, error, { sourceKind: "run", sourceId: run.id, sourceSha256: fixture.fixtureSha256, observedAt: run.completedAt, outcome: "failed" });
    }
    if (run.feedback?.verdict === "needs_work" && run.feedback.correction?.trim()) {
      const correction = safeSummary(run.feedback.correction);
      add("owner_correction", { correction }, correction, {
        sourceKind: "owner_feedback", sourceId: run.id, sourceSha256: selfImprovementSha256("owner_feedback", { runId: run.id, feedback: run.feedback, fixtureSha256: fixture.fixtureSha256 }), observedAt: run.feedback.updatedAt, outcome: "needs_work",
      });
    }
    for (const receipt of scopedReceipts) {
      if (receipt.status !== "failed" || receipt.dryRun) continue;
      const reason = safeSummary(receipt.reason || "Tool execution failed without a recorded reason.");
      add("recurrent_tool_failure", { toolId: receipt.toolId, reason }, `${receipt.toolId}: ${reason}`, {
        sourceKind: "tool_execution", sourceId: receipt.id,
        sourceSha256: selfImprovementSha256("tool_failure", { executionId: receipt.id, tenantId: receipt.tenantId, actorId: receipt.actorId, toolId: receipt.toolId, status: receipt.status, reason: receipt.reason || null, createdAt: receipt.createdAt, completedAt: receipt.completedAt || null }),
        observedAt: receipt.completedAt || receipt.createdAt, outcome: "failed",
      });
    }
  }
  return [...groups].map(([symptomSha256, group]) => sealEngineeringSignal({ version: 1, scope, kind: group.kind, symptomSha256, summary: group.summary, observations: [...group.observations.values()].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.sourceId.localeCompare(right.sourceId)).slice(0, 100) }))
    .sort((left, right) => left.signalSha256.localeCompare(right.signalSha256));
}
