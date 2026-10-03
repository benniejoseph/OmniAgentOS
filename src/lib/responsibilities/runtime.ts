import { randomUUID } from "node:crypto";
import { getSql, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { parseMeetingRevision } from "@/lib/meetings/contracts";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { governedToolExecutionId } from "@/lib/tools/execution-id";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getWorkflowRunDetail, getWorkflowRunExecutionAuthority, transitionWorkflowRunWithEvents } from "@/lib/workflows/store";
import type { WorkflowRunDetail } from "@/lib/workflows/types";
import { withResponsibilityDispatchAdmission } from "./generation-fence";
import { isTerminalWake, settleResponsibilityWake, verifyWake } from "./lifecycle-state";
import { readRuntimeDraft, readRuntimeHead, readRuntimeWake, persistRuntimeTransition, runtimeDatabaseNow, withResponsibilityRuntimeTransaction } from "./lifecycle-store";
import { responsibilityBaselineSchema } from "./observation-contracts";
import { recordResponsibilityObservationWithSql } from "./observation-store";
import { assertSamePilot, resolveResponsibilityPilot, resolveRuntimeOwnerContext } from "./runtime-references";
import { RESPONSIBILITY_DUE_GRACE_MS, responsibilityWorkflowBindingSchema, type ResponsibilityLifecycle, type ResponsibilityWake } from "./runtime-contracts";
import { assertRuntimeWorkflow, fenced, RESPONSIBILITY_WORKFLOW_METADATA, touchRuntime } from "./runtime-state";
import { storageInvalid, type ResponsibilityOwner } from "./state";
import { reserveResponsibilityBudget } from "./cumulative-budget";
import { verifyLifecycle } from "./lifecycle-state";
import { admitObservedNotificationWithSql } from "./notification-store";

/** The only runner for this closed deterministic pilot. No plan/model/RAG or
 * provider effects. A durable start claim survives process loss, while the
 * governed read/audit, observation and budget terminal receipt co-commit. */
export async function tickResponsibilityWorkflow(detail: WorkflowRunDetail, options: { abortSignal?: AbortSignal; deadlineAt?: number } = {}): Promise<WorkflowRunDetail> {
  const binding = responsibilityWorkflowBindingSchema.parse(detail.run.input.metadata?.[RESPONSIBILITY_WORKFLOW_METADATA]);
  if (!detail.run.tenantId || !detail.run.input.executionAuthorityRequired) throw fenced();
  const owner = { tenantId: detail.run.tenantId, actorId: binding.ownerActorId };
  const token = randomUUID();
  const claim = await withResponsibilityRuntimeTransaction(owner, async (managerSql) => runWithManagedDatabaseTransaction(managerSql, async () => {
    const sql = getSql();
    const current = await readRuntimeHead(sql, owner, binding.responsibilityId);
    const wake = await readRuntimeWake(sql, owner, binding.responsibilityId, binding.wakeId);
    if (!current || !wake || wake.workflowRunId !== detail.run.id) throw fenced();
    if (isTerminalWake(wake)) return null;
    const now = await runtimeDatabaseNow(sql);
    if (wake.state === "running" || wake.state === "uncertain") return null;
    if (wake.state !== "enqueued") throw fenced();
    const workflowRows = await sql`SELECT status FROM omni_workflow_runs WHERE tenant_id = ${owner.tenantId} AND id = ${detail.run.id} FOR UPDATE`;
    if (workflowRows.length !== 1) throw fenced();
    if (["paused", "waiting_approval", "running"].includes(String(workflowRows[0].status))) return null;
    if (workflowRows[0].status !== "queued" || current.state !== "active" || current.generation !== wake.generation || current.configuration.cadence.expiresAt <= now ||
      Date.parse(now) - Date.parse(wake.scheduledFor) > RESPONSIBILITY_DUE_GRACE_MS || options.abortSignal?.aborted) {
      await terminal(sql, current, wake, now, "canceled"); return null;
    }
    const nextWake = verifyWake({ ...wake, revision: wake.revision + 1, state: "running", leaseGeneration: wake.leaseGeneration + 1,
      leaseTokenSha256: canonicalJsonSha256(token), leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString(), startedAt: now, updatedAt: now });
    const next = touchRuntime(current, now);
    await persistRuntimeTransition(sql, { previous: current, current: next, previousWake: wake, wake: nextWake, action: "start",
      key: `${wake.id}:start:${nextWake.leaseGeneration}`, request: { wakeId: wake.id, revision: wake.revision } });
    return { current: next, wake: nextWake };
  }));
  if (!claim) return requiredWorkflowDetail(detail.run.id, owner.tenantId);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(30_000, (options.deadlineAt ?? Date.now() + 30_000) - Date.now()))), ...(options.abortSignal ? [options.abortSignal] : [])]);
  try {
    // Resolve the current account only to establish the actor-scope subset.
    // Resolve and lock it again inside dispatch; changed aliases are refused.
    const identity = await withResponsibilityRuntimeTransaction(owner, (sql) => resolveRuntimeOwnerContext(sql, owner));
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(identity);
    if (!actorBinding) throw fenced();
    await withResponsibilityRuntimeTransaction(owner, async (managerSql) => {
      const current = await readRuntimeHead(managerSql, owner, binding.responsibilityId);
      const wake = await readRuntimeWake(managerSql, owner, binding.responsibilityId, binding.wakeId);
      if (!current || !wake || isTerminalWake(wake)) return;
      if (wake.leaseTokenSha256 !== canonicalJsonSha256(token) || wake.leaseGeneration !== claim.wake.leaseGeneration) throw fenced();
      const now = await runtimeDatabaseNow(managerSql);
      signal.throwIfAborted();
      if (current.state !== "active" || current.generation !== wake.generation || current.configuration.cadence.expiresAt <= now) throw fenced();
      const workflowRows = await managerSql`SELECT status FROM omni_workflow_runs WHERE tenant_id = ${owner.tenantId} AND id = ${detail.run.id} FOR UPDATE`;
      if (workflowRows.length !== 1 || workflowRows[0].status !== "queued") throw fenced();
      // The procedure read uses its existing memory RLS scope here, then
      // verifies cleanup. Row locks remain held by this same transaction.
      const resolved = await resolveResponsibilityPilot(managerSql, owner, await readRuntimeDraft(managerSql, owner, binding.responsibilityId), now, false);
      if (resolved.context.actorId !== identity.actorId) throw fenced();
      assertSamePilot(resolved.configuration, current.configuration);
      await runWithManagedDatabaseTransaction(managerSql, async () => {
        const sql = getSql();
        const authority = await getWorkflowRunExecutionAuthority(detail.run.id, { tenantId: owner.tenantId });
        assertRuntimeWorkflow(current, wake, { runId: detail.run.id, binding, authority, context: resolved.context });
        await withResponsibilityDispatchAdmission({ sql, current, wake, leaseToken: token, authorityExpiresAt: resolved.authorityExpiresAt }, async (admission) => {
        const executed = await executeGovernedTool({ toolId: current.configuration.tool.id, input: current.configuration.tool.input,
          context: resolved.context, requestActorBinding: actorBinding, executionScope: authority!.executionScope,
          dryRun: false, requireReadOnly: true, idempotencyKey: wake.id, abortSignal: signal, responsibilityAdmission: admission });
        signal.throwIfAborted();
        const output = object(executed.result); const meeting = parseMeetingRevision(output.meeting);
        if (executed.record.status !== "executed" || executed.record.id !== governedToolExecutionId(owner.tenantId, wake.id) ||
          !meeting || meeting.ownerActorId !== owner.actorId || meeting.meetingId !== current.configuration.source.id ||
          meeting.workspaceId !== current.configuration.source.workspaceId || meeting.tenantId !== owner.tenantId ||
          resolved.evidence.state !== "available" || meeting.meetingSha256 !== resolved.evidence.revisionSha256) throw storageInvalid();
        const baselineRows = await sql`SELECT snapshot FROM omni_responsibility_baselines WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${current.responsibilityId} FOR UPDATE`;
        if (baselineRows.length > 1) throw storageInvalid();
        const baseline = baselineRows[0] ? responsibilityBaselineSchema.parse(baselineRows[0].snapshot) : null;
        const observed = await recordResponsibilityObservationWithSql(sql, owner, { responsibilityId: current.responsibilityId,
          expectedResponsibilityRevision: current.configuration.responsibilityRevision, expectedReviewSha256: current.configuration.reviewSha256,
          expectedBaselineRevision: baseline?.revision ?? 0, policySha256: current.configuration.comparisonPolicySha256 }, wake.id, resolved.sourceReader, await runtimeDatabaseNow(sql));
        signal.throwIfAborted();
        if (!observed.replayed) await admitObservedNotificationWithSql(sql, owner, observed.receipt, observed.receipt.savedAt);
        await terminal(sql, current, wake, await runtimeDatabaseNow(sql), "completed", {
          id: observed.receipt.plan.observation.id, receiptSha256: observed.receipt.receiptSha256, outcome: observed.receipt.plan.outcome,
        });
        });
      });
    }, actorBinding.readableOwnerActorIds);
  } catch {
    // No outcome from a rejected/unknown commit is invented. Reacquiring the
    // same owner lock observes a committed terminal receipt if one exists;
    // otherwise the started reservation is retained for lease-expiry recovery.
    await withResponsibilityRuntimeTransaction(owner, async (sql) => {
      const current = await readRuntimeHead(sql, owner, binding.responsibilityId);
      const wake = await readRuntimeWake(sql, owner, binding.responsibilityId, binding.wakeId);
      if (!current || !wake || isTerminalWake(wake) || wake.state === "uncertain" || wake.leaseTokenSha256 !== canonicalJsonSha256(token)) return;
      const next = settleResponsibilityWake({ current, wake, now: await runtimeDatabaseNow(sql), outcome: "uncertain" });
      await persistRuntimeTransition(sql, { previous: current, current: next.current, previousWake: wake, wake: next.wake, action: "settle",
        key: `${wake.id}:uncertain:${wake.leaseGeneration}`, request: { wakeId: wake.id, leaseGeneration: wake.leaseGeneration } });
    });
  }
  return requiredWorkflowDetail(detail.run.id, owner.tenantId);
}

/** Called only under the owner lock. The closed read/audit/observation commit
 * is atomic; after its lease expires, reacquiring that lock proves no previous
 * dispatcher can still commit. A missing terminal receipt is reconciled as
 * failed and charged the full reserved upper bound, never as no-change. */
export async function reconcileResponsibilityWake(sql: SqlClient, current: ResponsibilityLifecycle, wake: ResponsibilityWake, now: string) {
  if (isTerminalWake(wake)) return false;
  if (wake.startedAt) {
    if (!wake.leaseExpiresAt || wake.leaseExpiresAt > now) return false;
    await terminal(sql, current, wake, now, "failed"); return true;
  }
  if (current.state !== "active" || current.generation !== wake.generation || current.configuration.cadence.expiresAt <= now || Date.parse(now) - Date.parse(wake.scheduledFor) > RESPONSIBILITY_DUE_GRACE_MS) {
    await terminal(sql, current, wake, now, "canceled"); return true;
  }
  if (wake.workflowRunId) {
    const detail = await getWorkflowRunDetail(wake.workflowRunId, { tenantId: current.tenantId });
    if (!detail || ["completed", "failed", "canceled"].includes(detail.run.status)) {
      if (!detail) throw fenced();
      await terminal(sql, current, wake, now, "canceled"); return true;
    }
  }
  return false;
}
async function terminal(sql: SqlClient, current: ResponsibilityLifecycle, wake: ResponsibilityWake, now: string, outcome: "completed" | "failed" | "canceled",
  observation?: { id: string; receiptSha256: string; outcome: string }) {
  const next = settleResponsibilityWake({ current, wake, now, outcome, observation });
  if (next.current.state === "active") {
    let reason: "authority_changed" | "budget_exhausted" | undefined = outcome === "failed" ? "authority_changed" : undefined;
    if (!reason) {
      try { reserveResponsibilityBudget(next.current.budget, next.current.configuration.checkReservation); }
      catch { reason = "budget_exhausted"; }
    }
    if (reason) next.current = verifyLifecycle({ ...next.current, state: reason === "budget_exhausted" ? "ended" : "blocked",
      generation: next.current.generation + 1, reason, nextDueAt: null });
  }
  await persistRuntimeTransition(sql, { previous: current, current: next.current, previousWake: wake, wake: next.wake, action: "reconcile",
    key: `${wake.id}:terminal`, request: { wakeId: wake.id, outcome, observationId: observation?.id ?? null } });
  if (wake.workflowRunId) {
    const authority = await getWorkflowRunExecutionAuthority(wake.workflowRunId, { tenantId: current.tenantId });
    if (!authority) throw fenced();
    const updated = await transitionWorkflowRunWithEvents(wake.workflowRunId, ["queued", "running", "paused", "waiting_approval"],
      { status: outcome, completedAt: now, result: { responsibilityId: current.responsibilityId, wakeId: wake.id,
        observationId: observation?.id ?? null, outcome: observation?.outcome ?? outcome, generation: wake.generation,
        charged: next.wake.charged, chargeBasis: "reserved_upper_bound", notificationCreated: false },
        ...(outcome === "failed" ? { error: "Responsibility read did not commit a confirmed observation." } : {}) },
      [{ type: "responsibility.workflow.settled", payload: { responsibilityId: current.responsibilityId, wakeId: wake.id, outcome } }],
      { tenantId: current.tenantId, executionAuthority: authority });
    // A user may cancel the generic workflow before this reconciliation. Its
    // terminal status is retained; the responsibility receipt remains exact.
    if (!updated) {
      const existing = await getWorkflowRunDetail(wake.workflowRunId, { tenantId: current.tenantId });
      if (!existing || !["completed", "failed", "canceled"].includes(existing.run.status)) throw fenced();
    }
  }
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function requiredWorkflowDetail(id: string, tenantId: string) {
  const detail = await getWorkflowRunDetail(id, { tenantId }); if (!detail) throw fenced(); return detail;
}

export type RuntimeOwner = ResponsibilityOwner;
