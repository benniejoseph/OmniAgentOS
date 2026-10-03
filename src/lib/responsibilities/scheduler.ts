import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithDatabaseSystemScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { canonicalAuthUserActorFromSecurityContext, canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { createWorkflowRun } from "@/lib/workflows/store";
import { reserveResponsibilityWake, settleResponsibilityWake, verifyLifecycle, verifyWake } from "./lifecycle-state";
import { persistRuntimeTransition, readRuntimeDraft, readRuntimeHead, readRuntimeWake, runtimeDatabaseNow, wakeFromRow, withResponsibilityRuntimeTransaction } from "./lifecycle-store";
import { assertSamePilot, nextPilotDue, resolveResponsibilityPilot, resolveRuntimeOwnerContext } from "./runtime-references";
import { RESPONSIBILITY_WORKFLOW_METADATA, runtimeExecutionAuthority, runtimeStopReason, runtimeWorkflowBinding, stopRuntime, touchRuntime } from "./runtime-state";
import { ResponsibilityError, storageInvalid, type ResponsibilityOwner } from "./state";
import { reconcileResponsibilityWake } from "./runtime";
import { RESPONSIBILITY_DUE_GRACE_MS } from "./runtime-contracts";

export const emptyResponsibilityScheduleSummary = () => ({ inspected: 0, enqueued: 0, reconciled: 0, blocked: 0, failed: 0 });
/** Existing protected scheduler entry points only. Enumeration returns opaque
 * owner/record coordinates; every read and write re-enters the exact owner. */
export async function processDueResponsibilities(input: { limit?: number; deadlineAt?: number; context?: SecurityContext } = {}) {
  const result = emptyResponsibilityScheduleSummary();
  if (!hasDatabaseUrl()) return result;
  await ensureDatabaseSchema();
  const limit = Math.min(20, Math.max(1, input.limit ?? 5));
  const canonical = input.context && canonicalAuthUserActorFromSecurityContext(input.context);
  if (input.context && !canonical) return result;
  const list = async () => {
    const sql = getSql();
    return input.context && canonical
      ? sql`SELECT tenant_id,actor_id,responsibility_id FROM omni_responsibility_lifecycles
          WHERE tenant_id = ${input.context.tenantId} AND actor_id = ${canonical.actorId}
            AND ((state = 'active' AND (next_due_at <= now() OR (snapshot #>> '{configuration,cadence,expiresAt}')::timestamptz <= now())) OR (snapshot #>> '{budget,reservedChecks}')::int > 0)
          ORDER BY next_due_at ASC NULLS FIRST,responsibility_id LIMIT ${limit}`
      : sql`SELECT tenant_id,actor_id,responsibility_id FROM omni_responsibility_lifecycles
          WHERE (state = 'active' AND (next_due_at <= now() OR (snapshot #>> '{configuration,cadence,expiresAt}')::timestamptz <= now())) OR (snapshot #>> '{budget,reservedChecks}')::int > 0
          ORDER BY next_due_at ASC NULLS FIRST,tenant_id,actor_id,responsibility_id LIMIT ${limit}`;
  };
  const rows = input.context && canonical ? await runWithDatabaseActorScope(input.context.tenantId, [canonical.actorId], list)
    : await runWithDatabaseSystemScope("Enumerate bounded opaque responsibility due/recovery owner coordinates.", list);
  for (const row of rows) {
    if (Date.now() >= (input.deadlineAt ?? Infinity)) break;
    if (typeof row.tenant_id !== "string" || typeof row.actor_id !== "string" || typeof row.responsibility_id !== "string") { result.failed++; continue; }
    const owner = { tenantId: row.tenant_id, actorId: row.actor_id }; result.inspected++;
    try {
      const selected = await prepareDueWake(owner, row.responsibility_id);
      if (selected === "reconciled" || selected === "blocked") { result[selected]++; continue; }
      if (selected && await enqueueResponsibilityWake(owner, row.responsibility_id, selected)) result.enqueued++;
    } catch { result.failed++; }
  }
  return result;
}
/** Internal admission seam also used by the real-database lifecycle harness;
 * the public scheduler intentionally exposes only content-free failure counts. */
export async function prepareDueWake(owner: ResponsibilityOwner, id: string) {
  return withResponsibilityRuntimeTransaction(owner, async (sql) => {
    const current = await readRuntimeHead(sql, owner, id); if (!current) return null;
    const now = await runtimeDatabaseNow(sql);
    const rows = await sql`SELECT * FROM omni_responsibility_wakes WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      AND responsibility_id = ${id} AND state NOT IN ('completed','failed','canceled') ORDER BY created_at,id LIMIT 2 FOR UPDATE`;
    if (rows.length > 1 || rows.length !== current.budget.reservedChecks) throw storageInvalid();
    if (rows[0]) {
      const wake = wakeFromRow(rows[0], owner, id);
      if (await runWithManagedDatabaseTransaction(sql, () => reconcileResponsibilityWake(getSql(), current, wake, now))) return "reconciled" as const;
      if (wake.state === "reserved") {
        try {
          const resolved = await resolveResponsibilityPilot(sql, owner, await readRuntimeDraft(sql, owner, id), now, false);
          assertSamePilot(resolved.configuration, current.configuration);
        } catch (error) {
          if (!(error instanceof ResponsibilityError)) throw error;
          const settled = settleResponsibilityWake({ current, wake, now, outcome: "canceled" });
          const reason = runtimeStopReason(error);
          const stopped = stopRuntime(current, reason, now);
          const next = verifyLifecycle({ ...stopped, budget: settled.current.budget, state: stopped.state === "ending" ? "ended" : stopped.state });
          await persistRuntimeTransition(sql, { previous: current, current: next, previousWake: wake, wake: settled.wake, action: "block",
            key: `${wake.id}:unstarted-refusal`, request: { wakeId: wake.id, reason } });
          return "blocked" as const;
        }
      }
      return wake.state === "reserved" ? wake.id : null;
    }
    if (current.state !== "active") return null;
    try {
      if (current.configuration.cadence.expiresAt <= now) throw new ResponsibilityError("Expired.", 409, "responsibility_expired");
      if (!current.nextDueAt || current.nextDueAt > now) return null;
      const resolved = await resolveResponsibilityPilot(sql, owner, await readRuntimeDraft(sql, owner, id), now, false);
      assertSamePilot(resolved.configuration, current.configuration);
      if (Date.parse(now) - Date.parse(current.nextDueAt) > RESPONSIBILITY_DUE_GRACE_MS) {
        const nextDueAt = nextPilotDue(resolved.schedule, now, current.budget.usedChecks);
        const next = verifyLifecycle({ ...touchRuntime(current, now), reason: "missed_skipped", nextDueAt });
        await persistRuntimeTransition(sql, { previous: current, current: next, action: "reconcile", key: `${id}:skip:${current.revision}`,
          request: { previousDueAt: current.nextDueAt, evaluatedThrough: now, outcome: "missed_skipped" } });
        return "reconciled" as const;
      }
      const next = reserveResponsibilityWake(current, now, nextPilotDue(resolved.schedule, now, current.budget.usedChecks + 1));
      await persistRuntimeTransition(sql, { previous: current, current: next.current, wake: next.wake, action: "reserve",
        key: `${next.wake.id}:reserve`, request: { responsibilityId: id, generation: current.generation, scheduledFor: current.nextDueAt } });
      return next.wake.id;
    } catch (error) {
      // Expected authority/freshness/limit refusals produce a content-free stop.
      // SQL/infrastructure errors propagate; a poisoned transaction cannot be
      // converted into a successful refusal receipt.
      if (!(error instanceof ResponsibilityError)) throw error;
      const reason = error.code === "responsibility_expired" ? "expired" : runtimeStopReason(error);
      const next = stopRuntime(current, reason, now);
      await persistRuntimeTransition(sql, { previous: current, current: next, action: "block",
        key: `${id}:stop:${current.revision}`, request: { revision: current.revision, reason } });
      return "blocked" as const;
    }
  });
}
/** Safe to repeat after process loss between reservation and queueing. The
 * deterministic run, existing workflow.tick job and enqueue receipt co-commit. */
export async function enqueueResponsibilityWake(owner: ResponsibilityOwner, id: string, wakeId: string) {
  const identity = await withResponsibilityRuntimeTransaction(owner, (sql) => resolveRuntimeOwnerContext(sql, owner));
  const binding = canonicalRequestActorBindingFromSecurityContext(identity);
  if (!binding) throw storageInvalid();
  return withResponsibilityRuntimeTransaction(owner, async (managerSql) => {
    const current = await readRuntimeHead(managerSql, owner, id); const wake = await readRuntimeWake(managerSql, owner, id, wakeId);
    if (!current || !wake || wake.state !== "reserved") return false;
    const now = await runtimeDatabaseNow(managerSql);
    if (await runWithManagedDatabaseTransaction(managerSql, () => reconcileResponsibilityWake(getSql(), current, wake, now))) return false;
    const resolved = await resolveResponsibilityPilot(managerSql, owner, await readRuntimeDraft(managerSql, owner, id), now, false);
    if (resolved.context.actorId !== identity.actorId) throw new ResponsibilityError("The current responsibility owner mapping changed.", 409, "responsibility_owner_revoked");
    assertSamePilot(resolved.configuration, current.configuration);
    return runWithManagedDatabaseTransaction(managerSql, async () => {
    const sql = getSql();
    const authority = runtimeExecutionAuthority(current, wake, resolved.context);
    const detail = await createWorkflowRun({ tenantId: owner.tenantId, goal: "Observe the exact reviewed native Meeting metadata.", mode: "execute", maxAttempts: 1,
      requireApproval: false, idempotencyKey: wake.id, budgetLimits: current.configuration.checkReservation, executionAuthority: authority,
      metadata: { [RESPONSIBILITY_WORKFLOW_METADATA]: runtimeWorkflowBinding(current, wake) } });
    if (canonicalJsonSha256(detail.run.input.metadata?.[RESPONSIBILITY_WORKFLOW_METADATA]) !== canonicalJsonSha256(runtimeWorkflowBinding(current, wake))) throw storageInvalid();
    // Dynamic import avoids the normal queue -> runner -> runtime module cycle.
    const { enqueueWorkflowRunTick } = await import("@/lib/workflows/queue");
    const job = await enqueueWorkflowRunTick(detail.run.id, "responsibility_due", undefined, owner.tenantId);
    const nextWake = verifyWake({ ...wake, revision: wake.revision + 1, state: "enqueued", workflowRunId: detail.run.id, operationJobId: job.id, updatedAt: now });
    await persistRuntimeTransition(sql, { previous: current, current: touchRuntime(current, now), previousWake: wake, wake: nextWake,
      action: "enqueue", key: `${wake.id}:enqueue`, request: { wakeId: wake.id, generation: wake.generation } });
    return true;
    });
  }, binding.readableOwnerActorIds);
}
