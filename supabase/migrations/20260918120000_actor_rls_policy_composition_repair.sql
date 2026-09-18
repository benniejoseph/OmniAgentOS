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

  IF latest_version IS DISTINCT FROM 182 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 182
      AND name = 'p13_3_local_computer_open_url_action_v1'
      AND checksum = '46a2975c9099d954bc7f7ff6aa537076f14f8dce274e53f33826a38471d1f5e4'
  ) <> 1 THEN
    RAISE EXCEPTION 'Actor RLS composition repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- The historical standalone and embedded v123 paths installed different
-- policy compositions. Converge both without changing the predicates: tenant
-- visibility is the permissive entry point, and exact actor scope is an
-- additional restrictive boundary. PostgreSQL therefore requires both.
DO $migration$
DECLARE
  table_name TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'omni_a2a_peer_rollouts',
    'omni_a2a_task_mappings',
    'omni_a2a_exchanges',
    'omni_a2a_safety_reservations',
    'omni_a2a_tool_call_claims',
    'omni_trash_items',
    'omni_trash_effect_receipts',
    'omni_approval_grants',
    'omni_approval_grant_claims',
    'omni_browser_profiles',
    'omni_browser_profile_bindings',
    'omni_browser_takeovers'
  ];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'Actor-owned RLS table % is missing', table_name
        USING ERRCODE = '55000';
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS omni_tenant_isolation ON public.%I',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      table_name || '_actor', table_name
    );
    EXECUTE format(
      'CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(expected_tables)
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(expected_tables)
      AND policy.polname = relation.relname || '_actor'
      AND NOT policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[0::OID]
      AND pg_get_expr(policy.polqual, policy.polrelid) =
        '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'
      AND pg_get_expr(policy.polwithcheck, policy.polrelid) =
        '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'
  ) <> cardinality(expected_tables) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(expected_tables)
      AND policy.polname = 'omni_tenant_isolation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[0::OID]
      AND pg_get_expr(policy.polqual, policy.polrelid) =
        'omni_tenant_visible(tenant_id)'
      AND pg_get_expr(policy.polwithcheck, policy.polrelid) =
        'omni_tenant_visible(tenant_id)'
  ) <> cardinality(expected_tables) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(expected_tables)
  ) <> 2 * cardinality(expected_tables) THEN
    RAISE EXCEPTION 'Actor-owned RLS policy composition is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  183,
  'actor_rls_policy_composition_repair_v1',
  '06e06bfc319278f8e676d14c30bfc34f60cdda305ff48b0c4f4944a01e53ba97',
  clock_timestamp()
);

COMMIT;
