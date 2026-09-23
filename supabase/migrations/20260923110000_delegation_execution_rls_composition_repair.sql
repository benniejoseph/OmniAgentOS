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

  IF latest_version IS DISTINCT FROM 201 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 201
      AND name = 'prompt_queue_runtime_v1'
      AND checksum = 'e9cd14ec6c526fbd0fbed097cbc8a535e92b60cfd6bae0785a0a0a6c3b584567'
  ) <> 1 THEN
    RAISE EXCEPTION 'Delegation execution RLS repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Repair the V2 delegation policy composition without weakening the actor
-- boundary. PostgreSQL combines permissive policies with OR and restrictive
-- policies with AND; a restrictive policy cannot admit rows by itself.
DO $migration$
DECLARE protected_table TEXT;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'omni_delegation_budget_ledgers',
    'omni_delegation_executions'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      protected_table
    );
    EXECUTE format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      protected_table
    );

    IF EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = format('public.%I', protected_table)::regclass
        AND polname = 'omni_tenant_isolation'
    ) THEN
      EXECUTE format(
        'ALTER POLICY omni_tenant_isolation ON public.%I TO PUBLIC ' ||
        'USING (public.omni_tenant_visible(tenant_id)) ' ||
        'WITH CHECK (public.omni_tenant_visible(tenant_id))',
        protected_table
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY omni_tenant_isolation ON public.%I ' ||
        'AS PERMISSIVE FOR ALL TO PUBLIC ' ||
        'USING (public.omni_tenant_visible(tenant_id)) ' ||
        'WITH CHECK (public.omni_tenant_visible(tenant_id))',
        protected_table
      );
    END IF;
  END LOOP;
END
$migration$;

DO $verify$
DECLARE protected_table TEXT;
DECLARE actor_policy TEXT;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'omni_delegation_budget_ledgers',
    'omni_delegation_executions'
  ] LOOP
    actor_policy := protected_table || '_actor';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_class
      WHERE oid = format('public.%I', protected_table)::regclass
        AND relrowsecurity
        AND relforcerowsecurity
    ) OR (
      SELECT count(*)
      FROM pg_policy
      WHERE polrelid = format('public.%I', protected_table)::regclass
    ) <> 2 OR NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = format('public.%I', protected_table)::regclass
        AND polname = 'omni_tenant_isolation'
        AND polpermissive
        AND polcmd = '*'
        AND polroles = ARRAY[0]::OID[]
        AND pg_get_expr(polqual, polrelid) =
          'omni_tenant_visible(tenant_id)'
        AND pg_get_expr(polwithcheck, polrelid) =
          'omni_tenant_visible(tenant_id)'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = format('public.%I', protected_table)::regclass
        AND polname = actor_policy
        AND NOT polpermissive
        AND polcmd = '*'
        AND polroles = ARRAY[0]::OID[]
        AND pg_get_expr(polqual, polrelid) =
          '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'
        AND pg_get_expr(polwithcheck, polrelid) =
          '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'
    ) THEN
      RAISE EXCEPTION 'Delegation execution RLS policy composition is invalid for %', protected_table
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  202,
  'delegation_execution_rls_composition_repair_v1',
  '3d6b28bd2fdb00cc57360506baea3ef120a4ae13e0050be57ba6d266310a3d63',
  clock_timestamp()
);

COMMIT;
