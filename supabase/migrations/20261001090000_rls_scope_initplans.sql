BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 210 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 210
      AND name = 'oauth_sync_backoff_v1'
      AND checksum = '3c2122c7222e4a5aafca6e5ef3eca7905353be7aae675367a16b9cdb4787fff3'
  ) <> 1 THEN
    RAISE EXCEPTION 'Row security scope initplan predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Row security policies called their scope helpers once for every row they
-- checked. omni_system_scope_enabled() and the parsers of the actor and
-- memory access scopes cannot be inlined, so a scan paid for a function call,
-- catalog lookups and a JSON parse per row, and the policies reached the
-- parsers again through omni_actor_scope_v1_allows() and
-- omni_user_private_memory_scope_v1_allows().
--
-- A helper that takes no row argument has one value for the whole query, and
-- as a scalar subquery it runs once, as an initplan. Each policy now calls
-- the helpers that way, and reaches the two row checks through their
-- _validated forms, which take the scope the initplan read. The rewrite reads
-- the text PostgreSQL renders and writes back the form it renders, so running
-- it again changes nothing, and it alters only the clauses it changes.
--
-- omni_tenant_memory_data_right_requests keeps its policies: its writer
-- refuses to write unless they read exactly as created, and only system
-- scope sees its rows.
DO $initplans$
DECLARE
  changed RECORD;
BEGIN
  FOR changed IN
    WITH clauses AS (
      SELECT
        relation.relname AS table_name,
        policy.polname AS policy_name,
        clause.keyword,
        clause.expression,
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                clause.expression,
                '\( SELECT (omni_system_scope_enabled|omni_current_actor_scope_v1|omni_current_memory_access_scope_v1)\(\) AS \1\)',
                '\1()',
                'g'
              ),
              '\momni_actor_scope_v1_allows\(',
              'omni_actor_scope_v1_allows_validated(omni_current_actor_scope_v1(), ',
              'g'
            ),
            '\momni_user_private_memory_scope_v1_allows\(',
            'omni_user_private_memory_scope_v1_allows_validated(omni_current_memory_access_scope_v1(), ',
            'g'
          ),
          '\m(omni_system_scope_enabled|omni_current_actor_scope_v1|omni_current_memory_access_scope_v1)\(\)',
          '( SELECT \1() AS \1)',
          'g'
        ) AS rewritten
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL (
        VALUES
          ('USING', pg_get_expr(policy.polqual, policy.polrelid)),
          ('WITH CHECK', pg_get_expr(policy.polwithcheck, policy.polrelid))
      ) AS clause(keyword, expression)
      WHERE namespace.nspname = 'public'
        AND relation.relname <> 'omni_tenant_memory_data_right_requests'
        AND clause.expression IS NOT NULL
    )
    SELECT
      table_name,
      policy_name,
      string_agg(
        format('%s (%s)', keyword, rewritten),
        ' '
        ORDER BY keyword COLLATE "C"
      ) AS clauses
    FROM clauses
    WHERE rewritten <> expression
    GROUP BY table_name, policy_name
    ORDER BY table_name COLLATE "C", policy_name COLLATE "C"
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON public.%I %s',
      changed.policy_name,
      changed.table_name,
      changed.clauses
    );
  END LOOP;
END
$initplans$;

-- omni_tenant_visible() is inlined into the policies that call it, but its
-- call of omni_system_scope_enabled() is not, so each row it checked paid for
-- one. That function is false unless omni.system_scope is 'true', and now the
-- setting is read first, so a query under a tenant scope makes no such call.
-- The calls are schema-qualified because an inlined body is resolved on the
-- caller's search_path.
CREATE OR REPLACE FUNCTION public.omni_tenant_visible(row_tenant TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $function$
  SELECT (
      COALESCE(pg_catalog.current_setting('omni.system_scope', TRUE), '') = 'true'
      AND public.omni_system_scope_enabled()
    )
    OR (
      public.omni_current_tenant() IS NOT NULL
      AND row_tenant IS NOT NULL
      AND row_tenant = public.omni_current_tenant()
    )
$function$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  211,
  'rls_scope_initplans_v1',
  '84d660e88fc6bcdaf9bac76939d03ad470e2fe6fee615d52be55a16dda6a88e1',
  clock_timestamp()
);

COMMIT;
