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

  IF latest_version IS DISTINCT FROM 211 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 211
      AND name = 'rls_scope_initplans_v1'
      AND checksum = '84d660e88fc6bcdaf9bac76939d03ad470e2fe6fee615d52be55a16dda6a88e1'
  ) <> 1 THEN
    RAISE EXCEPTION 'Operation job quarantine predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- A job's lease lapses when its worker stops reporting before the lease ends,
-- which is what a job that crashes or hangs its worker does on every
-- delivery. lease_lapses counts the lapses in a row; any outcome the worker
-- reports clears it. After three in a row the job is quarantined: it keeps
-- its payload and error, nothing delivers it again, and only an operator
-- releases it.
--
-- A release without this column neither reads nor writes it, and it never
-- writes the quarantined status. It redelivers a lapsed job as before, and
-- the count it leaves is where the next lapse of this release starts.
ALTER TABLE public.omni_operation_jobs
  ADD COLUMN IF NOT EXISTS lease_lapses INTEGER NOT NULL DEFAULT 0;

-- ADD COLUMN IF NOT EXISTS keeps a column that already exists, whatever its
-- type, so refuse one that is not what this migration adds.
DO $columns$
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_operation_jobs'
      AND column_name = 'lease_lapses'
      AND data_type = 'integer'
      AND is_nullable = 'NO'
      AND column_default = '0'
  ) <> 1 THEN
    RAISE EXCEPTION 'omni_operation_jobs has a lease_lapses column this migration does not add'
      USING ERRCODE = '55000';
  END IF;
END
$columns$;

-- Every existing row has a count of 0 here, so adding the constraint
-- NOT VALID leaves no row unchecked and does not scan the table.
ALTER TABLE public.omni_operation_jobs
  DROP CONSTRAINT IF EXISTS omni_operation_jobs_lease_lapses_check;

ALTER TABLE public.omni_operation_jobs
  ADD CONSTRAINT omni_operation_jobs_lease_lapses_check CHECK (
    lease_lapses >= 0
  ) NOT VALID;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  212,
  'operation_job_quarantine_v1',
  '35fa5330f5f0577af4af9f95b5998954d7db829bff4e40c13e14a21461f67898',
  clock_timestamp()
);

COMMIT;
