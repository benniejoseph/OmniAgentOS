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

  IF latest_version IS DISTINCT FROM 157 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 157
      AND name = 'market_research_model_scope_v1'
      AND checksum =
        'f1c276a830957ba8409e6f776f8dce5499324a75db8b7980533bafcbd612b749'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market event history predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_macro_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  impact TEXT NOT NULL,
  source TEXT NOT NULL,
  source_release_id INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  release_date DATE NOT NULL,
  occurred_at TIMESTAMPTZ,
  timestamp_precision TEXT NOT NULL,
  actual DOUBLE PRECISION,
  consensus DOUBLE PRECISION,
  previous DOUBLE PRECISION,
  revised DOUBLE PRECISION,
  value_status TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_events_source_key UNIQUE (
    tenant_id, owner_actor_id, source, source_release_id, release_date
  ),
  CONSTRAINT omni_market_macro_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_event_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND event_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'
    AND char_length(name) BETWEEN 1 AND 160
    AND currency = 'USD'
    AND impact = 'high'
    AND source = 'fred'
    AND source_release_id > 0
    AND source_url LIKE 'https://fred.stlouisfed.org/%'
    AND timestamp_precision IN ('date', 'instant')
    AND (
      (timestamp_precision = 'date' AND occurred_at IS NULL)
      OR (timestamp_precision = 'instant' AND occurred_at IS NOT NULL)
    )
    AND value_status IN ('release_date_only', 'observed_values')
    AND (
      value_status = 'observed_values'
      OR (
        actual IS NULL AND consensus IS NULL AND previous IS NULL
        AND revised IS NULL
      )
    )
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND imported_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_events_owner_date_idx
ON public.omni_market_macro_events (
  tenant_id, owner_actor_id, release_date DESC, event_key
);

CREATE TABLE public.omni_market_macro_event_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  market_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  import_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_macro_event_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_macro_event_events_parent_fkey FOREIGN KEY (
    tenant_id, market_event_id
  ) REFERENCES public.omni_market_macro_events (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_macro_event_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_event_ledger_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND market_event_id ~ '^market_event_[0-9a-f]{48}$'
    AND event_type = 'market.macro_event.imported'
    AND btrim(import_id) <> ''
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_macro_event_events_owner_time_idx
ON public.omni_market_macro_event_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_macro_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_event_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_macro_event_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_macro_events_actor_scope
ON public.omni_market_macro_events
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

CREATE POLICY omni_market_macro_event_events_actor_scope
ON public.omni_market_macro_event_events
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

REVOKE ALL ON public.omni_market_macro_events FROM PUBLIC;
REVOKE ALL ON public.omni_market_macro_event_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_events TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_macro_event_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_macro_events TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_macro_event_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_macro_events TO omni_backup;
    GRANT SELECT ON public.omni_market_macro_event_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_macro_event_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_macro_events'::regclass,
      'public.omni_market_macro_event_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market event history isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  158,
  'market_event_history_v1',
  '400f5ed02eba25002cb34e124aa9cd7d4930225ecdbe68887a2b08bd3d6b5d12',
  clock_timestamp()
);

COMMIT;
