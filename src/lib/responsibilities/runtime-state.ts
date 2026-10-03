import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { WorkflowExecutionAuthority } from "@/lib/workflows/store";
import { RESPONSIBILITY_EXECUTION_PURPOSE } from "./generation-fence";
import { verifyLifecycle, verifyWake } from "./lifecycle-state";
import { RESPONSIBILITY_RUNTIME_CONTRACT, responsibilityWorkflowBindingSchema, type ResponsibilityLifecycle, type ResponsibilityWake, type ResponsibilityRuntimeReason } from "./runtime-contracts";
import { ResponsibilityError } from "./state";

export const RESPONSIBILITY_WORKFLOW_METADATA = "responsibilityRuntime";
export function runtimeWorkflowBinding(current: ResponsibilityLifecycle, wake: ResponsibilityWake) {
  return responsibilityWorkflowBindingSchema.parse({ schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT,
    responsibilityId: current.responsibilityId, wakeId: wake.id, generation: wake.generation,
    configurationSha256: wake.configurationSha256, ownerActorId: current.actorId });
}
export function runtimeExecutionAuthority(current: ResponsibilityLifecycle, wake: ResponsibilityWake, context: SecurityContext): WorkflowExecutionAuthority {
  if (canonicalAuthUserActorFromSecurityContext(context)?.actorId !== current.actorId || context.tenantId !== current.tenantId) throw fenced();
  return { requesterRole: context.role, executionScope: createExecutionScope({ tenantId: current.tenantId,
    // Existing governed first-party calls require the authenticated request
    // coordinate. Its canonical owner is independently checked above.
    initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: current.configuration.pins.agent.id,
    workspaceId: current.configuration.pins.work.workspaceId, projectId: current.configuration.pins.work.projectId,
    purpose: RESPONSIBILITY_EXECUTION_PURPOSE, correlationId: wake.id, causationId: wake.id }) };
}
export function assertRuntimeWorkflow(current: ResponsibilityLifecycle, wake: ResponsibilityWake, input: {
  runId: string; binding: unknown; authority?: WorkflowExecutionAuthority; context: SecurityContext;
}) {
  verifyLifecycle(current); verifyWake(wake);
  const checked = responsibilityWorkflowBindingSchema.safeParse(input.binding);
  if (!checked.success || wake.workflowRunId !== input.runId ||
    canonicalJsonSha256(checked.data) !== canonicalJsonSha256(runtimeWorkflowBinding(current, wake)) ||
    canonicalJsonSha256(input.authority ?? null) !== canonicalJsonSha256(runtimeExecutionAuthority(current, wake, input.context))) throw fenced();
}
export function runtimeStopReason(error: unknown): ResponsibilityRuntimeReason {
  if (error instanceof ResponsibilityError) {
    if (error.code === "responsibility_meeting_started") return "meeting_started";
    if (error.code === "responsibility_meeting_canceled") return "meeting_canceled";
    if (error.code === "responsibility_budget_exhausted") return "budget_exhausted";
    if (error.code === "responsibility_source_unavailable") return "source_unavailable";
  }
  return "authority_changed";
}
export function stopRuntime(current: ResponsibilityLifecycle, reason: ResponsibilityRuntimeReason, now: string) {
  return verifyLifecycle({ ...current, revision: current.revision + 1, generation: current.generation + 1,
    state: ["expired", "meeting_started", "meeting_canceled", "budget_exhausted"].includes(reason) ? current.budget.reservedChecks ? "ending" : "ended" : "blocked",
    reason, nextDueAt: null, updatedAt: now });
}
export function touchRuntime(current: ResponsibilityLifecycle, now: string) {
  return verifyLifecycle({ ...current, revision: current.revision + 1, updatedAt: now });
}
export function fenced() { return new ResponsibilityError("This exact responsibility workflow is no longer admitted.", 409, "responsibility_generation_fenced"); }
