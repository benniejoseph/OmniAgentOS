BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 192 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 192
      AND name = 'agent_private_trigger_privilege_repair_v1'
      AND checksum = 'a8beaa32d24c97ad6763801982c474414ab93a046f98d91fc3df30bb9e172fab'
  ) <> 1 THEN
    RAISE EXCEPTION 'Execution principal validator grant predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION public.omni_execution_principal_row_is_valid(
  SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_execution_principal_row_is_valid(
        SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT,
        BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
        TIMESTAMPTZ, TIMESTAMPTZ
      ) TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_execution_principal_row_is_valid(
        SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT,
        BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
        TIMESTAMPTZ, TIMESTAMPTZ
      ) TO omni_maintenance;
  END IF;
END
$roles$;

DO $verify$
DECLARE
  validator_oid OID := 'public.omni_execution_principal_row_is_valid(
    SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT,
    TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  )'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    WHERE procedure.oid = validator_oid
      AND procedure.prokind = 'f'
      AND procedure.provolatile = 'i'
      AND NOT procedure.prosecdef
      AND 'search_path=pg_catalog, public' = ANY(procedure.proconfig)
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(
          COALESCE(
            procedure.proacl,
            acldefault('f', procedure.proowner)
          )
        ) privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  ) OR (
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND NOT has_function_privilege(
      'omni_runtime', validator_oid, 'EXECUTE'
    )
  ) OR (
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance')
    AND NOT has_function_privilege(
      'omni_maintenance', validator_oid, 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'Execution principal row-validator grant is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  193,
  'execution_principal_row_validator_grant_v1',
  '9b787d1cfa1d6ae007cf8594f43c00045bab640b1f596e91d330923acc3bf2f7',
  clock_timestamp()
);

COMMIT;
