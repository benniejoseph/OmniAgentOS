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

  IF latest_version IS DISTINCT FROM 202 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 202
      AND name = 'delegation_execution_rls_composition_repair_v1'
      AND checksum = '3d6b28bd2fdb00cc57360506baea3ef120a4ae13e0050be57ba6d266310a3d63'
  ) <> 1 THEN
    RAISE EXCEPTION 'Agent daily learning predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Daily learning is a content-free evidence projection. It records what
-- happened under one immutable Agent definition, but cannot modify behavior,
-- grant authority, or invoke a model by itself.
CREATE TABLE public.omni_agent_learning_observations (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  observation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  owner_binding_sha256 TEXT NOT NULL,
  logical_agent_id TEXT NOT NULL,
  definition_version BIGINT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL,
  grounding_status TEXT NOT NULL,
  has_correction BOOLEAN NOT NULL,
  actionable BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  content_included BOOLEAN NOT NULL DEFAULT FALSE,
  model_invoked BOOLEAN NOT NULL DEFAULT FALSE,
  authority_impact TEXT NOT NULL DEFAULT 'none',
  PRIMARY KEY (tenant_id, owner_actor_id, observation_id),
  UNIQUE (
    tenant_id, owner_actor_id, logical_agent_id, definition_version,
    source_kind, source_id, source_sha256
  ),
  CHECK (schema_version = 1),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (observation_id ~ '^agent-learning-observation:[a-f0-9]{64}$'),
  CHECK (owner_binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(logical_agent_id) BETWEEN 1 AND 240),
  CHECK (definition_version BETWEEN 1 AND 9007199254740991),
  CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (source_kind = 'agent_run'),
  CHECK (char_length(source_id) BETWEEN 1 AND 320),
  CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (outcome IN (
    'useful', 'needs_work', 'completed_unreviewed', 'failed', 'canceled'
  )),
  CHECK (grounding_status IN ('verified', 'not_verified', 'not_required')),
  CHECK (actionable = (outcome = 'needs_work' AND has_correction)),
  CHECK (observed_at <= recorded_at),
  CHECK (NOT content_included),
  CHECK (NOT model_invoked),
  CHECK (authority_impact = 'none'),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.omni_agent_learning_cycles (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  cycle_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  owner_binding_sha256 TEXT NOT NULL,
  logical_agent_id TEXT NOT NULL,
  definition_version BIGINT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_date DATE NOT NULL,
  previous_high_water_at TIMESTAMPTZ,
  previous_high_water_observation_id TEXT,
  high_water_at TIMESTAMPTZ,
  high_water_observation_id TEXT,
  observation_count INTEGER NOT NULL,
  useful_evidence_count INTEGER NOT NULL,
  needs_work_evidence_count INTEGER NOT NULL,
  unreviewed_evidence_count INTEGER NOT NULL,
  failed_evidence_count INTEGER NOT NULL,
  canceled_evidence_count INTEGER NOT NULL,
  actionable_evidence_count INTEGER NOT NULL,
  evidence_manifest_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  content_included BOOLEAN NOT NULL DEFAULT FALSE,
  model_invoked BOOLEAN NOT NULL DEFAULT FALSE,
  behavior_changed BOOLEAN NOT NULL DEFAULT FALSE,
  authority_impact TEXT NOT NULL DEFAULT 'none',
  tool_authority_changed BOOLEAN NOT NULL DEFAULT FALSE,
  context_authority_changed BOOLEAN NOT NULL DEFAULT FALSE,
  budget_authority_changed BOOLEAN NOT NULL DEFAULT FALSE,
  adaptation_activated BOOLEAN NOT NULL DEFAULT FALSE,
  receipt_sha256 TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, cycle_id),
  UNIQUE (
    tenant_id, owner_actor_id, logical_agent_id, definition_version,
    timezone, local_date
  ),
  CHECK (schema_version = 1),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (cycle_id ~ '^agent-learning-cycle:[a-f0-9]{64}$'),
  CHECK (owner_binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(logical_agent_id) BETWEEN 1 AND 240),
  CHECK (definition_version BETWEEN 1 AND 9007199254740991),
  CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(timezone) BETWEEN 1 AND 120),
  CHECK (
    (previous_high_water_at IS NULL) =
      (previous_high_water_observation_id IS NULL)
  ),
  CHECK ((high_water_at IS NULL) = (high_water_observation_id IS NULL)),
  CHECK (
    previous_high_water_observation_id IS NULL
    OR previous_high_water_observation_id ~
      '^agent-learning-observation:[a-f0-9]{64}$'
  ),
  CHECK (
    high_water_observation_id IS NULL
    OR high_water_observation_id ~
      '^agent-learning-observation:[a-f0-9]{64}$'
  ),
  CHECK (
    previous_high_water_at IS NULL
    OR high_water_at IS NULL
    OR high_water_at > previous_high_water_at
    OR (
      high_water_at = previous_high_water_at
      AND high_water_observation_id >= previous_high_water_observation_id
    )
  ),
  CHECK (observation_count BETWEEN 0 AND 10000),
  CHECK (useful_evidence_count BETWEEN 0 AND 10000),
  CHECK (needs_work_evidence_count BETWEEN 0 AND 10000),
  CHECK (unreviewed_evidence_count BETWEEN 0 AND 10000),
  CHECK (failed_evidence_count BETWEEN 0 AND 10000),
  CHECK (canceled_evidence_count BETWEEN 0 AND 10000),
  CHECK (actionable_evidence_count BETWEEN 0 AND 10000),
  CHECK (
    observation_count = useful_evidence_count + needs_work_evidence_count +
      unreviewed_evidence_count + failed_evidence_count +
      canceled_evidence_count
  ),
  CHECK (actionable_evidence_count <= needs_work_evidence_count),
  CHECK (observation_count = 0 OR high_water_observation_id IS NOT NULL),
  CHECK (evidence_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (outcome IN (
    'actionable_evidence_recorded', 'no_actionable_evidence'
  )),
  CHECK (
    (actionable_evidence_count > 0) =
      (outcome = 'actionable_evidence_recorded')
  ),
  CHECK (NOT content_included),
  CHECK (NOT model_invoked),
  CHECK (NOT behavior_changed),
  CHECK (authority_impact = 'none'),
  CHECK (NOT tool_authority_changed),
  CHECK (NOT context_authority_changed),
  CHECK (NOT budget_authority_changed),
  CHECK (NOT adaptation_activated),
  CHECK (high_water_at IS NULL OR completed_at >= high_water_at),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_agent_learning_observations_scope_idx
ON public.omni_agent_learning_observations (
  tenant_id, owner_actor_id, logical_agent_id, definition_version,
  observed_at, observation_id
);

CREATE INDEX omni_agent_learning_cycles_scope_idx
ON public.omni_agent_learning_cycles (
  tenant_id, owner_actor_id, logical_agent_id, definition_version,
  local_date DESC, cycle_id
);

CREATE OR REPLACE FUNCTION public.omni_reject_agent_learning_change_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Agent learning evidence is append-only'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER omni_agent_learning_observations_immutable
BEFORE UPDATE OR DELETE ON public.omni_agent_learning_observations
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_agent_learning_change_v1();
CREATE TRIGGER omni_agent_learning_observations_no_truncate
BEFORE TRUNCATE ON public.omni_agent_learning_observations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_agent_learning_change_v1();
CREATE TRIGGER omni_agent_learning_cycles_immutable
BEFORE UPDATE OR DELETE ON public.omni_agent_learning_cycles
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_agent_learning_change_v1();
CREATE TRIGGER omni_agent_learning_cycles_no_truncate
BEFORE TRUNCATE ON public.omni_agent_learning_cycles
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_agent_learning_change_v1();

ALTER TABLE public.omni_agent_learning_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_agent_learning_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_agent_learning_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_agent_learning_cycles FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_agent_learning_observations AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_agent_learning_observations_actor
ON public.omni_agent_learning_observations AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

CREATE POLICY omni_tenant_isolation
ON public.omni_agent_learning_cycles AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_agent_learning_cycles_actor
ON public.omni_agent_learning_cycles AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_agent_learning_observations FROM PUBLIC;
REVOKE ALL ON public.omni_agent_learning_cycles FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_reject_agent_learning_change_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE
      ON public.omni_agent_learning_observations FROM omni_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE
      ON public.omni_agent_learning_cycles FROM omni_runtime;
    GRANT SELECT, INSERT ON public.omni_agent_learning_observations TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_agent_learning_cycles TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE UPDATE, DELETE, TRUNCATE
      ON public.omni_agent_learning_observations FROM omni_maintenance;
    REVOKE UPDATE, DELETE, TRUNCATE
      ON public.omni_agent_learning_cycles FROM omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_agent_learning_observations TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_agent_learning_cycles TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_agent_learning_observations TO omni_backup;
    GRANT SELECT ON public.omni_agent_learning_cycles TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_class relation
    WHERE relation.oid IN (
      'public.omni_agent_learning_observations'::regclass,
      'public.omni_agent_learning_cycles'::regclass
    )
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*)
    FROM pg_policy
    WHERE polrelid IN (
      'public.omni_agent_learning_observations'::regclass,
      'public.omni_agent_learning_cycles'::regclass
    )
      AND polname IN (
        'omni_agent_learning_observations_actor',
        'omni_agent_learning_cycles_actor'
      )
      AND NOT polpermissive
      AND polcmd = '*'
  ) <> 2 OR (
    SELECT count(*)
    FROM pg_policy
    WHERE polrelid IN (
      'public.omni_agent_learning_observations'::regclass,
      'public.omni_agent_learning_cycles'::regclass
    )
      AND polname = 'omni_tenant_isolation'
      AND polpermissive
      AND polcmd = '*'
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'omni_agent_learning_observations', 'omni_agent_learning_cycles'
      )
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR (
    SELECT count(*)
    FROM pg_trigger
    WHERE tgrelid IN (
      'public.omni_agent_learning_observations'::regclass,
      'public.omni_agent_learning_cycles'::regclass
    )
      AND tgname IN (
        'omni_agent_learning_observations_immutable',
        'omni_agent_learning_observations_no_truncate',
        'omni_agent_learning_cycles_immutable',
        'omni_agent_learning_cycles_no_truncate'
      )
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) <> 4 THEN
    RAISE EXCEPTION 'Agent daily learning boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  203,
  'agent_daily_learning_v1',
  '88fa0dd240ba1920d2bb66395bb2b268dc98bd682282fbe3633d1df4b1d01f96',
  clock_timestamp()
);

COMMIT;
