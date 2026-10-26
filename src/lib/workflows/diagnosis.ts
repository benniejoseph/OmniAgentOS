import { z } from "zod";
import { redactSensitive } from "@/lib/security/context";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

const modelFailureSchema = z.object({
  schemaVersion: z.literal(1),
  modelStep: z.enum(["plan", "report", "review"]),
  kind: z.enum(["abort", "authentication", "context_length", "invalid_request", "overloaded", "rate_limit", "safety", "timeout", "unavailable", "unknown", "completion_not_saved"]),
  timeoutMs: z.number().int().min(0).max(3_600_000),
  elapsedMs: z.number().int().min(0).max(3_600_000),
});
const phases = new Set(["searching", "reading", "writing", "reviewing", "complete"]);

/** Compact read-only evidence for the admitted agent. It grants no recovery
 * authority and precedes potentially large source/step bodies in tool results. */
export function diagnoseWorkflow(detail: WorkflowRunDetail) {
  const { run } = detail;
  const currentStep = detail.steps.find(step => step.workflowRunId === run.id && step.stepKey === run.currentStep);
  const state = record(currentStep?.output?.researchStateV1);
  const pause = run.status === "paused" ? detail.events
    .filter(event => event.workflowRunId === run.id && event.tenantId === run.tenantId &&
      event.type === "workflow.paused" &&
      Date.parse(event.createdAt) >= Date.parse(run.pausedAt || run.updatedAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] : undefined;
  const failure = modelFailureSchema.safeParse(pause?.payload.modelFailure);
  const interruptedModel = pause?.payload.reason === "research_model_receipt_missing";
  const classification = run.status === "paused"
    ? interruptedModel ? "model_completion_unconfirmed" : "paused"
    : run.status;
  const signal = run.status === "paused" ? "resume" : run.status === "failed" ? "retry" : null;
  return {
    workflowId: run.id,
    observedUpdatedAt: run.updatedAt,
    status: run.status,
    classification,
    currentStep: run.currentStep || null,
    reason: boundedText(run.error || currentStep?.error),
    ...(failure.success ? { modelFailure: failure.data } : {}),
    ...(state?.schemaVersion === 1 ? { retainedResearch: {
      phase: typeof state.phase === "string" && phases.has(state.phase) ? state.phase : "unknown",
      searches: boundedCount(state.searches, 10),
      sourcesRead: boundedCount(state.reads, 18),
      draftSaved: typeof state.response === "string" && state.response.trim().length > 0,
      researchQuestionsAreUserClarifications: false,
    } } : {}),
    recovery: {
      toolId: signal ? "app.workflows.signal" : null,
      signal,
      requiresUserRequest: signal !== null,
      subjectToGovernedApproval: signal !== null,
      priorModelCompletionUnknown: interruptedModel,
      mayStartNewPaidAttempt: interruptedModel,
      preservesSavedWorkAndBudgets: signal === "resume",
      instruction: signal
        ? `For an authorized ${signal}, submit one governed signal for this workflow, then read it again. A new pause requires a new diagnosis; do not loop or create a replacement workflow.`
        : "Read current evidence; this snapshot does not authorize starting, approving, or replaying work.",
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function boundedCount(value: unknown, max: number) {
  return Array.isArray(value) ? Math.min(value.length, max) : 0;
}
function boundedText(value: unknown) {
  return typeof value === "string" ? String(redactSensitive(value)).slice(0, 1_000) : null;
}
