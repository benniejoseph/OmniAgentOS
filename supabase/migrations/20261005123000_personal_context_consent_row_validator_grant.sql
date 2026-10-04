BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 224 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 224
      AND name = 'meeting_calendar_sync_acceptances_v1'
      AND checksum = 'cb10e54d898d741a666336d05c91364b52926a0237e6220c24fa629df73c7ef5'
  ) <> 1 THEN
    RAISE EXCEPTION 'Personal-context consent validator grant predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- The consent table CHECK executes this pure row validator as its caller.
-- Migration 148 revoked PUBLIC execution but omitted the matching grants for
-- the two roles it authorized to INSERT or UPDATE consent lifecycle fields.
-- No table, lifecycle trigger, scope policy, or function body changes here.
REVOKE ALL ON FUNCTION public.omni_personal_context_consent_row_is_valid(
  SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT, TEXT,
  BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.omni_personal_context_consent_row_is_valid(
      SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT, TEXT,
      BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.omni_personal_context_consent_row_is_valid(
      SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT, TEXT,
      BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) TO omni_maintenance;
  END IF;
END
$roles$;

DO $verify$
DECLARE validator_oid OID := 'public.omni_personal_context_consent_row_is_valid(
  SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT, TEXT,
  BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
)'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc procedure
    WHERE procedure.oid = validator_oid
      AND procedure.prokind = 'f'
      AND procedure.provolatile = 'i'
      AND NOT procedure.prosecdef
      AND 'search_path=pg_catalog, public' = ANY(procedure.proconfig)
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      )
  ) OR (
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND NOT has_function_privilege('omni_runtime', validator_oid, 'EXECUTE')
  ) OR (
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance')
    AND NOT has_function_privilege('omni_maintenance', validator_oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Personal-context consent row-validator grant is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  225,
  'personal_context_consent_row_validator_grant_v1',
  'd1b7856075f4d3f6212cb85b13c6f1e59fe82376f908418d098ae6963657850b',
  clock_timestamp()
);

COMMIT;
