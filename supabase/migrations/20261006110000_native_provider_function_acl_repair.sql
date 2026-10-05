BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 244 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=244
      AND name='native_github_upgrades_v1'
      AND checksum='710fb954e502ad8c3620b992893cac50093854e47092f6ffd0c16859fc706926'
  )<>1 THEN RAISE EXCEPTION 'Native provider function ACL predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$predecessor$;

-- Default privileges on the production function owner gave named roles direct
-- EXECUTE grants at CREATE FUNCTION time. Revoking PUBLIC in v244 did not
-- remove those grants from these two SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT),
  public.omni_native_provider_singleflight_v1() FROM PUBLIC;
DO $acl_repair$
DECLARE grantee_name TEXT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='omni_runtime') THEN
    RAISE EXCEPTION 'Native provider pending helper requires omni_runtime' USING ERRCODE='55000';
  END IF;
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) privilege
      JOIN pg_catalog.pg_roles grantee ON grantee.oid=privilege.grantee
      WHERE proc.oid IN (
        'public.omni_native_provider_pending_v1(text,text,text,text)'::pg_catalog.regprocedure,
        'public.omni_native_provider_singleflight_v1()'::pg_catalog.regprocedure)
        AND privilege.grantee<>proc.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT), public.omni_native_provider_singleflight_v1() FROM %I',grantee_name);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT)
    TO omni_runtime;
END
$acl_repair$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(245,'native_provider_function_acl_repair_v1',
  '3d1e2f480d424d4f6da66008744928f883ee06745e32b147a26953c73c7c09f0',
  clock_timestamp());
COMMIT;
