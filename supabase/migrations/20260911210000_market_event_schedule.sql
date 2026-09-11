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

  IF latest_version IS DISTINCT FROM 158 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 158
      AND name = 'market_event_history_v1'
      AND checksum =
        '400f5ed02eba25002cb34e124aa9cd7d4930225ecdbe68887a2b08bd3d6b5d12'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market event schedule predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_macro_event_schedules (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  impact TEXT NOT NULL,
  source TEXT NOT NULL,
  source_uid_sha256 TEXT NOT NULL,
  source_url TEXT NOT NULL,
  release_date DATE NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_event_schedules_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_event_schedules_source_key UNIQUE (
    tenant_id, owner_actor_id, source, event_key, occurred_at
  ),
  CONSTRAINT omni_market_macro_event_schedules_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_schedule_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND event_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'
    AND char_length(name) BETWEEN 1 AND 160
    AND currency = 'USD'
    AND impact = 'high'
    AND source = 'bls'
    AND source_uid_sha256 ~ '^[0-9a-f]{64}$'
    AND source_url LIKE 'https://www.bls.gov/%'
    AND timezone = 'America/New_York'
    AND release_date = (occurred_at AT TIME ZONE 'America/New_York')::DATE
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND imported_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_event_schedules_owner_date_idx
ON public.omni_market_macro_event_schedules (
  tenant_id, owner_actor_id, release_date DESC, event_key, occurred_at DESC
);

CREATE TABLE public.omni_market_macro_event_schedule_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  import_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_event_schedule_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_event_schedule_events_parent_fkey FOREIGN KEY (
    tenant_id, schedule_id
  ) REFERENCES public.omni_market_macro_event_schedules (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_macro_event_schedule_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_schedule_ledger_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND schedule_id ~ '^market_schedule_[0-9a-f]{48}$'
    AND event_type = 'market.macro_event.schedule_observed'
    AND btrim(import_id) <> ''
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_event_schedule_events_owner_time_idx
ON public.omni_market_macro_event_schedule_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_macro_event_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_event_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_event_schedule_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_event_schedule_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_macro_event_schedules_actor_scope
ON public.omni_market_macro_event_schedules
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

CREATE POLICY omni_market_macro_event_schedule_events_actor_scope
ON public.omni_market_macro_event_schedule_events
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

REVOKE ALL ON public.omni_market_macro_event_schedules FROM PUBLIC;
REVOKE ALL ON public.omni_market_macro_event_schedule_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_event_schedules TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_macro_event_schedule_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_event_schedules TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_macro_event_schedule_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_macro_event_schedules TO omni_backup;
    GRANT SELECT ON public.omni_market_macro_event_schedule_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_event_schedules'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_event_schedule_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_macro_event_schedules'::regclass,
      'public.omni_market_macro_event_schedule_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market event schedule isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  159,
  'market_event_schedule_v1',
  '93d4dcb67ce32981d1ed5d115f9af4ff94206a19ee9ea2516bf6b1ff58eccdc5',
  clock_timestamp()
);

COMMIT;
