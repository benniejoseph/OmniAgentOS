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

  IF latest_version IS DISTINCT FROM 162 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 162
      AND name = 'market_macro_observations_v1'
      AND checksum =
        '5d34d958b2ea0f8155ec2a2a97e819c761d1cb528cec0b127030133cb65a376a'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market event replay predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_event_replays (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  market_event_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  provider_timezone TEXT NOT NULL,
  interval TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  bar_count INTEGER NOT NULL,
  source_payload_sha256 TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  source_payload JSONB NOT NULL,
  normalized_bars JSONB NOT NULL,
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_event_replays_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_event_replays_parent_fkey FOREIGN KEY (
    tenant_id, market_event_id
  ) REFERENCES public.omni_market_macro_events (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_event_replays_snapshot_key UNIQUE (
    tenant_id, owner_actor_id, market_event_id, instrument_id, interval,
    snapshot_sha256
  ),
  CONSTRAINT omni_market_event_replays_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_replay_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND contract_version ~ '^market-research-foundation:[0-9]+$'
    AND market_event_id ~ '^market_event_[0-9a-f]{48}$'
    AND event_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'
    AND instrument_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
    AND provider = 'twelve_data'
    AND char_length(provider_symbol) BETWEEN 1 AND 80
    AND char_length(provider_timezone) BETWEEN 1 AND 120
    AND interval IN ('5min', '15min', '1h')
    AND window_start < occurred_at
    AND window_end > occurred_at
    AND window_end - window_start <= INTERVAL '72 hours'
    AND retrieved_at <= created_at + INTERVAL '5 minutes'
    AND bar_count BETWEEN 1 AND 1000
    AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(source_payload) = 'object'
    AND pg_column_size(source_payload) <= 2097152
    AND jsonb_typeof(normalized_bars) = 'array'
    AND jsonb_array_length(normalized_bars) = bar_count
    AND pg_column_size(normalized_bars) <= 2097152
    AND jsonb_typeof(metrics) = 'object'
    AND pg_column_size(metrics) <= 32768
    AND created_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_event_replays_owner_lookup_idx
ON public.omni_market_event_replays (
  tenant_id, owner_actor_id, instrument_id, interval, occurred_at DESC, id
);

CREATE TABLE public.omni_market_event_replay_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  replay_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  import_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_event_replay_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_event_replay_events_parent_fkey FOREIGN KEY (
    tenant_id, replay_id
  ) REFERENCES public.omni_market_event_replays (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_event_replay_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_replay_ledger_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND replay_id ~ '^market_replay_[0-9a-f]{48}$'
    AND event_type = 'market.event_replay.observed'
    AND btrim(import_id) <> ''
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_event_replay_events_owner_time_idx
ON public.omni_market_event_replay_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_event_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_event_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_event_replay_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_event_replay_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_event_replays_actor_scope
ON public.omni_market_event_replays
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

CREATE POLICY omni_market_event_replay_events_actor_scope
ON public.omni_market_event_replay_events
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

REVOKE ALL ON public.omni_market_event_replays FROM PUBLIC;
REVOKE ALL ON public.omni_market_event_replay_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_event_replays TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_event_replay_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_event_replays TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_event_replay_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_event_replays TO omni_backup;
    GRANT SELECT ON public.omni_market_event_replay_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_event_replays'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_market_event_replay_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_event_replays'::regclass,
      'public.omni_market_event_replay_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market event replay isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  163,
  'market_event_replays_v1',
  'c2ebe40a5d108a32f4ea6dc80283da69467d9e7a88564ddd51a4d8b9a85a69e3',
  clock_timestamp()
);

COMMIT;
