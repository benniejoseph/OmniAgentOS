BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 246 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 246
      AND name = 'research_workflow_notifications_v1'
      AND checksum = '9399238975ab8f6af3d0df6f56d6432bbbcd67110385d77ddff4f7cdd6960873'
  ) <> 1 THEN
    RAISE EXCEPTION 'Thread workflow reference predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- Agent turns keep their existing run_id foreign key. Durable workflow turns
-- use an independent nullable reference; the workflow: marker is a UI projection.
ALTER TABLE public.omni_workflow_runs
  ADD CONSTRAINT omni_workflow_runs_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.omni_thread_turns
  ADD COLUMN workflow_run_id TEXT;

ALTER TABLE public.omni_thread_turns
  ADD CONSTRAINT omni_thread_turns_workflow_run_fk
  FOREIGN KEY (tenant_id, workflow_run_id)
  REFERENCES public.omni_workflow_runs (tenant_id, id)
  ON UPDATE RESTRICT
  ON DELETE SET NULL (workflow_run_id)
  NOT VALID;

ALTER TABLE public.omni_thread_turns
  ADD CONSTRAINT omni_thread_turns_single_run_reference_check
  CHECK (run_id IS NULL OR workflow_run_id IS NULL)
  NOT VALID;

ALTER TABLE public.omni_thread_turns
  VALIDATE CONSTRAINT omni_thread_turns_workflow_run_fk;
ALTER TABLE public.omni_thread_turns
  VALIDATE CONSTRAINT omni_thread_turns_single_run_reference_check;

-- Retention can delete a workflow without losing its conversation or nulling
-- the turn's tenant. Existing binaries may continue writing agent-only turns.
CREATE INDEX omni_thread_turns_workflow_run_idx
  ON public.omni_thread_turns (tenant_id, workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

-- Durable delivery starts with its saved initiating actor. Resolve only that
-- scoped user's canonical coordinate, preserving the private alias registry.
CREATE FUNCTION public.omni_thread_workflow_canonical_actor_v1(
  candidate_tenant_id TEXT, candidate_actor_identifier TEXT
)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT DISTINCT identifier.canonical_actor_id
  FROM public.omni_auth_user_actor_identifiers identifier
  JOIN public.omni_auth_users auth_user
    ON auth_user.actor_id = identifier.canonical_actor_id
  JOIN public.omni_auth_memberships membership
    ON membership.user_id = auth_user.id
   AND membership.tenant_id = candidate_tenant_id
  WHERE candidate_tenant_id = public.omni_current_tenant()
    AND NOT COALESCE(public.omni_system_scope_enabled(), FALSE)
    AND (
      identifier.actor_identifier COLLATE "C" = candidate_actor_identifier COLLATE "C"
      OR identifier.canonical_actor_id COLLATE "C" = candidate_actor_identifier COLLATE "C"
    )
    AND auth_user.status = 'active'
    AND membership.status = 'active'
    AND public.omni_actor_scope_v1_allows_canonical(
      candidate_tenant_id, identifier.canonical_actor_id
    )
$function$;

REVOKE ALL ON FUNCTION public.omni_thread_workflow_canonical_actor_v1(TEXT, TEXT) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime', 'omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_thread_workflow_canonical_actor_v1(TEXT, TEXT) TO %I', role_name);
    END IF;
  END LOOP;
END
$grants$;

INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (247, 'thread_turn_workflow_run_binding_v1',
  'f4f1712090f74fbb0beab44c4014d4542ed15d6c651984f83f395e75c8507a4e', clock_timestamp());
COMMIT;
