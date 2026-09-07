BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 122
      AND name = 'browser_takeover_profiles_v1'
      AND checksum = 'ee32a9191756e79b13799f8e5bbf0768a962f7501194c222bb481ef9fa2e47d4'
  ) <> 1 THEN
    RAISE EXCEPTION 'Actor RLS policy repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Restrictive policies are ANDed with permissive policies. These actor-owned
-- tables had only a restrictive policy, so PostgreSQL denied every row. Give
-- each table exactly one permissive policy with the same tenant+actor check.
DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
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
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_actor', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

DO $migration$
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
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
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
      AND policy.polname = relation.relname || '_actor'
      AND policy.polpermissive
      AND policy.polcmd = '*'
  ) <> cardinality(expected_tables) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
  ) <> cardinality(expected_tables) THEN
    RAISE EXCEPTION 'Actor-owned RLS policy boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  123,
  'actor_rls_policy_repair_v1',
  'd5dfb0fb60b28c8d8c317ae8c13d9e9000cfa408ae2124dd7d62e7af538bebcd',
  NOW()
);

COMMIT;
