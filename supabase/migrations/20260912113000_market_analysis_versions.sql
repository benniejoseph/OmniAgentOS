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

  IF latest_version IS DISTINCT FROM 165 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 165
      AND name = 'market_forward_shadow_clock_skew_v1'
      AND checksum =
        'a639af20d1842a4f106ca4975af46f6562b592932729ab03e1e38d922c2fcea6'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market analysis-version predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_market_price_snapshots
  ADD CONSTRAINT omni_market_price_snapshots_actor_key UNIQUE (
    tenant_id, id, owner_actor_id
  );

CREATE TABLE public.omni_market_analysis_versions (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  interval TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  technical_result_sha256 TEXT NOT NULL,
  technical_features JSONB NOT NULL,
  visible_layer_ids TEXT[] NOT NULL,
  chart_state_sha256 TEXT NOT NULL,
  chart_state JSONB NOT NULL,
  annotation_count INTEGER NOT NULL,
  detection_count INTEGER NOT NULL,
  candidate_count INTEGER NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  version_sha256 TEXT NOT NULL,
  analysis_version JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_analysis_versions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_analysis_versions_actor_key UNIQUE (
    tenant_id, id, owner_actor_id
  ),
  CONSTRAINT omni_market_analysis_versions_idempotency_key UNIQUE (
    tenant_id, owner_actor_id, idempotency_key_sha256
  ),
  CONSTRAINT omni_market_analysis_versions_snapshot_fkey FOREIGN KEY (
    tenant_id, snapshot_id, owner_actor_id
  ) REFERENCES public.omni_market_price_snapshots (
    tenant_id, id, owner_actor_id
  )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_analysis_versions_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_analysis_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND contract_version = 'market-analysis-version:1'
    AND instrument_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
    AND interval IN ('5min', '15min', '1h')
    AND snapshot_id ~ '^market_snapshot_[0-9a-f]{48}$'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND detector_version IN (
      'market-technical-primitives:1',
      'market-ict-quarterly-candidates:2'
    )
    AND technical_result_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(technical_features) = 'object'
    AND pg_column_size(technical_features) <= 2097152
    AND cardinality(visible_layer_ids) BETWEEN 0 AND 8
    AND visible_layer_ids <@ ARRAY[
      'liquidity', 'imbalances', 'blocks', 'setups', 'sessions',
      'quarterly', 'structure', 'gaps'
    ]::TEXT[]
    AND chart_state_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(chart_state) = 'object'
    AND pg_column_size(chart_state) <= 786432
    AND annotation_count BETWEEN 0 AND 120
    AND detection_count BETWEEN 0 AND 240
    AND candidate_count BETWEEN 0 AND detection_count
    AND idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
    AND version_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(analysis_version) = 'object'
    AND pg_column_size(analysis_version) <= 1048576
    AND analysis_version ->> 'id' = id
    AND analysis_version ->> 'contractVersion' = contract_version
    AND analysis_version ->> 'instrumentId' = instrument_id
    AND analysis_version ->> 'interval' = interval
    AND analysis_version ->> 'snapshotId' = snapshot_id
    AND analysis_version ->> 'snapshotSha256' = snapshot_sha256
    AND analysis_version ->> 'detectorVersion' = detector_version
    AND analysis_version ->> 'technicalResultSha256' = technical_result_sha256
    AND analysis_version ->> 'chartStateSha256' = chart_state_sha256
    AND (analysis_version ->> 'annotationCount')::INTEGER = annotation_count
    AND (analysis_version ->> 'detectionCount')::INTEGER = detection_count
    AND (analysis_version ->> 'candidateCount')::INTEGER = candidate_count
    AND analysis_version ->> 'versionSha256' = version_sha256
    AND (analysis_version ->> 'savedAt')::TIMESTAMPTZ = saved_at
    AND saved_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_market_analysis_versions_owner_time_idx
ON public.omni_market_analysis_versions (
  tenant_id, owner_actor_id, instrument_id, interval, saved_at DESC, id
);

CREATE TABLE public.omni_market_analysis_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  analysis_version_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_analysis_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_analysis_events_parent_fkey FOREIGN KEY (
    tenant_id, analysis_version_id, owner_actor_id
  ) REFERENCES public.omni_market_analysis_versions (
    tenant_id, id, owner_actor_id
  )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_analysis_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_analysis_event_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND analysis_version_id ~ '^market_analysis_[0-9a-f]{48}$'
    AND event_type = 'market.analysis_version.saved'
    AND idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_market_analysis_events_owner_time_idx
ON public.omni_market_analysis_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_analysis_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_analysis_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_analysis_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_analysis_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_analysis_versions_actor_scope
ON public.omni_market_analysis_versions
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

CREATE POLICY omni_market_analysis_events_actor_scope
ON public.omni_market_analysis_events
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

REVOKE ALL ON public.omni_market_analysis_versions FROM PUBLIC;
REVOKE ALL ON public.omni_market_analysis_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_analysis_versions TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_analysis_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_analysis_versions TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_analysis_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_analysis_versions TO omni_backup;
    GRANT SELECT ON public.omni_market_analysis_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class
    WHERE oid IN (
      'public.omni_market_analysis_versions'::regclass,
      'public.omni_market_analysis_events'::regclass
    ) AND relrowsecurity AND relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_analysis_versions'::regclass,
      'public.omni_market_analysis_events'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'Market analysis-version isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  166,
  'market_analysis_versions_v1',
  'ee55253b32cf5838ac8e37a5a4e969e314c82fd2190be7a397e5d2a64eb4b232',
  clock_timestamp()
);

COMMIT;
