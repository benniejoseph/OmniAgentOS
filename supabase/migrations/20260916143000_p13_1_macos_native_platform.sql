BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 177 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 177
      AND name = 'market_deterministic_backtests_v1'
      AND checksum = '27b2d1959799b90893282bb78e1e74724ce62aa93597691627ae9b9757d25c6a'
  ) <> 1 THEN
    RAISE EXCEPTION 'macOS native platform predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF to_regclass('public.omni_mobile_sessions') IS NULL
    OR to_regclass('public.omni_mobile_push_registrations') IS NULL
  THEN
    RAISE EXCEPTION 'macOS native platform relations are missing'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

LOCK TABLE public.omni_mobile_sessions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.omni_mobile_push_registrations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.omni_mobile_sessions
  DROP CONSTRAINT IF EXISTS omni_mobile_sessions_client_attestation_check;
ALTER TABLE public.omni_mobile_sessions
  ADD CONSTRAINT omni_mobile_sessions_client_attestation_check CHECK (
    (
      client_contract_version = 0
      AND app_build_number IS NULL
      AND client_attested_at IS NULL
    ) OR (
      client_contract_version BETWEEN 1 AND 2147483647
      AND app_build_number IS NOT NULL
      AND app_build_number BETWEEN 1 AND 2147483647
      AND platform IS NOT NULL
      AND platform COLLATE "C" IN ('android', 'ios', 'macos')
      AND app_version IS NOT NULL
      AND app_version = btrim(app_version)
      AND client_attested_at IS NOT NULL
      AND app_version COLLATE "C" ~
        '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
    )
  ) NOT VALID;
ALTER TABLE public.omni_mobile_sessions
  VALIDATE CONSTRAINT omni_mobile_sessions_client_attestation_check;

-- P12.5 used unnamed checks. Resolve them by their exact constrained columns
-- and bounded legacy vocabulary instead of guessing generated constraint names.
DO $migration$
DECLARE
  constraint_record RECORD;
  platform_attribute SMALLINT;
  provider_attribute SMALLINT;
BEGIN
  SELECT attnum INTO STRICT platform_attribute
  FROM pg_attribute
  WHERE attrelid = 'public.omni_mobile_push_registrations'::regclass
    AND attname = 'platform'
    AND NOT attisdropped;

  SELECT attnum INTO STRICT provider_attribute
  FROM pg_attribute
  WHERE attrelid = 'public.omni_mobile_push_registrations'::regclass
    AND attname = 'provider'
    AND NOT attisdropped;

  ALTER TABLE public.omni_mobile_push_registrations
    DROP CONSTRAINT IF EXISTS omni_mobile_push_registrations_platform_check_v2;
  ALTER TABLE public.omni_mobile_push_registrations
    DROP CONSTRAINT IF EXISTS omni_mobile_push_registrations_apns_platform_check_v2;

  FOR constraint_record IN
    SELECT
      constraint_row.conname,
      lower(pg_get_constraintdef(constraint_row.oid, TRUE)) AS definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid =
        'public.omni_mobile_push_registrations'::regclass
      AND constraint_row.contype = 'c'
      AND (
        (
          constraint_row.conkey = ARRAY[platform_attribute]::SMALLINT[]
          AND position(
            'android' IN lower(pg_get_constraintdef(constraint_row.oid, TRUE))
          ) > 0
          AND position(
            'ios' IN lower(pg_get_constraintdef(constraint_row.oid, TRUE))
          ) > 0
        ) OR (
          cardinality(constraint_row.conkey) = 2
          AND constraint_row.conkey @>
            ARRAY[platform_attribute, provider_attribute]::SMALLINT[]
          AND position(
            'apns' IN lower(pg_get_constraintdef(constraint_row.oid, TRUE))
          ) > 0
        )
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.omni_mobile_push_registrations DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;
END
$migration$;

ALTER TABLE public.omni_mobile_push_registrations
  ADD CONSTRAINT omni_mobile_push_registrations_platform_check_v2
  CHECK (platform COLLATE "C" IN ('android', 'ios', 'macos')) NOT VALID;
ALTER TABLE public.omni_mobile_push_registrations
  VALIDATE CONSTRAINT omni_mobile_push_registrations_platform_check_v2;

ALTER TABLE public.omni_mobile_push_registrations
  ADD CONSTRAINT omni_mobile_push_registrations_apns_platform_check_v2
  CHECK (
    provider <> 'apns'
    OR platform COLLATE "C" IN ('ios', 'macos')
  ) NOT VALID;
ALTER TABLE public.omni_mobile_push_registrations
  VALIDATE CONSTRAINT omni_mobile_push_registrations_apns_platform_check_v2;

DO $verify$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid IN (
      'public.omni_mobile_sessions'::regclass,
      'public.omni_mobile_push_registrations'::regclass
    )
      AND constraint_row.conname IN (
        'omni_mobile_sessions_client_attestation_check',
        'omni_mobile_push_registrations_platform_check_v2',
        'omni_mobile_push_registrations_apns_platform_check_v2'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND COALESCE(
        (to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN,
        TRUE
      )
  ) <> 3 OR EXISTS (
    SELECT 1
    FROM public.omni_mobile_sessions
    WHERE NOT (
      (
        client_contract_version = 0
        AND app_build_number IS NULL
        AND client_attested_at IS NULL
      ) OR (
        client_contract_version BETWEEN 1 AND 2147483647
        AND app_build_number BETWEEN 1 AND 2147483647
        AND platform COLLATE "C" IN ('android', 'ios', 'macos')
        AND app_version IS NOT NULL
        AND app_version = btrim(app_version)
        AND client_attested_at IS NOT NULL
        AND app_version COLLATE "C" ~
          '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
      )
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_mobile_push_registrations
    WHERE platform COLLATE "C" NOT IN ('android', 'ios', 'macos')
      OR (provider = 'apns' AND platform COLLATE "C" NOT IN ('ios', 'macos'))
  ) THEN
    RAISE EXCEPTION 'macOS native platform constraints are invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  178,
  'p13_1_macos_native_platform_v1',
  'b5cca5f81cd6cef3861d541d04ad4d15468476c8e954d610255fd3c70a237262',
  clock_timestamp()
);

COMMIT;
