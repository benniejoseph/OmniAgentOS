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

/**
 * Runtime form of schema migration v192. These trigger-only validators need
 * canonical actor evidence, but the application and maintenance roles must
 * not receive direct access to the private identifier relation.
 */
export async function ensureAgentPrivateTriggerPrivilegeRepairV1(
  sql: MigrationSql,
) {
  await sql.query(String.raw`
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
  `);
}

/** Runtime form of schema migration v193. */
export async function ensureExecutionPrincipalRowValidatorGrantV1(
  sql: MigrationSql,
) {
  await sql.query(String.raw`
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
  `);
}
