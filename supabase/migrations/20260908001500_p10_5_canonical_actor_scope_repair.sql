BEGIN;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM omni_schema_version
    WHERE version = 132
      AND name = 'workspace_templates_v1'
      AND checksum = 'f750197534c0c4854c424130fe566c34c431481bbe561526361067baaaeb0643'
  ) THEN
    RAISE EXCEPTION 'Migration 132 must be installed before canonical actor scope repair'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM omni_schema_version WHERE version = 133) THEN
    RAISE EXCEPTION 'Migration 133 is already recorded'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION omni_actor_scope_v1_allows_canonical(
  candidate_tenant_id TEXT,
  candidate_canonical_actor_id TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH actor_scope AS (
    SELECT public.omni_current_actor_scope_v1() AS scope
  )
  SELECT COALESCE(
    actor_scope.scope ->> 'tenantId' = candidate_tenant_id
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        actor_scope.scope -> 'actorIds'
      ) AS scoped(actor_identifier)
      JOIN public.omni_auth_user_actor_identifiers identifier
        ON identifier.actor_identifier = scoped.actor_identifier
        OR identifier.canonical_actor_id = scoped.actor_identifier
      JOIN public.omni_auth_users auth_user
        ON auth_user.actor_id = identifier.canonical_actor_id
      JOIN public.omni_auth_memberships membership
        ON membership.user_id = auth_user.id
       AND membership.tenant_id = candidate_tenant_id
      WHERE identifier.canonical_actor_id = candidate_canonical_actor_id
        AND auth_user.status = 'active'
        AND membership.status = 'active'
    ),
    FALSE
  )
  FROM actor_scope
$function$;

REVOKE ALL ON FUNCTION omni_actor_scope_v1_allows_canonical(TEXT, TEXT)
  FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_actor_scope_v1_allows_canonical(TEXT, TEXT)
      TO omni_runtime;
  END IF;
END
$migration$;

DO $migration$
DECLARE
  function_definition TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'omni_actor_scope_v1_allows_canonical(TEXT, TEXT)'::regprocedure
  ) INTO STRICT function_definition;
  IF function_definition NOT LIKE '%omni_current_actor_scope_v1()%'
    OR function_definition NOT LIKE '%identifier.actor_identifier = scoped.actor_identifier%'
    OR function_definition NOT LIKE '%identifier.canonical_actor_id = scoped.actor_identifier%'
  THEN
    RAISE EXCEPTION 'Canonical actor scope repair is incomplete'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND NOT has_function_privilege(
      'omni_runtime',
      'omni_actor_scope_v1_allows_canonical(TEXT, TEXT)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Runtime canonical actor scope grant is missing'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  133,
  'canonical_actor_scope_repair_v1',
  'f700debf165e44134b59e46fdfc258a4fb9e51a7158adfb26760c77acff45678',
  clock_timestamp()
);

COMMIT;
