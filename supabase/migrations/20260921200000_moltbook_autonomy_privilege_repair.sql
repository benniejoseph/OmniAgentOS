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

  IF latest_version IS DISTINCT FROM 194 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 194
      AND name = 'moltbook_autonomy_v1'
      AND checksum = '66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef'
  ) <> 1 THEN
    RAISE EXCEPTION 'Moltbook autonomy privilege repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Serving roles must never receive direct access to global authentication
-- relations. This exact-owner projection exposes only the three fields needed
-- to revalidate one Moltbook authority, and only inside a validated actor scope
-- or the dedicated audited maintenance connection.
CREATE OR REPLACE FUNCTION public.omni_resolve_moltbook_owner_membership_v1(
  candidate_tenant_id TEXT,
  candidate_owner_actor_id TEXT
)
RETURNS TABLE (
  canonical_actor_id TEXT,
  auth_user_id TEXT,
  membership_role TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  system_scope_requested BOOLEAN :=
    COALESCE(current_setting('omni.system_scope', TRUE), '') = 'true';
  caller_is_maintenance BOOLEAN;
BEGIN
  IF candidate_tenant_id IS NULL
    OR candidate_tenant_id IS DISTINCT FROM btrim(candidate_tenant_id)
    OR char_length(candidate_tenant_id) NOT BETWEEN 1 AND 160
    OR candidate_owner_actor_id IS NULL
    OR candidate_owner_actor_id IS DISTINCT FROM btrim(candidate_owner_actor_id)
    OR char_length(candidate_owner_actor_id) NOT BETWEEN 1 AND 320
  THEN
    RAISE EXCEPTION 'Moltbook owner membership request is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_record
    CROSS JOIN pg_catalog.pg_class schema_table
    WHERE role_record.rolname = session_user
      AND role_record.rolname = 'omni_maintenance'
      AND role_record.rolbypassrls
      AND NOT role_record.rolsuper
      AND schema_table.oid = 'public.omni_schema_version'::regclass
      AND role_record.oid <> schema_table.relowner
  ) INTO caller_is_maintenance;

  IF caller_is_maintenance THEN
    IF NOT system_scope_requested
      OR NULLIF(current_setting('omni.system_reason', TRUE), '') IS NULL
    THEN
      RAISE EXCEPTION 'Moltbook maintenance membership lookup requires audited system scope'
        USING ERRCODE = '42501';
    END IF;
  ELSIF system_scope_requested
    OR candidate_tenant_id IS DISTINCT FROM
      NULLIF(current_setting('omni.tenant_id', TRUE), '')
    OR NOT public.omni_actor_scope_v1_allows(
      candidate_tenant_id,
      candidate_owner_actor_id
    )
  THEN
    RAISE EXCEPTION 'Moltbook owner membership request is outside actor scope'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    identifier.canonical_actor_id::TEXT,
    auth_user.id::TEXT,
    membership.role::TEXT
  FROM public.omni_auth_user_actor_identifiers identifier
  JOIN public.omni_auth_users auth_user
    ON auth_user.actor_id = identifier.canonical_actor_id
    AND auth_user.status = 'active'
  JOIN public.omni_auth_memberships membership
    ON membership.tenant_id = candidate_tenant_id
    AND membership.user_id = auth_user.id
    AND membership.status = 'active'
    AND membership.role IN ('operator', 'admin')
  WHERE identifier.actor_identifier COLLATE "C" =
    candidate_owner_actor_id COLLATE "C";
END
$function$;

REVOKE ALL ON FUNCTION
  public.omni_resolve_moltbook_owner_membership_v1(TEXT, TEXT)
  FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_resolve_moltbook_owner_membership_v1(TEXT, TEXT)
      TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_resolve_moltbook_owner_membership_v1(TEXT, TEXT)
      TO omni_maintenance;
  END IF;
END
$roles$;

-- These functions are trigger-only validators. They require the private actor
-- identifier relation, but neither serving role may invoke them directly.
ALTER FUNCTION public.omni_validate_moltbook_authority_version_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.omni_validate_moltbook_authority_version_v1()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.omni_validate_moltbook_enrollment_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.omni_validate_moltbook_enrollment_v1()
  SET search_path TO pg_catalog, public;

REVOKE ALL ON FUNCTION
  public.omni_validate_moltbook_authority_version_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_validate_moltbook_enrollment_v1()
  FROM PUBLIC;

DO $trigger_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_moltbook_authority_version_v1()
      FROM omni_runtime;
    REVOKE ALL ON FUNCTION
      public.omni_validate_moltbook_enrollment_v1()
      FROM omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON FUNCTION
      public.omni_validate_moltbook_authority_version_v1()
      FROM omni_maintenance;
    REVOKE ALL ON FUNCTION
      public.omni_validate_moltbook_enrollment_v1()
      FROM omni_maintenance;
  END IF;
END
$trigger_roles$;

DO $verify$
DECLARE
  resolver_oid OID :=
    'public.omni_resolve_moltbook_owner_membership_v1(text,text)'::regprocedure;
  authority_validator_oid OID :=
    'public.omni_validate_moltbook_authority_version_v1()'::regprocedure;
  enrollment_validator_oid OID :=
    'public.omni_validate_moltbook_enrollment_v1()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    WHERE procedure.oid = resolver_oid
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND 'search_path=pg_catalog, public' = ANY(procedure.proconfig)
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
        ) privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  ) OR (
    SELECT count(*)
    FROM pg_proc procedure
    WHERE procedure.oid IN (
      authority_validator_oid,
      enrollment_validator_oid
    )
      AND procedure.prosecdef
      AND 'search_path=pg_catalog, public' = ANY(procedure.proconfig)
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
        ) privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_moltbook_authority_versions'::regclass
      AND trigger_record.tgname =
        'omni_moltbook_authority_versions_validate'
      AND trigger_record.tgfoid = authority_validator_oid
      AND NOT trigger_record.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_moltbook_autonomy_enrollments'::regclass
      AND trigger_record.tgname =
        'omni_moltbook_enrollments_validate'
      AND trigger_record.tgfoid = enrollment_validator_oid
      AND NOT trigger_record.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy privilege repair is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND NOT has_function_privilege(
      'omni_runtime',
      'public.omni_resolve_moltbook_owner_membership_v1(text,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Runtime Moltbook owner membership resolver grant is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND (
      has_function_privilege(
        'omni_runtime',
        'public.omni_validate_moltbook_authority_version_v1()',
        'EXECUTE'
      )
      OR has_function_privilege(
        'omni_runtime',
        'public.omni_validate_moltbook_enrollment_v1()',
        'EXECUTE'
      )
      OR has_table_privilege(
        'omni_runtime',
        'public.omni_auth_user_actor_identifiers',
        'SELECT'
      )
    )
  THEN
    RAISE EXCEPTION 'Runtime Moltbook private identity boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance')
    AND NOT has_function_privilege(
      'omni_maintenance',
      'public.omni_resolve_moltbook_owner_membership_v1(text,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Maintenance Moltbook owner membership resolver grant is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance')
    AND (
      has_function_privilege(
        'omni_maintenance',
        'public.omni_validate_moltbook_authority_version_v1()',
        'EXECUTE'
      )
      OR has_function_privilege(
        'omni_maintenance',
        'public.omni_validate_moltbook_enrollment_v1()',
        'EXECUTE'
      )
      OR has_table_privilege(
        'omni_maintenance',
        'public.omni_auth_user_actor_identifiers',
        'SELECT'
      )
    )
  THEN
    RAISE EXCEPTION 'Maintenance Moltbook private identity boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  195,
  'moltbook_autonomy_privilege_repair_v1',
  'c02b2ca195cbb00c206320eb2074fed7981c282c356f1d4320c6c1ac866adf94',
  clock_timestamp()
);

COMMIT;
