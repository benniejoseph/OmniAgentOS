BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 130
      AND name = 'workspace_shared_memory_v1'
      AND checksum = 'ef0d0f512b05dc2ca01585b1f939137dd626d9d20cdc9242b46f07110875e63e'
  ) <> 1 THEN
    RAISE EXCEPTION 'Canonical Workspace resolver repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION omni_ensure_personal_workspace_v1(
  candidate_tenant_id TEXT,
  candidate_actor_identifier TEXT
)
RETURNS TABLE (workspace_id TEXT, owner_actor_id TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  canonical_actor_id TEXT;
  personal_workspace_id TEXT;
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF candidate_tenant_id IS DISTINCT FROM
      NULLIF(current_setting('omni.tenant_id', TRUE), '')
    OR NOT public.omni_actor_scope_v1_allows(
      candidate_tenant_id, candidate_actor_identifier
    )
  THEN
    RAISE EXCEPTION 'Personal Workspace request is outside actor scope'
      USING ERRCODE = '42501';
  END IF;
  SELECT identifier.canonical_actor_id
  INTO STRICT canonical_actor_id
  FROM public.omni_auth_user_actor_identifiers identifier
  JOIN public.omni_auth_users auth_user
    ON auth_user.actor_id = identifier.canonical_actor_id
  JOIN public.omni_auth_memberships membership
    ON membership.user_id = auth_user.id
  WHERE identifier.actor_identifier = candidate_actor_identifier
    AND membership.tenant_id = candidate_tenant_id
    AND auth_user.status = 'active'
    AND membership.status = 'active';
  personal_workspace_id := 'workspace:personal:' ||
    substring(canonical_actor_id FROM 7);

  INSERT INTO public.omni_tenant_workspaces (
    schema_version, tenant_id, workspace_id, display_name, owner_actor_id,
    state, lifecycle_revision, created_by_actor_id,
    activated_by_actor_id, created_at, activated_at, updated_at
  ) VALUES (
    1, candidate_tenant_id, personal_workspace_id, 'Personal workspace',
    canonical_actor_id, 'active', 1, canonical_actor_id,
    canonical_actor_id, now_at, now_at, now_at
  ) ON CONFLICT ON CONSTRAINT omni_tenant_workspaces_pkey DO NOTHING;

  INSERT INTO public.omni_tenant_workspace_memberships (
    schema_version, tenant_id, workspace_id, subject_kind, subject_key,
    subject_actor_id, subject_execution_principal_id,
    subject_execution_principal_generation, membership_generation,
    access_level, state, lifecycle_revision, created_by_actor_id,
    activated_by_actor_id, created_at, activated_at, updated_at
  ) VALUES (
    1, candidate_tenant_id, personal_workspace_id, 'user',
    canonical_actor_id, canonical_actor_id, NULL, NULL, 1, 'manager',
    'active', 1, canonical_actor_id, canonical_actor_id,
    now_at, now_at, now_at
  ) ON CONFLICT ON CONSTRAINT omni_workspace_memberships_pkey DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.omni_tenant_workspaces workspace
    JOIN public.omni_tenant_workspace_memberships membership
      ON membership.tenant_id = workspace.tenant_id
      AND membership.workspace_id = workspace.workspace_id
    WHERE workspace.tenant_id = candidate_tenant_id
      AND workspace.workspace_id = personal_workspace_id
      AND workspace.owner_actor_id = canonical_actor_id
      AND workspace.state = 'active'
      AND membership.subject_kind = 'user'
      AND membership.subject_actor_id = canonical_actor_id
      AND membership.access_level = 'manager'
      AND membership.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Personal Workspace authority is unavailable'
      USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT personal_workspace_id, canonical_actor_id;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
  RAISE EXCEPTION 'Actor does not resolve to one active tenant member'
    USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION omni_ensure_personal_workspace_v1(TEXT, TEXT)
  FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_ensure_personal_workspace_v1(TEXT, TEXT)
      TO omni_runtime;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF to_regprocedure(
      'public.omni_ensure_personal_workspace_v1(text,text)'
    ) IS NULL
    OR pg_get_functiondef(
      'public.omni_ensure_personal_workspace_v1(text,text)'::regprocedure
    ) NOT LIKE '%ON CONFLICT ON CONSTRAINT omni_tenant_workspaces_pkey%'
    OR pg_get_functiondef(
      'public.omni_ensure_personal_workspace_v1(text,text)'::regprocedure
    ) NOT LIKE '%ON CONFLICT ON CONSTRAINT omni_workspace_memberships_pkey%'
  THEN
    RAISE EXCEPTION 'Canonical Workspace resolver repair is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime')
    AND NOT has_function_privilege(
      'omni_runtime',
      'public.omni_ensure_personal_workspace_v1(text,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Canonical Workspace resolver runtime grant is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  131,
  'canonical_workspace_resolver_repair_v1',
  '6975f3e4024004198a867620cb5fde2415e031c3b76b9d8e0c7bde24c29998af',
  NOW()
);

COMMIT;
