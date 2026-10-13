BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'pg_catalog, public', true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 254 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 254
      AND name = 'responsibility_workspace_read_fence_v1'
      AND checksum = 'ffb985978aa05cc4a703a8cd24b3c18ce35d042cf8ebe4e1fffe8a4d36402548'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility workspace fence ACL predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$predecessor$;

-- Owner default privileges can grant named roles EXECUTE when v254 creates the
-- function. Revoking PUBLIC alone leaves those grants. Reconcile only this
-- exact helper; keep its body, owner, authority-table grants and global defaults.
DO $acl_repair$
DECLARE grantee_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_class workspace ON workspace.oid = 'public.omni_tenant_workspaces'::pg_catalog.regclass
      JOIN pg_catalog.pg_class membership ON membership.oid = 'public.omni_tenant_workspace_memberships'::pg_catalog.regclass
      JOIN pg_catalog.pg_roles runtime ON runtime.rolname = 'omni_runtime'
      WHERE procedure.oid = pg_catalog.to_regprocedure('public.omni_lock_responsibility_workspace_v1(text,text,text)')
        AND procedure.prosecdef AND procedure.provolatile = 'v'
        AND procedure.prorettype = 'boolean'::pg_catalog.regtype
        AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']::TEXT[]
        AND procedure.proowner = workspace.relowner AND procedure.proowner = membership.relowner
        AND procedure.proowner <> runtime.oid
        AND NOT pg_catalog.has_any_column_privilege(runtime.oid, workspace.oid, 'UPDATE')
        AND NOT pg_catalog.has_any_column_privilege(runtime.oid, membership.oid, 'UPDATE')
  ) THEN RAISE EXCEPTION 'Responsibility workspace fence function identity is invalid' USING ERRCODE = '55000'; END IF;

  REVOKE ALL ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) FROM PUBLIC;
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))) privilege
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE procedure.oid = 'public.omni_lock_responsibility_workspace_v1(text,text,text)'::pg_catalog.regprocedure
        AND privilege.grantee <> procedure.proowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) FROM %I', grantee_name);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) TO omni_runtime;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_roles runtime ON runtime.rolname = 'omni_runtime'
      WHERE procedure.oid = 'public.omni_lock_responsibility_workspace_v1(text,text,text)'::pg_catalog.regprocedure
        AND pg_catalog.has_function_privilege(runtime.oid, procedure.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))) privilege
          WHERE privilege.grantee NOT IN (procedure.proowner, runtime.oid)
            OR (privilege.grantee = runtime.oid AND privilege.is_grantable))
  ) THEN RAISE EXCEPTION 'Responsibility workspace fence ACL repair is incomplete' USING ERRCODE = '55000'; END IF;
END
$acl_repair$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (255,'responsibility_workspace_fence_acl_repair_v1','279d151896f8c954d79becfb79966a1af04d43d23fec55eddc765bb0f4cf49d5',clock_timestamp());
COMMIT;
