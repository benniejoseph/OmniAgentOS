BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 245 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 245
      AND name = 'native_provider_function_acl_repair_v1'
      AND checksum = '3d1e2f480d424d4f6da66008744928f883ee06745e32b147a26953c73c7c09f0'
  ) <> 1 THEN
    RAISE EXCEPTION 'Research workflow notification predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- A requested background research result has its own target. Never encode a
-- workflow ID as an agent-run target; native contract 49 introduces this cause.
ALTER TABLE public.omni_mobile_push_deliveries
  DROP CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v3;
ALTER TABLE public.omni_mobile_push_deliveries
  ADD CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v4 CHECK (
    cause_kind COLLATE "C" IN (
      'approval', 'work_item', 'meeting', 'customer', 'run',
      'notification', 'canary', 'research'
    )
  ) NOT VALID;
ALTER TABLE public.omni_mobile_push_deliveries
  VALIDATE CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v4;

ALTER TABLE public.omni_notification_dispositions
  DROP CONSTRAINT omni_notification_dispositions_source_kind_check;
ALTER TABLE public.omni_notification_dispositions
  ADD CONSTRAINT omni_notification_dispositions_source_kind_check CHECK (
    source_kind IN (
      'tool_approval', 'meeting', 'customer_risk', 'agent_run', 'today_reminder',
      'delegated_task', 'scheduled_routine', 'security_incident',
      'responsibility_change', 'research_workflow'
    )
  );
ALTER TABLE public.omni_notification_dispositions
  DROP CONSTRAINT omni_notification_dispositions_reason_check;
ALTER TABLE public.omni_notification_dispositions
  ADD CONSTRAINT omni_notification_dispositions_reason_check CHECK (
    reason IN (
      'approval_required', 'security_alert', 'actionable_failure', 'meeting_imminent',
      'critical_delivery', 'quiet_hours', 'cooldown_active', 'digest_nonurgent',
      'digest_during_cooldown', 'routine_success', 'failure_not_actionable',
      'meeting_not_imminent', 'not_worthy', 'material_change', 'research_ready'
    )
  );
ALTER TABLE public.omni_notification_dispositions
  ADD CONSTRAINT omni_notification_dispositions_research_policy CHECK (
    source_kind <> 'research_workflow' OR (
      must_send AND NOT critical AND outcome IN ('send', 'defer')
      AND reason IN ('research_ready', 'actionable_failure', 'quiet_hours', 'cooldown_active')
      AND (delivery_kind IS NULL OR delivery_kind = 'mobile_push_outbox')
    )
  );

-- The producer selects metadata only, keeps owner/tenant scope explicit, and
-- rechecks the exact terminal occurrence and authority before delivery.
CREATE INDEX omni_workflow_runs_research_notification_idx
  ON public.omni_workflow_runs (tenant_id, COALESCE(completed_at, updated_at) DESC)
  WHERE status IN ('completed', 'failed')
    AND input ->> 'mode' = 'research'
    AND input -> 'metadata' -> 'researchOptionsV1' ->> 'depth' = 'deep';

INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (246, 'research_workflow_notifications_v1',
  '9399238975ab8f6af3d0df6f56d6432bbbcd67110385d77ddff4f7cdd6960873', clock_timestamp());
COMMIT;
