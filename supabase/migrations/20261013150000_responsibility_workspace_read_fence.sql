BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 253 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 253 AND name = 'agent_text_comparisons_v1'
      AND checksum = '81d516ebca9be6fcf0e2e9131a30d0eeb1dc0301ce52e8d5ab40902fd7beca50'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility workspace fence predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Serving code may SELECT workspace authority but must never UPDATE it.
-- PostgreSQL requires UPDATE even for FOR SHARE. This closed function only
-- locks the exact current actor's active workspace membership; locks survive
-- until the caller's transaction ends. It cannot provision or change authority.
CREATE FUNCTION public.omni_lock_responsibility_workspace_v1(
  candidate_tenant_id TEXT, candidate_actor_id TEXT, candidate_workspace_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE locked_workspace_id TEXT;
BEGIN
  IF candidate_tenant_id IS DISTINCT FROM NULLIF(current_setting('omni.tenant_id', TRUE), '')
    OR COALESCE(NULLIF(current_setting('omni.system_scope', TRUE), '')::BOOLEAN, FALSE)
    OR candidate_actor_id IS NULL
    OR candidate_actor_id !~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR NOT public.omni_actor_scope_v1_allows_canonical(candidate_tenant_id, candidate_actor_id)
  THEN RETURN FALSE; END IF;
  SELECT workspace.workspace_id INTO STRICT locked_workspace_id
    FROM public.omni_tenant_workspaces workspace
    JOIN public.omni_tenant_workspace_memberships membership
      ON membership.tenant_id = workspace.tenant_id AND membership.workspace_id = workspace.workspace_id
      AND membership.subject_kind = 'user' AND membership.subject_actor_id = candidate_actor_id AND membership.state = 'active'
    WHERE workspace.tenant_id = candidate_tenant_id AND workspace.workspace_id = candidate_workspace_id AND workspace.state = 'active'
    FOR SHARE OF workspace, membership;
  RETURN locked_workspace_id IS NOT NULL;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RETURN FALSE;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) TO omni_runtime;
  END IF;
END
$migration$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (254,'responsibility_workspace_read_fence_v1','ffb985978aa05cc4a703a8cd24b3c18ce35d042cf8ebe4e1fffe8a4d36402548',clock_timestamp());
COMMIT;
