BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 161 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 161
      AND name = 'market_official_schedule_sources_v1'
      AND checksum =
        'b3019c65f900b44feb47ff57632d4fe13fd56b12db661f24c45ea735568a66d8'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market macro observation predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_macro_observations (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  series_id TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL,
  observation_date DATE NOT NULL,
  release_date DATE NOT NULL,
  vintage_end DATE NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  initial_release BOOLEAN NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_observations_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_observations_source_key UNIQUE (
    tenant_id, owner_actor_id, event_key, series_id, metric_key,
    observation_date, release_date
  ),
  CONSTRAINT omni_market_macro_observations_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_observation_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND event_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'
    AND metric_key ~ '^[a-z][a-z0-9_]{1,79}$'
    AND series_id ~ '^[A-Z0-9]+$'
    AND char_length(label) BETWEEN 1 AND 160
    AND unit IN ('index', 'percent', 'thousands', 'millions', 'billions')
    AND vintage_end >= release_date
    AND value <> 'NaN'::DOUBLE PRECISION
    AND value <> 'Infinity'::DOUBLE PRECISION
    AND value <> '-Infinity'::DOUBLE PRECISION
    AND source = 'fred'
    AND source_url LIKE 'https://fred.stlouisfed.org/series/%'
    AND initial_release
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND imported_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_observations_owner_release_idx
ON public.omni_market_macro_observations (
  tenant_id, owner_actor_id, event_key, release_date DESC, metric_key
);

CREATE TABLE public.omni_market_macro_observation_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  import_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_observation_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_observation_events_parent_fkey FOREIGN KEY (
    tenant_id, observation_id
  ) REFERENCES public.omni_market_macro_observations (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_macro_observation_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_observation_ledger_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND observation_id ~ '^market_observation_[0-9a-f]{48}$'
    AND event_type = 'market.macro_observation.initial_release_observed'
    AND btrim(import_id) <> ''
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_observation_events_owner_time_idx
ON public.omni_market_macro_observation_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_macro_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_observation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_observation_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_macro_observations_actor_scope
ON public.omni_market_macro_observations
FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
);

CREATE POLICY omni_market_macro_observation_events_actor_scope
ON public.omni_market_macro_observation_events
FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_market_macro_observations FROM PUBLIC;
REVOKE ALL ON public.omni_market_macro_observation_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_observations TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_macro_observation_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_observations TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_macro_observation_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_macro_observations TO omni_backup;
    GRANT SELECT ON public.omni_market_macro_observation_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_observations'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_observation_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_macro_observations'::regclass,
      'public.omni_market_macro_observation_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market macro observation isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  162,
  'market_macro_observations_v1',
  '5d34d958b2ea0f8155ec2a2a97e819c761d1cb528cec0b127030133cb65a376a',
  clock_timestamp()
);

COMMIT;
