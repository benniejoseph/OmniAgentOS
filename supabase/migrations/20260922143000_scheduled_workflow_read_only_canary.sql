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

  IF latest_version IS DISTINCT FROM 197 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 197
      AND name = 'scheduled_workflow_trigger_shadow_v1'
      AND checksum = '64953184d937e9b07591a8dc0aaf97fc696f00a1317ed872d8b58764eca35a16'
  ) <> 1 THEN
    RAISE EXCEPTION 'Scheduled workflow canary predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- A reviewed schedule is immutable. Changing it creates a paused replacement,
-- atomically retires the prior row, and then activates the new row.
ALTER TABLE public.omni_workflow_triggers
  ADD COLUMN replaces_trigger_id TEXT,
  ADD COLUMN replaced_by_trigger_id TEXT;

ALTER TABLE public.omni_workflow_triggers
  ADD CONSTRAINT omni_workflow_triggers_replacement_kind_check CHECK (
    trigger_kind = 'schedule'
    OR (replaces_trigger_id IS NULL AND replaced_by_trigger_id IS NULL)
  ),
  ADD CONSTRAINT omni_workflow_triggers_replaces_fkey
    FOREIGN KEY (tenant_id, replaces_trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT omni_workflow_triggers_replaced_by_fkey
    FOREIGN KEY (tenant_id, replaced_by_trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX omni_workflow_triggers_canary_due_idx
ON public.omni_workflow_triggers (
  tenant_id, owner_actor_id, next_due_at, id
)
WHERE trigger_kind = 'schedule'
  AND status = 'active'
  AND circuit_state = 'closed'
  AND next_due_at IS NOT NULL;

CREATE TABLE public.omni_workflow_schedule_occurrences (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  occurrence_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  evaluated_through TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL,
  occurrences_consumed INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  next_due_at TIMESTAMPTZ,
  configuration_sha256 TEXT NOT NULL,
  agent_identity_pin_sha256 TEXT NOT NULL,
  policy_pin_sha256 TEXT NOT NULL,
  procedure_snapshot_sha256 TEXT NOT NULL,
  reviewed_snapshot_sha256 TEXT NOT NULL,
  occurrence_budget_sha256 TEXT NOT NULL,
  authority_sha256 TEXT NOT NULL,
  workflow_run_id TEXT,
  queue_job_id TEXT,
  failure_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  UNIQUE (
    tenant_id, owner_actor_id, trigger_id, scheduled_for,
    configuration_sha256
  ),
  CHECK (schema_version = 1),
  CHECK (occurrence_kind IN ('scheduled', 'manual')),
  CHECK (status IN ('claimed', 'enqueued', 'completed', 'skipped', 'failed')),
  CHECK (outcome IN ('due', 'missed_run_once', 'missed_skipped', 'exhausted')),
  CHECK (occurrences_consumed BETWEEN 0 AND 10000),
  CHECK (occurrence_count BETWEEN 0 AND 10000),
  CHECK (attempt_count BETWEEN 0 AND 100),
  CHECK (evaluated_through >= scheduled_for),
  CHECK (configuration_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (agent_identity_pin_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (policy_pin_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (procedure_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (reviewed_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (occurrence_budget_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (authority_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (
    (status = 'enqueued' AND workflow_run_id IS NOT NULL AND queue_job_id IS NOT NULL)
    OR status <> 'enqueued'
  ),
  CHECK (
    (status = 'failed' AND failure_code IS NOT NULL)
    OR (status <> 'failed' AND failure_code IS NULL)
  ),
  CHECK (
    failure_code IS NULL OR failure_code IN (
      'agent_identity_changed', 'agent_policy_changed', 'procedure_changed',
      'procedure_not_read_only', 'occurrence_budget_changed',
      'workflow_enqueue_failed', 'workflow_failed', 'workflow_canceled'
    )
  ),
  FOREIGN KEY (tenant_id, trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_workflow_schedule_occurrences_actor_idx
ON public.omni_workflow_schedule_occurrences (
  tenant_id, owner_actor_id, scheduled_for DESC, id
);
CREATE INDEX omni_workflow_schedule_occurrences_reconcile_idx
ON public.omni_workflow_schedule_occurrences (
  tenant_id, owner_actor_id, status, updated_at, id
)
WHERE status IN ('claimed', 'enqueued');

CREATE TABLE public.omni_workflow_schedule_occurrence_receipts (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow_run_id TEXT,
  queue_job_id TEXT,
  failure_code TEXT,
  authority_sha256 TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  CHECK (schema_version = 1),
  CHECK (status IN ('claimed', 'enqueued', 'completed', 'skipped', 'failed')),
  CHECK (authority_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tenant_id, owner_actor_id, occurrence_id)
    REFERENCES public.omni_workflow_schedule_occurrences(tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_workflow_schedule_occurrence_receipts_actor_idx
ON public.omni_workflow_schedule_occurrence_receipts (
  tenant_id, owner_actor_id, recorded_at DESC, id
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
    OR NEW.replaces_trigger_id IS DISTINCT FROM OLD.replaces_trigger_id
    OR (
      NEW.replaced_by_trigger_id IS DISTINCT FROM OLD.replaced_by_trigger_id
      AND OLD.replaced_by_trigger_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Workflow trigger schedule authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_workflow_schedule_occurrence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Workflow schedule occurrences cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.trigger_id IS DISTINCT FROM OLD.trigger_id
    OR NEW.occurrence_kind IS DISTINCT FROM OLD.occurrence_kind
    OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
    OR NEW.evaluated_through IS DISTINCT FROM OLD.evaluated_through
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.occurrences_consumed IS DISTINCT FROM OLD.occurrences_consumed
    OR NEW.occurrence_count IS DISTINCT FROM OLD.occurrence_count
    OR NEW.next_due_at IS DISTINCT FROM OLD.next_due_at
    OR NEW.configuration_sha256 IS DISTINCT FROM OLD.configuration_sha256
    OR NEW.agent_identity_pin_sha256 IS DISTINCT FROM OLD.agent_identity_pin_sha256
    OR NEW.policy_pin_sha256 IS DISTINCT FROM OLD.policy_pin_sha256
    OR NEW.procedure_snapshot_sha256 IS DISTINCT FROM OLD.procedure_snapshot_sha256
    OR NEW.reviewed_snapshot_sha256 IS DISTINCT FROM OLD.reviewed_snapshot_sha256
    OR NEW.occurrence_budget_sha256 IS DISTINCT FROM OLD.occurrence_budget_sha256
    OR NEW.authority_sha256 IS DISTINCT FROM OLD.authority_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Workflow schedule occurrence authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_workflow_schedule_occurrences_protect
BEFORE UPDATE OR DELETE ON public.omni_workflow_schedule_occurrences
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_workflow_schedule_occurrence_v1();
CREATE TRIGGER omni_workflow_schedule_occurrences_no_truncate
BEFORE TRUNCATE ON public.omni_workflow_schedule_occurrences
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_workflow_schedule_occurrence_v1();
CREATE TRIGGER omni_workflow_schedule_occurrence_receipts_immutable
BEFORE UPDATE OR DELETE ON public.omni_workflow_schedule_occurrence_receipts
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();
CREATE TRIGGER omni_workflow_schedule_occurrence_receipts_no_truncate
BEFORE TRUNCATE ON public.omni_workflow_schedule_occurrence_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();

ALTER TABLE public.omni_workflow_schedule_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_schedule_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_schedule_occurrence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_workflow_schedule_occurrence_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_workflow_schedule_occurrences AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_workflow_schedule_occurrences_actor
ON public.omni_workflow_schedule_occurrences AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);
CREATE POLICY omni_tenant_isolation
ON public.omni_workflow_schedule_occurrence_receipts AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_workflow_schedule_occurrence_receipts_actor
ON public.omni_workflow_schedule_occurrence_receipts AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_workflow_schedule_occurrences FROM PUBLIC;
REVOKE ALL ON public.omni_workflow_schedule_occurrence_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_workflow_schedule_occurrence_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_workflow_schedule_occurrences FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_workflow_schedule_occurrence_receipts FROM omni_runtime';
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_occurrences TO omni_runtime;
    GRANT UPDATE (
      status, workflow_run_id, queue_job_id, failure_code, attempt_count,
      last_attempt_at, completed_at, updated_at
    ) ON public.omni_workflow_schedule_occurrences TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_occurrence_receipts TO omni_runtime;
    GRANT UPDATE (replaced_by_trigger_id)
      ON public.omni_workflow_triggers TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_workflow_schedule_occurrences FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_workflow_schedule_occurrence_receipts FROM omni_maintenance';
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_occurrences TO omni_maintenance;
    GRANT UPDATE (
      status, workflow_run_id, queue_job_id, failure_code, attempt_count,
      last_attempt_at, completed_at, updated_at
    ) ON public.omni_workflow_schedule_occurrences TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_workflow_schedule_occurrence_receipts TO omni_maintenance;
    GRANT UPDATE (replaced_by_trigger_id)
      ON public.omni_workflow_triggers TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_workflow_schedule_occurrences TO omni_backup;
    GRANT SELECT ON public.omni_workflow_schedule_occurrence_receipts TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class relation
    WHERE relation.oid IN (
      'public.omni_workflow_schedule_occurrences'::regclass,
      'public.omni_workflow_schedule_occurrence_receipts'::regclass
    ) AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_workflow_schedule_occurrences'::regclass,
      'public.omni_workflow_schedule_occurrence_receipts'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 2 OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_workflow_schedule_occurrence_receipts'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Scheduled workflow read-only canary boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  198,
  'scheduled_workflow_read_only_canary_v1',
  '75358f70c27be2ce0bd8f2048dd399a649d8cbd27cca9ff1a30ab5343324089f',
  clock_timestamp()
);

COMMIT;
