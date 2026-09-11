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

  IF latest_version IS DISTINCT FROM 163 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 163
      AND name = 'market_event_replays_v1'
      AND checksum =
        'c2ebe40a5d108a32f4ea6dc80283da69467d9e7a88564ddd51a4d8b9a85a69e3'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market forward-shadow predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_market_forward_forecasts (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  horizon TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  sealed_at TIMESTAMPTZ NOT NULL,
  probability_state TEXT NOT NULL,
  forecast_sha256 TEXT NOT NULL,
  forecast JSONB NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  technical_result_sha256 TEXT NOT NULL,
  baseline_result_sha256 TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  assignment_configuration_sha256 TEXT NOT NULL,
  usage_receipt_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_forward_forecasts_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_forward_forecasts_window_key UNIQUE (
    tenant_id, owner_actor_id, instrument_id, horizon, window_start
  ),
  CONSTRAINT omni_market_forward_forecasts_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_forecast_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND contract_version = 'market-forward-shadow:1'
    AND instrument_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
    AND horizon IN ('daily', 'weekly')
    AND sealed_at < window_start
    AND window_start < window_end
    AND window_end - window_start <= INTERVAL '8 days'
    AND probability_state = 'uncalibrated'
    AND forecast_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(forecast) = 'object'
    AND pg_column_size(forecast) <= 131072
    AND forecast ->> 'id' = id
    AND forecast ->> 'contractVersion' = contract_version
    AND forecast ->> 'instrumentId' = instrument_id
    AND forecast ->> 'horizon' = horizon
    AND (forecast ->> 'windowStart')::TIMESTAMPTZ = window_start
    AND (forecast ->> 'windowEnd')::TIMESTAMPTZ = window_end
    AND (forecast ->> 'sealedAt')::TIMESTAMPTZ = sealed_at
    AND forecast ->> 'probabilityState' = probability_state
    AND forecast ->> 'forecastSha256' = forecast_sha256
    AND snapshot_id ~ '^market_snapshot_[0-9a-f]{48}$'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND technical_result_sha256 ~ '^[0-9a-f]{64}$'
    AND baseline_result_sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(model_provider) BETWEEN 1 AND 80
    AND char_length(model_id) BETWEEN 1 AND 240
    AND char_length(assignment_id) BETWEEN 1 AND 240
    AND assignment_revision > 0
    AND assignment_configuration_sha256 ~ '^[0-9a-f]{64}$'
    AND forecast #>> '{evidence,snapshotId}' = snapshot_id
    AND forecast #>> '{evidence,snapshotSha256}' = snapshot_sha256
    AND forecast #>> '{evidence,technicalResultSha256}' = technical_result_sha256
    AND forecast #>> '{evidence,baselineResultSha256}' = baseline_result_sha256
    AND forecast #>> '{modelAttribution,provider}' = model_provider
    AND forecast #>> '{modelAttribution,model}' = model_id
    AND forecast #>> '{modelAttribution,assignmentId}' = assignment_id
    AND (forecast #>> '{modelAttribution,assignmentRevision}')::INTEGER = assignment_revision
    AND forecast #>> '{modelAttribution,assignmentConfigurationSha256}' = assignment_configuration_sha256
    AND (forecast #>> '{modelAttribution,usageReceiptId}')::UUID = usage_receipt_id
    AND created_at >= sealed_at
    AND created_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_forward_forecasts_owner_window_idx
ON public.omni_market_forward_forecasts (
  tenant_id, owner_actor_id, instrument_id, window_start DESC, id
);

CREATE TABLE public.omni_market_forecast_outcomes (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  outcome_sha256 TEXT NOT NULL,
  source_payload_sha256 TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  outcome JSONB NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_forecast_outcomes_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_forecast_outcomes_forecast_key UNIQUE (
    tenant_id, owner_actor_id, forecast_id
  ),
  CONSTRAINT omni_market_forecast_outcomes_parent_fkey FOREIGN KEY (
    tenant_id, forecast_id
  ) REFERENCES public.omni_market_forward_forecasts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_forecast_outcomes_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_forecast_outcome_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND forecast_id ~ '^market_forecast_[0-9a-f]{48}$'
    AND outcome_sha256 ~ '^[0-9a-f]{64}$'
    AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(outcome) = 'object'
    AND pg_column_size(outcome) <= 32768
    AND outcome ->> 'id' = id
    AND outcome ->> 'forecastId' = forecast_id
    AND outcome ->> 'outcomeSha256' = outcome_sha256
    AND outcome ->> 'sourcePayloadSha256' = source_payload_sha256
    AND outcome ->> 'snapshotSha256' = snapshot_sha256
    AND (outcome ->> 'resolvedAt')::TIMESTAMPTZ = resolved_at
    AND resolved_at <= created_at
    AND created_at <= NOW()
  , FALSE))
);

CREATE TABLE public.omni_market_forecast_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_market_forecast_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_market_forecast_events_parent_fkey FOREIGN KEY (
    tenant_id, forecast_id
  ) REFERENCES public.omni_market_forward_forecasts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_market_forecast_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_forecast_ledger_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND forecast_id ~ '^market_forecast_[0-9a-f]{48}$'
    AND event_type IN (
      'market.forward_forecast.sealed',
      'market.forward_forecast.resolved'
    )
    AND idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND occurred_at <= NOW()
  , FALSE))
);

CREATE INDEX omni_market_forecast_events_owner_time_idx
ON public.omni_market_forecast_events (
  tenant_id, owner_actor_id, occurred_at DESC, id
);

ALTER TABLE public.omni_market_forward_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_forward_forecasts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_forecast_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_forecast_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_forecast_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_market_forecast_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_market_forward_forecasts_actor_scope
ON public.omni_market_forward_forecasts
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

CREATE POLICY omni_market_forecast_outcomes_actor_scope
ON public.omni_market_forecast_outcomes
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

CREATE POLICY omni_market_forecast_events_actor_scope
ON public.omni_market_forecast_events
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

REVOKE ALL ON public.omni_market_forward_forecasts FROM PUBLIC;
REVOKE ALL ON public.omni_market_forecast_outcomes FROM PUBLIC;
REVOKE ALL ON public.omni_market_forecast_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_market_forward_forecasts TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_forecast_outcomes TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_market_forecast_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_market_forward_forecasts TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_forecast_outcomes TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_market_forecast_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_market_forward_forecasts TO omni_backup;
    GRANT SELECT ON public.omni_market_forecast_outcomes TO omni_backup;
    GRANT SELECT ON public.omni_market_forecast_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class
    WHERE oid IN (
      'public.omni_market_forward_forecasts'::regclass,
      'public.omni_market_forecast_outcomes'::regclass,
      'public.omni_market_forecast_events'::regclass
    ) AND relrowsecurity AND relforcerowsecurity
  ) <> 3 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_market_forward_forecasts'::regclass,
      'public.omni_market_forecast_outcomes'::regclass,
      'public.omni_market_forecast_events'::regclass
    )
  ) <> 3 THEN
    RAISE EXCEPTION 'Market forward-shadow isolation boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  164,
  'market_forward_shadow_v1',
  'bb35c6f9f1a39d50cb1b735b338b205f56dbb70359577e746a1a6db18a466517',
  clock_timestamp()
);

COMMIT;
