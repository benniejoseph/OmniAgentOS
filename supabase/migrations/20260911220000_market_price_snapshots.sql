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

  IF latest_version IS DISTINCT FROM 159 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 159
      AND name = 'market_event_schedule_v1'
      AND checksum =
        '93d4dcb67ce32981d1ed5d115f9af4ff94206a19ee9ea2516bf6b1ff58eccdc5'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market price snapshot predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_price_snapshots (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  provider_timezone TEXT NOT NULL,
  interval TEXT NOT NULL,
  requested_output_size INTEGER NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  first_bar_at TIMESTAMPTZ NOT NULL,
  last_bar_at TIMESTAMPTZ NOT NULL,
  bar_count INTEGER NOT NULL,
  source_payload_sha256 TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL,
  source_payload JSONB NOT NULL,
  normalized_bars JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_price_snapshots_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_price_snapshots_normalized_key UNIQUE (
    tenant_id, owner_actor_id, normalized_sha256
  ),
  CONSTRAINT omni_market_price_snapshots_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_snapshot_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND contract_version ~ '^market-research-foundation:[0-9]+$'
    AND instrument_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
    AND provider = 'twelve_data'
    AND char_length(provider_symbol) BETWEEN 1 AND 80
    AND char_length(provider_timezone) BETWEEN 1 AND 120
    AND interval IN ('5min', '15min', '1h')
    AND requested_output_size BETWEEN 100 AND 1000
    AND retrieved_at <= created_at + INTERVAL '5 minutes'
    AND as_of = last_bar_at
    AND first_bar_at <= last_bar_at
    AND last_bar_at <= retrieved_at + INTERVAL '2 hours'
    AND bar_count BETWEEN 1 AND 1000
    AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND normalized_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(source_payload) = 'object'
    AND pg_column_size(source_payload) <= 2097152
    AND jsonb_typeof(normalized_bars) = 'array'
    AND jsonb_array_length(normalized_bars) = bar_count
    AND pg_column_size(normalized_bars) <= 2097152
    AND created_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_price_snapshots_owner_lookup_idx
ON public.omni_market_price_snapshots (
  tenant_id, owner_actor_id, contract_version, instrument_id, interval,
  requested_output_size, created_at DESC
);

CREATE TABLE public.omni_market_price_snapshot_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_price_snapshot_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_price_snapshot_events_parent_fkey FOREIGN KEY (
    tenant_id, snapshot_id
  ) REFERENCES public.omni_market_price_snapshots (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_price_snapshot_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_snapshot_event_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND snapshot_id ~ '^market_snapshot_[0-9a-f]{48}$'
    AND event_type = 'market.price_snapshot.observed'
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_price_snapshot_events_owner_time_idx
ON public.omni_market_price_snapshot_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_price_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_price_snapshot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_price_snapshot_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_price_snapshots_actor_scope
ON public.omni_market_price_snapshots
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

CREATE POLICY omni_market_price_snapshot_events_actor_scope
ON public.omni_market_price_snapshot_events
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

REVOKE ALL ON public.omni_market_price_snapshots FROM PUBLIC;
REVOKE ALL ON public.omni_market_price_snapshot_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_price_snapshots TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_price_snapshot_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_price_snapshots TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_price_snapshot_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_price_snapshots TO omni_backup;
    GRANT SELECT ON public.omni_market_price_snapshot_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_price_snapshots'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_price_snapshot_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_price_snapshots'::regclass,
      'public.omni_market_price_snapshot_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market price snapshot isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  160,
  'market_price_snapshot_v1',
  'f4042cd8d4f0c7a34ea4119fe1af5b8932ef631a0271a907a0f797f64ef7371a',
  clock_timestamp()
);

COMMIT;
