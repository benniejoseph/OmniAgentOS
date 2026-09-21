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

  IF latest_version IS DISTINCT FROM 191 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 191
      AND name = 'agent_identity_validator_privilege_repair_v1'
      AND checksum = '225d62212d28a5c6186d0e62d402a61e0283bfd34695f1f8aa25b2e1132593f2'
  ) <> 1 THEN
    RAISE EXCEPTION 'Agent private trigger repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER FUNCTION public.omni_validate_execution_principal_insert()
  SECURITY DEFINER;
ALTER FUNCTION public.omni_validate_execution_principal_insert()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.omni_enforce_moltbook_connection_agent_boundary_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.omni_enforce_moltbook_connection_agent_boundary_v1()
  SET search_path TO pg_catalog, public;

REVOKE ALL ON FUNCTION
  public.omni_validate_execution_principal_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_enforce_moltbook_connection_agent_boundary_v1()
  FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_execution_principal_insert()
      FROM omni_runtime;
    REVOKE ALL ON FUNCTION
      public.omni_enforce_moltbook_connection_agent_boundary_v1()
      FROM omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_execution_principal_insert()
      FROM omni_maintenance;
    REVOKE ALL ON FUNCTION
      public.omni_enforce_moltbook_connection_agent_boundary_v1()
      FROM omni_maintenance;
  END IF;
END
$roles$;

DO $verify$
DECLARE
  principal_validator_oid OID :=
    'public.omni_validate_execution_principal_insert()'::regprocedure;
  moltbook_validator_oid OID :=
    'public.omni_enforce_moltbook_connection_agent_boundary_v1()'::regprocedure;
BEGIN
  IF (
    SELECT count(*)
    FROM pg_proc procedure
    WHERE procedure.oid IN (
      principal_validator_oid,
      moltbook_validator_oid
    )
      AND procedure.prosecdef
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
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_tenant_execution_principals'::regclass
      AND trigger_record.tgname =
        'omni_execution_principal_validate_insert'
      AND trigger_record.tgfoid = principal_validator_oid
      AND NOT trigger_record.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_moltbook_connections'::regclass
      AND trigger_record.tgname =
        'omni_moltbook_connections_agent_boundary'
      AND trigger_record.tgfoid = moltbook_validator_oid
      AND NOT trigger_record.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Agent private trigger privilege repair is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  192,
  'agent_private_trigger_privilege_repair_v1',
  'a8beaa32d24c97ad6763801982c474414ab93a046f98d91fc3df30bb9e172fab',
  clock_timestamp()
);

COMMIT;
