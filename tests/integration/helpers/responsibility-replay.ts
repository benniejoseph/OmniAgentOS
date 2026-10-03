import type postgres from "postgres";
import { expect } from "vitest";

/** Historical replay removes only empty, disposable notification authority and
 * restores the pre-v219 contract on existing notification tables. */
export async function removeEmptyResponsibilityNotificationsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT
    (SELECT count(*)::int FROM public.omni_responsibility_notification_admissions) AS admissions,
    (SELECT count(*)::int FROM public.omni_responsibility_notification_candidates) AS candidates,
    (SELECT count(*)::int FROM public.omni_responsibility_notification_receipts) AS receipts,
    (SELECT count(*)::int FROM public.omni_personal_notifications WHERE kind = 'responsibility_change') AS inbox,
    (SELECT count(*)::int FROM public.omni_notification_dispositions WHERE source_kind = 'responsibility_change') AS dispositions
  `).toEqual([{ admissions: 0, candidates: 0, receipts: 0, inbox: 0, dispositions: 0 }]);
  await sql`DROP TRIGGER omni_notification_dispositions_responsibility_receipt ON public.omni_notification_dispositions`;
  await sql`DROP TRIGGER omni_personal_notifications_responsibility_receipt ON public.omni_personal_notifications`;
  await sql`DROP TRIGGER omni_personal_notifications_responsibility_guard ON public.omni_personal_notifications`;
  await sql`DROP TABLE public.omni_responsibility_notification_receipts`;
  await sql`DROP TABLE public.omni_responsibility_notification_candidates`;
  await sql`DROP TABLE public.omni_responsibility_notification_admissions`;
  await sql`DROP FUNCTION public.omni_require_responsibility_notification_commit_v1()`;
  await sql`DROP FUNCTION public.omni_admit_responsibility_notification_receipt_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_notification_candidate_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_notification_head_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_inbox_v1()`;
  await sql`ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_responsibility_channel`;
  await sql`ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_source_kind_check`;
  await sql`ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_source_kind_check CHECK (source_kind IN (
    'tool_approval','meeting','customer_risk','agent_run','today_reminder','delegated_task','scheduled_routine','security_incident'))`;
  await sql`ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_reason_check`;
  await sql`ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_reason_check CHECK (reason IN (
    'approval_required','security_alert','actionable_failure','meeting_imminent','critical_delivery','quiet_hours','cooldown_active','digest_nonurgent',
    'digest_during_cooldown','routine_success','failure_not_actionable','meeting_not_imminent','not_worthy'))`;
}

/** Only the guarded historical migration fixtures call this, on empty runtime
 * tables. Restore the predecessor policy as well as its object inventory. */
export async function removeEmptyResponsibilityRuntimeForReplay(sql: postgres.TransactionSql) {
  await removeEmptyResponsibilityNotificationsForReplay(sql);
  expect(await sql`SELECT
    (SELECT count(*)::int FROM public.omni_responsibility_lifecycles) AS lifecycles,
    (SELECT count(*)::int FROM public.omni_responsibility_wakes) AS wakes,
    (SELECT count(*)::int FROM public.omni_responsibility_runtime_receipts) AS receipts,
    (SELECT count(*)::int FROM public.omni_responsibility_budget_entries) AS budgets
  `).toEqual([{ lifecycles: 0, wakes: 0, receipts: 0, budgets: 0 }]);
  await sql`DROP TABLE public.omni_responsibility_budget_entries`;
  await sql`DROP TABLE public.omni_responsibility_runtime_receipts`;
  await sql`DROP TABLE public.omni_responsibility_wakes`;
  await sql`DROP TABLE public.omni_responsibility_lifecycles`;
  await sql`DROP FUNCTION public.omni_require_responsibility_runtime_commit_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_runtime_receipt_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_runtime_wake_v1()`;
  await sql`DROP FUNCTION public.omni_protect_responsibility_runtime_head_v1()`;
  await sql`ALTER POLICY omni_memory_user_private_update_purpose ON public.omni_memories USING (
    (SELECT omni_system_scope_enabled())
    OR (access_contract_version = 0 AND (SELECT omni_current_memory_access_scope_v1()) IS NULL)
    OR (access_contract_version = 1 AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
      IN ('memory.write.v1','memory.correct.v1','memory.forget.v1','memory.maintenance.v1'))
  )`;
  await sql`ALTER POLICY omni_memory_lifecycle_states_update_purpose ON public.omni_memory_lifecycle_states USING (
    (SELECT omni_system_scope_enabled()) OR access_contract_version = 0
    OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' = 'memory.maintenance.v1'
  )`;
}
