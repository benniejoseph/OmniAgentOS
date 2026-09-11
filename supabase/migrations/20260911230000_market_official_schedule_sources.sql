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

  IF latest_version IS DISTINCT FROM 160 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 160
      AND name = 'market_price_snapshot_v1'
      AND checksum =
        'f4042cd8d4f0c7a34ea4119fe1af5b8932ef631a0271a907a0f797f64ef7371a'
  ) <> 1 THEN
    RAISE EXCEPTION 'Official market schedule source predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_market_macro_event_schedules
  DROP CONSTRAINT omni_market_macro_event_schedules_row_check;

ALTER TABLE public.omni_market_macro_event_schedules
  ADD CONSTRAINT omni_market_macro_event_schedules_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^market_schedule_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND event_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'
    AND char_length(name) BETWEEN 1 AND 160
    AND currency = 'USD'
    AND impact = 'high'
    AND source IN ('bls', 'census', 'bea', 'federal_reserve')
    AND source_uid_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      (source = 'bls' AND source_url LIKE 'https://www.bls.gov/%')
      OR (source = 'census' AND source_url LIKE 'https://www.census.gov/%')
      OR (source = 'bea' AND source_url LIKE 'https://www.bea.gov/%')
      OR (
        source = 'federal_reserve'
        AND source_url LIKE 'https://www.federalreserve.gov/%'
      )
    )
    AND timezone = 'America/New_York'
    AND release_date = (occurred_at AT TIME ZONE 'America/New_York')::DATE
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND imported_at <= NOW()
  , FALSE));

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  161,
  'market_official_schedule_sources_v1',
  'b3019c65f900b44feb47ff57632d4fe13fd56b12db661f24c45ea735568a66d8',
  clock_timestamp()
);

COMMIT;
