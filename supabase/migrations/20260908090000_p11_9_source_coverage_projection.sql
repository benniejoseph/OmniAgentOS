BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 143
      AND name = 'functional_model_assignments_v1'
      AND checksum = 'b2c0979801a5aed19e44b0c12ed6c457ac766868baae1d4ca27d1abddb269cae'
  ) <> 1 THEN
    RAISE EXCEPTION 'Source coverage projection predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_oauth_grants
  ADD COLUMN IF NOT EXISTS source_sync_health JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION omni_oauth_source_sync_health_v1_is_valid(
  value JSONB
) RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_typeof(value) = 'object'
    AND value - ARRAY['mail', 'calendar', 'drive'] = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(value) entry(source_id, checkpoint)
      WHERE entry.source_id NOT IN ('mail', 'calendar', 'drive')
        OR jsonb_typeof(entry.checkpoint) <> 'object'
        OR entry.checkpoint - ARRAY[
          'schemaVersion', 'status', 'backfillState', 'lastAttemptedAt',
          'lastSuccessfulAt', 'failureCode'
        ] <> '{}'::jsonb
        OR entry.checkpoint ->> 'schemaVersion' <> '1'
        OR entry.checkpoint ->> 'status' NOT IN ('syncing', 'healthy', 'error')
        OR entry.checkpoint ->> 'backfillState' NOT IN (
          'unknown', 'in_progress', 'complete'
        )
        OR COALESCE(entry.checkpoint ->> 'lastAttemptedAt', '')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR (
          entry.checkpoint ? 'lastSuccessfulAt'
          AND entry.checkpoint ->> 'lastSuccessfulAt'
            !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        )
        OR COALESCE(entry.checkpoint ->> 'failureCode', 'none') NOT IN (
          'none', 'provider_unauthorized', 'provider_forbidden',
          'provider_rate_limited', 'provider_unavailable', 'processing_failed'
        )
        OR (
          entry.checkpoint ->> 'status' = 'healthy'
          AND NOT (entry.checkpoint ? 'lastSuccessfulAt')
        )
        OR (
          entry.checkpoint ->> 'status' = 'error'
          AND COALESCE(entry.checkpoint ->> 'failureCode', 'none') = 'none'
        )
        OR (
          entry.checkpoint ->> 'status' <> 'error'
          AND COALESCE(entry.checkpoint ->> 'failureCode', 'none') <> 'none'
        )
    )
$function$;

ALTER TABLE omni_oauth_grants
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_source_sync_health_check;

ALTER TABLE omni_oauth_grants
  ADD CONSTRAINT omni_oauth_grants_source_sync_health_check
  CHECK (omni_oauth_source_sync_health_v1_is_valid(source_sync_health));

REVOKE ALL ON FUNCTION omni_oauth_source_sync_health_v1_is_valid(JSONB)
  FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_oauth_source_sync_health_v1_is_valid(JSONB)
      TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION omni_oauth_source_sync_health_v1_is_valid(JSONB)
      TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_oauth_grants'
      AND column_name = 'source_sync_health'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_oauth_grants'::regclass
      AND conname = 'omni_oauth_grants_source_sync_health_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Source coverage checkpoint schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  144,
  'source_coverage_projection_v1',
  'a40a9c1c20b2732a44219a9cb3eacf1291d6f7b9e12e8dce3d70e49a70d299db',
  clock_timestamp()
);

COMMIT;
