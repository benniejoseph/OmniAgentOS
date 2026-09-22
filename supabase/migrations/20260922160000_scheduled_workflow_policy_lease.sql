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

  IF latest_version IS DISTINCT FROM 198 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 198
      AND name = 'scheduled_workflow_read_only_canary_v1'
      AND checksum = '75358f70c27be2ce0bd8f2048dd399a649d8cbd27cca9ff1a30ab5343324089f'
  ) <> 1 THEN
    RAISE EXCEPTION 'Scheduled workflow policy-lease predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- PolicyLeaseV1 is a single-use effect fence. The immutable reviewed schedule
-- remains the authority; a lease alone can never authorize a mutation.
CREATE TABLE public.omni_policy_leases (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_sha256 TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  schedule_configuration_sha256 TEXT NOT NULL,
  occurrence_authority_sha256 TEXT NOT NULL,
  reviewed_snapshot_sha256 TEXT NOT NULL,
  mutation_policy_sha256 TEXT NOT NULL,
  binding_index SMALLINT NOT NULL,
  binding_sha256 TEXT NOT NULL,
  tool_contract_sha256 TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  target_sha256 TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_generation BIGINT NOT NULL,
  influence_manifest_sha256 TEXT NOT NULL,
  lease_payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumption_receipt_sha256 TEXT,
  PRIMARY KEY (tenant_id, owner_actor_id, lease_id),
  UNIQUE (tenant_id, owner_actor_id, execution_id),
  CHECK (schema_version = 1),
  CHECK (lease_id ~ '^policy_lease_[a-f0-9]{48}$'),
  CHECK (lease_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (schedule_configuration_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (occurrence_authority_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (reviewed_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (mutation_policy_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (tool_contract_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (influence_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (consumption_receipt_sha256 IS NULL OR consumption_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (binding_index BETWEEN 0 AND 11),
  CHECK (principal_generation BETWEEN 1 AND 9007199254740991),
  CHECK (state IN ('active', 'consumed')),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '15 minutes'),
  CHECK (
    (state = 'active' AND consumed_at IS NULL AND consumption_receipt_sha256 IS NULL)
    OR (state = 'consumed' AND consumed_at IS NOT NULL AND consumption_receipt_sha256 IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, trigger_id)
    REFERENCES public.omni_workflow_triggers(tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, occurrence_id)
    REFERENCES public.omni_workflow_schedule_occurrences(tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_policy_leases_actor_time_idx
ON public.omni_policy_leases (
  tenant_id, owner_actor_id, issued_at DESC, lease_id
);
CREATE INDEX omni_policy_leases_active_expiry_idx
ON public.omni_policy_leases (
  tenant_id, owner_actor_id, expires_at, lease_id
)
WHERE state = 'active';

CREATE TABLE public.omni_policy_lease_consumptions (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_sha256 TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL,
  consumption_payload JSONB NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, receipt_id),
  UNIQUE (tenant_id, owner_actor_id, lease_id),
  CHECK (schema_version = 1),
  CHECK (receipt_id ~ '^policy_lease_receipt_[a-f0-9]{48}$'),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (lease_id ~ '^policy_lease_[a-f0-9]{48}$'),
  CHECK (lease_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tenant_id, owner_actor_id, lease_id)
    REFERENCES public.omni_policy_leases(tenant_id, owner_actor_id, lease_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, occurrence_id)
    REFERENCES public.omni_workflow_schedule_occurrences(tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_policy_lease_consumptions_actor_time_idx
ON public.omni_policy_lease_consumptions (
  tenant_id, owner_actor_id, consumed_at DESC, receipt_id
);

CREATE OR REPLACE FUNCTION public.omni_protect_policy_lease_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Policy leases cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
    OR NEW.lease_sha256 IS DISTINCT FROM OLD.lease_sha256
    OR NEW.trigger_id IS DISTINCT FROM OLD.trigger_id
    OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
    OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
    OR NEW.schedule_configuration_sha256 IS DISTINCT FROM OLD.schedule_configuration_sha256
    OR NEW.occurrence_authority_sha256 IS DISTINCT FROM OLD.occurrence_authority_sha256
    OR NEW.reviewed_snapshot_sha256 IS DISTINCT FROM OLD.reviewed_snapshot_sha256
    OR NEW.mutation_policy_sha256 IS DISTINCT FROM OLD.mutation_policy_sha256
    OR NEW.binding_index IS DISTINCT FROM OLD.binding_index
    OR NEW.binding_sha256 IS DISTINCT FROM OLD.binding_sha256
    OR NEW.tool_contract_sha256 IS DISTINCT FROM OLD.tool_contract_sha256
    OR NEW.tool_id IS DISTINCT FROM OLD.tool_id
    OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
    OR NEW.target_sha256 IS DISTINCT FROM OLD.target_sha256
    OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.principal_generation IS DISTINCT FROM OLD.principal_generation
    OR NEW.influence_manifest_sha256 IS DISTINCT FROM OLD.influence_manifest_sha256
    OR NEW.lease_payload IS DISTINCT FROM OLD.lease_payload
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.state <> 'active'
    OR NEW.state <> 'consumed'
    OR NEW.consumed_at IS NULL
    OR NEW.consumption_receipt_sha256 IS NULL THEN
    RAISE EXCEPTION 'Policy lease immutable authority may only be consumed once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_policy_leases_protect
BEFORE UPDATE OR DELETE ON public.omni_policy_leases
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_policy_lease_v1();
CREATE TRIGGER omni_policy_leases_no_truncate
BEFORE TRUNCATE ON public.omni_policy_leases
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_policy_lease_v1();
CREATE TRIGGER omni_policy_lease_consumptions_immutable
BEFORE UPDATE OR DELETE ON public.omni_policy_lease_consumptions
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();
CREATE TRIGGER omni_policy_lease_consumptions_no_truncate
BEFORE TRUNCATE ON public.omni_policy_lease_consumptions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_workflow_schedule_shadow_change_v1();

ALTER TABLE public.omni_policy_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_policy_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_policy_lease_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_policy_lease_consumptions FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_policy_leases AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_policy_leases_actor
ON public.omni_policy_leases AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);
CREATE POLICY omni_tenant_isolation
ON public.omni_policy_lease_consumptions AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_policy_lease_consumptions_actor
ON public.omni_policy_lease_consumptions AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

ALTER TABLE public.omni_workflow_schedule_occurrences
  DROP CONSTRAINT omni_workflow_schedule_occurrences_failure_code_check;
ALTER TABLE public.omni_workflow_schedule_occurrences
  ADD CONSTRAINT omni_workflow_schedule_occurrences_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'agent_identity_changed', 'agent_policy_changed', 'procedure_changed',
      'procedure_not_read_only', 'mutation_policy_changed',
      'policy_lease_unavailable', 'occurrence_budget_changed',
      'workflow_enqueue_failed', 'workflow_failed', 'workflow_canceled'
    )
  );

REVOKE ALL ON public.omni_policy_leases FROM PUBLIC;
REVOKE ALL ON public.omni_policy_lease_consumptions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_policy_lease_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_policy_leases FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_policy_lease_consumptions FROM omni_runtime';
    GRANT SELECT, INSERT ON public.omni_policy_leases TO omni_runtime;
    GRANT UPDATE (state, consumed_at, consumption_receipt_sha256)
      ON public.omni_policy_leases TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_policy_lease_consumptions TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_policy_leases FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_policy_lease_consumptions FROM omni_maintenance';
    GRANT SELECT, INSERT ON public.omni_policy_leases TO omni_maintenance;
    GRANT UPDATE (state, consumed_at, consumption_receipt_sha256)
      ON public.omni_policy_leases TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_policy_lease_consumptions TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_policy_leases TO omni_backup;
    GRANT SELECT ON public.omni_policy_lease_consumptions TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class relation
    WHERE relation.oid IN (
      'public.omni_policy_leases'::regclass,
      'public.omni_policy_lease_consumptions'::regclass
    ) AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_policy_leases'::regclass,
      'public.omni_policy_lease_consumptions'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 2 OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'omni_policy_leases',
        'omni_policy_lease_consumptions'
      )
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_policy_leases'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
      AND column_name NOT IN (
        'state', 'consumed_at', 'consumption_receipt_sha256'
      )
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('omni_runtime'), ('omni_maintenance')) expected(role_name)
    WHERE EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = expected.role_name
    ) AND (
      SELECT count(DISTINCT grant_row.column_name)
      FROM information_schema.role_column_grants grant_row
      WHERE grant_row.table_schema = 'public'
        AND grant_row.table_name = 'omni_policy_leases'
        AND grant_row.grantee = expected.role_name
        AND grant_row.privilege_type = 'UPDATE'
    ) <> 3
  ) THEN
    RAISE EXCEPTION 'Scheduled policy-lease boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  199,
  'scheduled_workflow_policy_lease_v1',
  '56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093',
  clock_timestamp()
);

COMMIT;
