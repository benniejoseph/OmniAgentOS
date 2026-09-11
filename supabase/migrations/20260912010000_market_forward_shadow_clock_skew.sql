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

  IF latest_version IS DISTINCT FROM 164 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 164
      AND name = 'market_forward_shadow_v1'
      AND checksum =
        'bb35c6f9f1a39d50cb1b735b338b205f56dbb70359577e746a1a6db18a466517'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market forward-shadow clock-skew predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_market_forward_forecasts
  DROP CONSTRAINT omni_market_forward_forecasts_row_check;

ALTER TABLE public.omni_market_forward_forecasts
  ADD CONSTRAINT omni_market_forward_forecasts_row_check CHECK (COALESCE(
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
    AND sealed_at <= created_at + INTERVAL '30 seconds'
    AND created_at <= NOW()
  , FALSE));

COMMENT ON CONSTRAINT omni_market_forward_forecasts_row_check
ON public.omni_market_forward_forecasts IS
  'Validates immutable forecast receipts and permits at most 30 seconds of bounded application/database clock skew at seal time.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.omni_market_forward_forecasts'::regclass
      AND conname = 'omni_market_forward_forecasts_row_check'
      AND pg_get_constraintdef(oid) LIKE '%00:00:30%'
  ) THEN
    RAISE EXCEPTION 'Market forward-shadow clock-skew boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  165,
  'market_forward_shadow_clock_skew_v1',
  'a639af20d1842a4f106ca4975af46f6562b592932729ab03e1e38d922c2fcea6',
  clock_timestamp()
);

COMMIT;
