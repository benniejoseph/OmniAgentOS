DO $guard$
DECLARE
  latest_version INTEGER;
  predecessor_name TEXT;
  predecessor_checksum TEXT;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION
      'maintenance_system_scope_v1 requires exact predecessor 150; found %',
      latest_version;
  END IF;

  SELECT name, checksum
  INTO predecessor_name, predecessor_checksum
  FROM public.omni_schema_version
  WHERE version = 150;

  IF predecessor_name IS DISTINCT FROM 'legacy_memory_owner_enrollment_v1'
    OR predecessor_checksum IS DISTINCT FROM
      'd43fafd08d25aa6f3c7646828a43596a1c9301fc3b99d8fa82c077175a57cab2'
  THEN
    RAISE EXCEPTION 'maintenance_system_scope_v1 predecessor marker is invalid';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.omni_system_scope_enabled()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    COALESCE(current_setting('omni.system_scope', TRUE), '') = 'true'
    AND NULLIF(current_setting('omni.system_reason', TRUE), '') IS NOT NULL
    AND (
      current_user = (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = current_user
          AND rolbypassrls
          AND NOT rolsuper
      )
    )
$function$;

INSERT INTO public.omni_schema_version (
  version,
  name,
  checksum,
  applied_at
) VALUES (
  151,
  'maintenance_system_scope_v1',
  '6eeab2482987d833ab99862640348951d6d798d732cb91df91791ac29b098679',
  NOW()
);
