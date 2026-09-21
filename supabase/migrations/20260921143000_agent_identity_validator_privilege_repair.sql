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

  IF latest_version IS DISTINCT FROM 190 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 190
      AND name = 'moltbook_agent_connections_v1'
      AND checksum = 'e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46'
  ) <> 1 THEN
    RAISE EXCEPTION 'Agent identity validator repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER FUNCTION public.omni_validate_agent_definition_version_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.omni_validate_agent_definition_version_v1()
  SET search_path TO pg_catalog, public;

REVOKE ALL ON FUNCTION
  public.omni_validate_agent_definition_version_v1()
  FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_agent_definition_version_v1()
      FROM omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_agent_definition_version_v1()
      FROM omni_maintenance;
  END IF;
END
$roles$;

DO $verify$
DECLARE
  validator_oid OID :=
    'public.omni_validate_agent_definition_version_v1()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    WHERE procedure.oid = validator_oid
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_agent_definition_versions'::regclass
      AND trigger_record.tgname =
        'omni_agent_definition_version_validate'
      AND trigger_record.tgfoid = validator_oid
      AND NOT trigger_record.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Agent definition validator privilege repair is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  191,
  'agent_identity_validator_privilege_repair_v1',
  '225d62212d28a5c6186d0e62d402a61e0283bfd34695f1f8aa25b2e1132593f2',
  clock_timestamp()
);

COMMIT;
