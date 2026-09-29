BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 209 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 209
      AND name = 'mobile_refresh_rotation_retry_v1'
      AND checksum = 'e78561b7a9b0c38fd91376d9f8fb094e3b629d5e5b94b3a48592a9b89855531f'
  ) <> 1 THEN
    RAISE EXCEPTION 'OAuth sync backoff predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- A connection whose sync reaches none of its sources waits before the
-- scheduler tries it again: five minutes, doubling with each such sync in a
-- row, up to six hours. A sync that reaches any source, or reconnecting the
-- account, clears the wait. A manual sync does not wait.
--
-- A release without these columns neither reads nor writes them. It retries
-- on every tick as before, and the count it leaves is where the next sync of
-- this release starts.
ALTER TABLE public.omni_oauth_grants
  ADD COLUMN IF NOT EXISTS sync_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_retry_at TIMESTAMPTZ;

-- ADD COLUMN IF NOT EXISTS keeps a column that already exists, whatever its
-- type, so refuse one that is not what this migration adds.
DO $columns$
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_oauth_grants'
      AND (
        (column_name = 'sync_failure_count'
          AND data_type = 'integer'
          AND is_nullable = 'NO'
          AND column_default = '0')
        OR (column_name = 'sync_retry_at'
          AND data_type = 'timestamp with time zone'
          AND is_nullable = 'YES'
          AND column_default IS NULL)
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'omni_oauth_grants has a sync backoff column this migration does not add'
      USING ERRCODE = '55000';
  END IF;
END
$columns$;

-- Every existing row has a count of 0 and no retry time here, so adding the
-- constraint NOT VALID leaves no row unchecked and does not scan the table.
ALTER TABLE public.omni_oauth_grants
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_sync_backoff_check;

ALTER TABLE public.omni_oauth_grants
  ADD CONSTRAINT omni_oauth_grants_sync_backoff_check CHECK (
    sync_failure_count >= 0
    AND (sync_retry_at IS NULL) = (sync_failure_count = 0)
  ) NOT VALID;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  210,
  'oauth_sync_backoff_v1',
  '3c2122c7222e4a5aafca6e5ef3eca7905353be7aae675367a16b9cdb4787fff3',
  clock_timestamp()
);

COMMIT;
