BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 196 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 196
      AND name = 'delegation_execution_runtime_v1'
      AND checksum = '0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac'
  ) <> 1 THEN
    RAISE EXCEPTION 'Scheduled workflow trigger predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Schedule metadata extends the existing workflow-trigger runtime. It does
-- not create a second workflow engine and the public dispatcher remains
-- webhook-only. The shadow cursor is deliberately separate from next_due_at.
ALTER TABLE public.omni_workflow_triggers
  ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'webhook',
  ADD COLUMN owner_actor_id TEXT,
  ADD COLUMN schedule_config JSONB,
  ADD COLUMN schedule_config_sha256 TEXT,
  ADD COLUMN agent_identity_pin_sha256 TEXT,
  ADD COLUMN policy_pin_sha256 TEXT,
  ADD COLUMN procedure_snapshot_sha256 TEXT,
  ADD COLUMN reviewed_snapshot_sha256 TEXT,
  ADD COLUMN occurrence_budget_sha256 TEXT,
  ADD COLUMN next_due_at TIMESTAMPTZ,
  ADD COLUMN shadow_next_due_at TIMESTAMPTZ,
  ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN failure_limit INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN circuit_state TEXT NOT NULL DEFAULT 'closed',
  ADD COLUMN paused_reason TEXT,
  ADD COLUMN last_failure_at TIMESTAMPTZ,
  ADD COLUMN circuit_opened_at TIMESTAMPTZ,
  ADD COLUMN shadow_occurrence_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN shadow_evaluated_at TIMESTAMPTZ;

ALTER TABLE public.omni_workflow_triggers
  ADD CONSTRAINT omni_workflow_triggers_tenant_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT omni_workflow_triggers_kind_check
    CHECK (trigger_kind IN ('webhook', 'schedule')),
  ADD CONSTRAINT omni_workflow_triggers_schedule_state_check CHECK (
    occurrence_count BETWEEN 0 AND 10000
    AND shadow_occurrence_count BETWEEN 0 AND 10000
    AND consecutive_failure_count BETWEEN 0 AND 20
    AND failure_limit BETWEEN 1 AND 20
    AND circuit_state IN ('closed', 'open', 'half_open')
    AND (paused_reason IS NULL OR char_length(paused_reason) BETWEEN 1 AND 500)
  ),
  ADD CONSTRAINT omni_workflow_triggers_schedule_contract_check CHECK (
    (
      trigger_kind = 'webhook'
      AND owner_actor_id IS NULL
      AND schedule_config IS NULL
      AND schedule_config_sha256 IS NULL
      AND agent_identity_pin_sha256 IS NULL
      AND policy_pin_sha256 IS NULL
      AND procedure_snapshot_sha256 IS NULL
      AND reviewed_snapshot_sha256 IS NULL
      AND occurrence_budget_sha256 IS NULL
      AND next_due_at IS NULL
      AND shadow_next_due_at IS NULL
    ) OR (
      trigger_kind = 'schedule'
      AND owner_actor_id IS NOT NULL
      AND char_length(owner_actor_id) BETWEEN 1 AND 320
      AND jsonb_typeof(schedule_config) = 'object'
      AND schedule_config->>'schemaVersion' = '1'
      AND schedule_config->>'configSha256' = schedule_config_sha256
      AND schedule_config->'agentIdentityPin'->>'pinSha256' = agent_identity_pin_sha256
      AND schedule_config->>'policyPinSha256' = policy_pin_sha256
      AND schedule_config->'procedurePin'->>'snapshotSha256' = procedure_snapshot_sha256
      AND schedule_config->'procedurePin'->>'reviewedSnapshotSha256' = reviewed_snapshot_sha256
      AND schedule_config_sha256 ~ '^[a-f0-9]{64}$'
      AND agent_identity_pin_sha256 ~ '^[a-f0-9]{64}$'
      AND policy_pin_sha256 ~ '^[a-f0-9]{64}$'
      AND procedure_snapshot_sha256 ~ '^[a-f0-9]{64}$'
      AND reviewed_snapshot_sha256 ~ '^[a-f0-9]{64}$'
      AND occurrence_budget_sha256 ~ '^[a-f0-9]{64}$'
      AND auth_mode = 'none'
      AND secret_env_var IS NULL
    )
  ),
  ADD CONSTRAINT omni_workflow_triggers_owner_actor_fkey
    FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX omni_workflow_triggers_schedule_due_idx
ON public.omni_workflow_triggers (
  tenant_id, owner_actor_id, shadow_next_due_at, id
)
WHERE trigger_kind = 'schedule'
  AND status = 'active'
  AND circuit_state = 'closed'
  AND shadow_next_due_at IS NOT NULL;

CREATE TABLE public.omni_workflow_schedule_shadow_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  evaluated_through TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL,
  would_create_run BOOLEAN NOT NULL,
  occurrences_consumed INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  next_due_at TIMESTAMPTZ,
  configuration_sha256 TEXT NOT NULL,
  agent_identity_pin_sha256 TEXT NOT NULL,
  policy_pin_sha256 TEXT NOT NULL,
  procedure_snapshot_sha256 TEXT NOT NULL,
  reviewed_snapshot_sha256 TEXT NOT NULL,
  occurrence_budget_sha256 TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  UNIQUE (tenant_id, owner_actor_id, trigger_id, scheduled_for),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (outcome IN ('due', 'missed_run_once', 'missed_skipped', 'exhausted')),
  CHECK (occurrences_consumed BETWEEN 0 AND 10000),
  CHECK (occurrence_count BETWEEN 0 AND 10000),
  CHECK (evaluated_through >= scheduled_for),
  CHECK (evaluated_at >= scheduled_for),
  CHECK (configuration_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (agent_identity_pin_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (policy_pin_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (procedure_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (reviewed_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (occurrence_budget_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tenant_id, trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_workflow_schedule_shadow_events_actor_idx
ON public.omni_workflow_schedule_shadow_events (
  tenant_id, owner_actor_id, evaluated_at DESC, id
);

CREATE OR REPLACE FUNCTION public.omni_protect_scheduled_workflow_trigger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.trigger_kind = 'schedule' THEN
    RAISE EXCEPTION 'Scheduled workflow triggers cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.schedule_config IS DISTINCT FROM OLD.schedule_config
    OR NEW.schedule_config_sha256 IS DISTINCT FROM OLD.schedule_config_sha256
    OR NEW.agent_identity_pin_sha256 IS DISTINCT FROM OLD.agent_identity_pin_sha256
    OR NEW.policy_pin_sha256 IS DISTINCT FROM OLD.policy_pin_sha256
    OR NEW.procedure_snapshot_sha256 IS DISTINCT FROM OLD.procedure_snapshot_sha256
    OR NEW.reviewed_snapshot_sha256 IS DISTINCT FROM OLD.reviewed_snapshot_sha256
    OR NEW.occurrence_budget_sha256 IS DISTINCT FROM OLD.occurrence_budget_sha256
    OR NEW.failure_limit IS DISTINCT FROM OLD.failure_limit
  ) THEN
    RAISE EXCEPTION 'Workflow trigger schedule authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Workflow schedule shadow events are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER omni_workflow_triggers_schedule_protect
BEFORE UPDATE OR DELETE ON public.omni_workflow_triggers
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_scheduled_workflow_trigger_v1();

CREATE TRIGGER omni_workflow_schedule_shadow_events_immutable
BEFORE UPDATE OR DELETE ON public.omni_workflow_schedule_shadow_events
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();
CREATE TRIGGER omni_workflow_schedule_shadow_events_no_truncate
BEFORE TRUNCATE ON public.omni_workflow_schedule_shadow_events
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();

ALTER TABLE public.omni_workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_schedule_shadow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_schedule_shadow_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS omni_workflow_triggers_schedule_actor
  ON public.omni_workflow_triggers;
CREATE POLICY omni_workflow_triggers_schedule_actor
ON public.omni_workflow_triggers AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  owner_actor_id IS NULL
  OR public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  owner_actor_id IS NULL
  OR public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

CREATE POLICY omni_tenant_isolation
ON public.omni_workflow_schedule_shadow_events AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_workflow_schedule_shadow_events_actor
ON public.omni_workflow_schedule_shadow_events AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_workflow_schedule_shadow_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_scheduled_workflow_trigger_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_shadow_events TO omni_runtime;
    GRANT UPDATE (
      status, trigger_count, failure_count, last_triggered_at,
      next_due_at, occurrence_count, consecutive_failure_count,
      circuit_state, paused_reason, last_failure_at, circuit_opened_at,
      shadow_next_due_at, shadow_occurrence_count, shadow_evaluated_at,
      updated_at
    ) ON public.omni_workflow_triggers TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_shadow_events TO omni_maintenance;
    GRANT UPDATE (
      status, trigger_count, failure_count, last_triggered_at,
      next_due_at, occurrence_count, consecutive_failure_count,
      circuit_state, paused_reason, last_failure_at, circuit_opened_at,
      shadow_next_due_at, shadow_occurrence_count, shadow_evaluated_at,
      updated_at
    ) ON public.omni_workflow_triggers TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_workflow_schedule_shadow_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class relation
    WHERE relation.oid IN (
      'public.omni_workflow_triggers'::regclass,
      'public.omni_workflow_schedule_shadow_events'::regclass
    ) AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.omni_workflow_triggers'::regclass
      AND polname = 'omni_workflow_triggers_schedule_actor'
      AND NOT polpermissive AND polcmd = '*'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.omni_workflow_schedule_shadow_events'::regclass
      AND polname = 'omni_workflow_schedule_shadow_events_actor'
      AND NOT polpermissive AND polcmd = '*'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.omni_workflow_schedule_shadow_events'::regclass
      AND tgname = 'omni_workflow_schedule_shadow_events_immutable'
      AND NOT tgisinternal AND tgenabled = 'O'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_workflow_schedule_shadow_events'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Scheduled workflow trigger shadow boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  197,
  'scheduled_workflow_trigger_shadow_v1',
  '64953184d937e9b07591a8dc0aaf97fc696f00a1317ed872d8b58764eca35a16',
  clock_timestamp()
);

COMMIT;
