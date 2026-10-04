BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 229 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=229 AND name='agent_skill_native_mutations_v1'
      AND checksum='106e8e32db24965cc85c0fba5dbe338875f9b3eb4da5a5373712ceeba0c0322d'
  )<>1 THEN RAISE EXCEPTION 'Native recording predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

CREATE TABLE public.omni_meeting_recording_processing_acceptances (
  id TEXT PRIMARY KEY CHECK(id ~ '^meeting-recording-acceptance:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL, canonical_actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, recording_id TEXT NOT NULL REFERENCES public.omni_capture_recordings(id) ON DELETE CASCADE,
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  operation_job_id TEXT NOT NULL,
  intent JSONB NOT NULL, acceptance JSONB NOT NULL, source_manifest JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  UNIQUE(tenant_id,owner_actor_id,recording_id),
  CHECK(COALESCE(jsonb_typeof(intent)='object' AND pg_column_size(intent)<=65536
    AND intent->>'contract'='asael-meeting-recording-intent:1'
    AND intent->'scope'->>'tenantId'=tenant_id AND intent->'scope'->>'ownerActorId'=owner_actor_id
    AND intent->'scope'->>'canonicalActorId'=canonical_actor_id AND intent->'scope'->>'workspaceId'=workspace_id
    AND intent->'scope'->>'meetingId'=meeting_id AND intent->'scope'->>'recordingId'=recording_id
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->'request'->>'contract'='asael-meeting-recording-process:1'
    AND intent->'request'->>'meetingId'=meeting_id AND intent->'request'->>'workspaceId'=workspace_id
    AND intent->'request'->'rawAudioRetention'='{"mode":"retain"}'::JSONB,FALSE)),
  CHECK(COALESCE(jsonb_typeof(acceptance)='object' AND pg_column_size(acceptance)<=16384
    AND acceptance->>'contract'='asael-meeting-recording-acceptance:1' AND acceptance->>'id'=id
    AND acceptance->'scope'=intent->'scope' AND acceptance->>'keySha256'=idempotency_key_sha256
    AND acceptance->>'requestSha256'=request_sha256 AND acceptance->>'operationJobId'=operation_job_id
    AND acceptance->>'reviewSha256'=intent->'request'->'review'->>'reviewSha256'
    AND acceptance->>'sourceAudioManifestSha256'=intent->'request'->'review'->>'sourceAudioManifestSha256'
    AND acceptance->>'acceptanceSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(acceptance->'acceptedAt')='string'
    AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at,FALSE)),
  CHECK(jsonb_typeof(source_manifest)='object' AND pg_column_size(source_manifest)<=1048576)
);
CREATE TABLE public.omni_meeting_recording_processing_effects (
  acceptance_id TEXT NOT NULL REFERENCES public.omni_meeting_recording_processing_acceptances(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('extract','knowledge') OR stage ~ '^segment:[A-Za-z0-9._:@/+~-]{1,200}$'),
  job_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('started','committed','unconfirmed','blocked')),
  checkpoint JSONB, started_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(acceptance_id,stage),
  CHECK((state='committed')=(checkpoint IS NOT NULL)),
  CHECK(checkpoint IS NULL OR (jsonb_typeof(checkpoint)='object' AND pg_column_size(checkpoint)<=16384)),
  CHECK(updated_at>=started_at)
);
CREATE FUNCTION public.omni_protect_native_recording_acceptance_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Native recording receipts cannot be truncated' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.omni_capture_recordings WHERE id=OLD.recording_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Native recording acceptance is immutable' USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER omni_native_recording_acceptance_immutable BEFORE UPDATE OR DELETE ON public.omni_meeting_recording_processing_acceptances
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_recording_acceptance_v1();
CREATE TRIGGER omni_native_recording_acceptance_no_truncate BEFORE TRUNCATE ON public.omni_meeting_recording_processing_acceptances
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_recording_acceptance_v1();
CREATE FUNCTION public.omni_protect_native_recording_effect_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Native recording effects cannot be truncated' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM public.omni_meeting_recording_processing_acceptances WHERE id=OLD.acceptance_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Native recording effect cannot be removed' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'started' OR NEW.checkpoint IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM public.omni_meeting_recording_processing_acceptances parent WHERE parent.id=NEW.acceptance_id
        AND parent.tenant_id=NEW.tenant_id AND parent.owner_actor_id=NEW.owner_actor_id
    ) THEN RAISE EXCEPTION 'Native recording effect parent is invalid' USING ERRCODE='23514'; END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['state','checkpoint','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','checkpoint','updated_at'])
    OR OLD.state<>'started' OR NEW.state NOT IN ('committed','unconfirmed','blocked') OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Native recording effect transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_recording_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_meeting_recording_processing_effects
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_recording_effect_v1();
CREATE TRIGGER omni_native_recording_effect_no_truncate BEFORE TRUNCATE ON public.omni_meeting_recording_processing_effects
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_recording_effect_v1();
DO $policies$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_meeting_recording_processing_acceptances','omni_meeting_recording_processing_effects'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id))',table_name);
    EXECUTE format('CREATE POLICY omni_native_recording_actor ON public.%I AS RESTRICTIVE FOR ALL USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id)) WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
  END LOOP;
END
$policies$;
CREATE POLICY omni_native_recording_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'meeting.recording.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'meeting.recording.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON FUNCTION public.omni_protect_native_recording_acceptance_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_native_recording_effect_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_meeting_recording_processing_acceptances,public.omni_meeting_recording_processing_effects TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,checkpoint,updated_at) ON public.omni_meeting_recording_processing_effects TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_meeting_recording_processing_acceptances,public.omni_meeting_recording_processing_effects TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(230,'meeting_recording_native_processing_v1','c372f6d625795a7b8c0b11b449ef2babc80e877389e66207576a684b45dbd468',clock_timestamp());
COMMIT;
