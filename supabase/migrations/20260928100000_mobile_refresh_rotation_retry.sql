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

  IF latest_version IS DISTINCT FROM 208 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 208
      AND name = 'schema_catalog_convergence_v1'
      AND checksum = '514f00004c8726a2c762f6069728b20d4816a92731c72c125bf39cbca9a0371f'
  ) <> 1 THEN
    RAISE EXCEPTION 'Mobile refresh rotation retry predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- For 60 seconds after a rotation, the refresh token it replaced gets the
-- same pair again instead of revoking the session family, so a retry after a
-- lost response, or a second engine still holding that token, is not taken
-- for theft. The pair is derived from that token and refresh_rotation_key,
-- which the next rotation replaces, so the database stores neither token.
--
-- A release without these columns leaves them unchanged when it rotates. The
-- pair it issues is then not the derived one, so it is never issued again.
ALTER TABLE public.omni_mobile_sessions
  ADD COLUMN IF NOT EXISTS refresh_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_rotation_key TEXT;

-- ADD COLUMN IF NOT EXISTS keeps a column that already exists, whatever its
-- type, so refuse one that is not what this migration adds.
DO $columns$
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_mobile_sessions'
      AND is_nullable = 'YES'
      AND column_default IS NULL
      AND (
        (column_name = 'refresh_rotated_at'
          AND data_type = 'timestamp with time zone')
        OR (column_name = 'refresh_rotation_key' AND data_type = 'text')
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'omni_mobile_sessions has a refresh rotation column this migration does not add'
      USING ERRCODE = '55000';
  END IF;
END
$columns$;

-- Every existing row has both columns NULL here, so adding the constraint
-- NOT VALID leaves no row unchecked and does not scan the table.
ALTER TABLE public.omni_mobile_sessions
  DROP CONSTRAINT IF EXISTS omni_mobile_sessions_refresh_rotation_check;

ALTER TABLE public.omni_mobile_sessions
  ADD CONSTRAINT omni_mobile_sessions_refresh_rotation_check CHECK (
    (refresh_rotated_at IS NULL) = (refresh_rotation_key IS NULL)
    AND (
      refresh_rotation_key IS NULL
      OR refresh_rotation_key ~ '^[A-Za-z0-9_-]{43}$'
    )
  ) NOT VALID;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  209,
  'mobile_refresh_rotation_retry_v1',
  'e78561b7a9b0c38fd91376d9f8fb094e3b629d5e5b94b3a48592a9b89855531f',
  clock_timestamp()
);

COMMIT;
