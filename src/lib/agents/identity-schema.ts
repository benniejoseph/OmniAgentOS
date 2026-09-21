type MigrationSql = Readonly<{
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
}>;

/**
 * Runtime form of schema migration v191. The definition-version trigger must
 * validate canonical ownership without granting the application role direct
 * read access to the private actor-identifier table.
 */
export async function ensureAgentIdentityValidatorPrivilegeRepairV1(
  sql: MigrationSql,
) {
  await sql.query(String.raw`
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
  `);
}
