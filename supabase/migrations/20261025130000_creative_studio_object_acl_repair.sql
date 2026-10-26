BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'pg_catalog, public', true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 261 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 261
      AND name = 'creative_studio_v1'
      AND checksum = '4c7759ec2b4a57d0a85f9470292cdfa810e2b20c570b73c61b4ddcda3698c6e5'
  ) <> 1 THEN
    RAISE EXCEPTION 'Studio object ACL predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- v261 closed its SECURITY DEFINER ACLs, but PUBLIC-only revocation on these
-- objects left named owner-default grants intact. Repair only these objects;
-- retain their owners, data, definitions, RLS and global default privileges.
LOCK TABLE public.omni_studio_budget_reservations, public.omni_studio_records,
  public.omni_studio_run_events IN SHARE ROW EXCLUSIVE MODE;
DO $studio_object_acl$
DECLARE
  object_name TEXT;
  grantee_name TEXT;
  expected_grants TEXT[];
  actual_grants TEXT[];
  record_owner OID;
  target RECORD;
BEGIN
  IF EXISTS (
    SELECT required.name FROM (VALUES ('omni_runtime'), ('omni_maintenance'), ('omni_backup')) required(name)
    LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.name
    WHERE role.oid IS NULL
  ) THEN RAISE EXCEPTION 'Studio object ACL roles are missing' USING ERRCODE = '55000'; END IF;

  SELECT relowner INTO record_owner FROM pg_catalog.pg_class
    WHERE oid = 'public.omni_studio_records'::pg_catalog.regclass;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid IN ('public.omni_studio_records'::pg_catalog.regclass,
      'public.omni_studio_run_events'::pg_catalog.regclass,
      'public.omni_studio_budget_reservations'::pg_catalog.regclass)
      AND (relation.relkind <> 'r' OR NOT relation.relrowsecurity
        OR NOT relation.relforcerowsecurity OR relation.relowner <> record_owner)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles role
    WHERE role.rolname IN ('omni_runtime', 'omni_maintenance', 'omni_backup')
      AND (role.oid = record_owner OR pg_catalog.pg_has_role(role.oid, record_owner, 'MEMBER'))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class sequence
    WHERE sequence.oid = 'public.omni_studio_run_events_seq_seq'::pg_catalog.regclass
      AND sequence.relkind = 'S' AND sequence.relowner = record_owner
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_trigger trigger ON trigger.tgfoid = procedure.oid
    WHERE procedure.oid = 'public.omni_protect_studio_record_v1()'::pg_catalog.regprocedure
      AND procedure.proowner = record_owner AND NOT procedure.prosecdef
      AND procedure.prorettype = 'trigger'::pg_catalog.regtype
      AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']::TEXT[]
      AND pg_catalog.md5(procedure.prosrc) = 'f46e78267e5b79c6d40e8dca2cc5204e'
      AND trigger.tgrelid = 'public.omni_studio_records'::pg_catalog.regclass
      AND trigger.tgname = 'omni_protect_studio_record_v1' AND trigger.tgenabled = 'O'
      -- Exact BEFORE ROW UPDATE coverage, without a WHEN or column filter.
      -- A matching function alone cannot protect rows the trigger never visits.
      AND trigger.tgtype = 19 AND trigger.tgqual IS NULL
      AND trigger.tgattr = ''::pg_catalog.int2vector
      AND trigger.tgnargs = 0 AND pg_catalog.octet_length(trigger.tgargs) = 0
      AND NOT trigger.tgisinternal AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred
      AND trigger.tgconstraint = 0 AND trigger.tgparentid = 0
      AND trigger.tgoldtable IS NULL AND trigger.tgnewtable IS NULL
  ) THEN RAISE EXCEPTION 'Studio object ACL identity is invalid' USING ERRCODE = '55000'; END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'omni_studio_budget_reservations', 'omni_studio_records', 'omni_studio_run_events'
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC CASCADE', object_name);
    FOR grantee_name IN
      SELECT DISTINCT role.rolname FROM pg_catalog.pg_class relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
        pg_catalog.acldefault('r', relation.relowner))) privilege
      JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
      WHERE relation.oid = pg_catalog.format('public.%I', object_name)::pg_catalog.regclass
        AND privilege.grantee <> relation.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I CASCADE', object_name, grantee_name);
    END LOOP;
    -- Independent column grants survive REVOKE on the table. Close those too,
    -- including grant-option chains; CASCADE is confined to this object's ACL.
    FOR target IN
      SELECT attribute.attname, privilege.grantee, role.rolname
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
      LEFT JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
      WHERE relation.oid = pg_catalog.format('public.%I', object_name)::pg_catalog.regclass
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND privilege.grantee <> relation.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES (%I) ON TABLE public.%I FROM %s CASCADE',
        target.attname, object_name,
        CASE WHEN target.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(target.rolname) END);
    END LOOP;
    EXECUTE pg_catalog.format('GRANT SELECT,INSERT%s ON TABLE public.%I TO omni_runtime,omni_maintenance',
      CASE WHEN object_name = 'omni_studio_records' THEN ',UPDATE' ELSE '' END, object_name);
    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE public.%I TO omni_backup', object_name);
  END LOOP;

  REVOKE ALL PRIVILEGES ON SEQUENCE public.omni_studio_run_events_seq_seq FROM PUBLIC CASCADE;
  FOR grantee_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
      pg_catalog.acldefault('s', relation.relowner))) privilege
    JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'public.omni_studio_run_events_seq_seq'::pg_catalog.regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON SEQUENCE public.omni_studio_run_events_seq_seq FROM %I CASCADE', grantee_name);
  END LOOP;
  GRANT USAGE,SELECT ON SEQUENCE public.omni_studio_run_events_seq_seq TO omni_runtime,omni_maintenance;
  GRANT SELECT ON SEQUENCE public.omni_studio_run_events_seq_seq TO omni_backup;

  REVOKE ALL PRIVILEGES ON FUNCTION public.omni_protect_studio_record_v1() FROM PUBLIC CASCADE;
  FOR grantee_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_proc procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner))) privilege
    JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
    WHERE procedure.oid = 'public.omni_protect_studio_record_v1()'::pg_catalog.regprocedure
      AND privilege.grantee <> procedure.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION public.omni_protect_studio_record_v1() FROM %I CASCADE', grantee_name);
  END LOOP;

  -- Exact direct ACLs, not just an allowlist of roles: grant options and excess
  -- DELETE/UPDATE/sequence UPDATE privileges must also be absent.
  FOREACH object_name IN ARRAY ARRAY[
    'omni_studio_budget_reservations', 'omni_studio_records', 'omni_studio_run_events'
  ] LOOP
    expected_grants := ARRAY['omni_backup:SELECT:false', 'omni_maintenance:INSERT:false',
      'omni_maintenance:SELECT:false', 'omni_runtime:INSERT:false', 'omni_runtime:SELECT:false'];
    IF object_name = 'omni_studio_records' THEN
      expected_grants := expected_grants || ARRAY['omni_maintenance:UPDATE:false', 'omni_runtime:UPDATE:false'];
    END IF;
    SELECT array_agg(value ORDER BY value) INTO expected_grants FROM unnest(expected_grants) value;
    SELECT array_agg(pg_catalog.format('%s:%s:%s', COALESCE(role.rolname, 'PUBLIC'),
      privilege.privilege_type, privilege.is_grantable::text) ORDER BY
      pg_catalog.format('%s:%s:%s', COALESCE(role.rolname, 'PUBLIC'), privilege.privilege_type, privilege.is_grantable::text))
      INTO actual_grants
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
      pg_catalog.acldefault('r', relation.relowner))) privilege
    LEFT JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = pg_catalog.format('public.%I', object_name)::pg_catalog.regclass
      AND privilege.grantee <> relation.relowner;
    IF actual_grants IS DISTINCT FROM expected_grants OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
      WHERE relation.oid = pg_catalog.format('public.%I', object_name)::pg_catalog.regclass
        AND privilege.grantee <> relation.relowner
    ) THEN RAISE EXCEPTION 'Studio table ACL repair is incomplete' USING ERRCODE = '55000'; END IF;
  END LOOP;
  SELECT array_agg(pg_catalog.format('%s:%s:%s', COALESCE(role.rolname, 'PUBLIC'),
    privilege.privilege_type, privilege.is_grantable::text) ORDER BY role.rolname, privilege.privilege_type)
    INTO actual_grants FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
      pg_catalog.acldefault('s', relation.relowner))) privilege
    LEFT JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'public.omni_studio_run_events_seq_seq'::pg_catalog.regclass
      AND privilege.grantee <> relation.relowner;
  IF actual_grants IS DISTINCT FROM ARRAY['omni_backup:SELECT:false',
    'omni_maintenance:SELECT:false', 'omni_maintenance:USAGE:false',
    'omni_runtime:SELECT:false', 'omni_runtime:USAGE:false'] OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner))) privilege
      WHERE procedure.oid = 'public.omni_protect_studio_record_v1()'::pg_catalog.regprocedure
        AND privilege.grantee <> procedure.proowner
  ) THEN RAISE EXCEPTION 'Studio sequence or trigger ACL repair is incomplete' USING ERRCODE = '55000'; END IF;
END
$studio_object_acl$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (262,'creative_studio_object_acl_repair_v1','ad83bdc94e65f8013f7bd9fab92cfe76ac73323554a10596feee62038829159a',clock_timestamp());
COMMIT;
