BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 249 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 249 AND name = 'android_local_control_v1'
      AND checksum = '0078bbaccb6ea94da05a158220ddcca027e83cca776bbfd1375732362c7bd168'
  ) <> 1 THEN RAISE EXCEPTION 'Listen predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$predecessor$;

-- A confirmed silent Listen segment is a completed checkpoint, not an ASR
-- failure to retry. Existing capture/native producers still require speech.
ALTER TABLE public.omni_capture_segments
  DROP CONSTRAINT omni_capture_segments_media_transcript_check,
  ADD CONSTRAINT omni_capture_segments_media_transcript_check CHECK (
    (media_transcript IS NULL) = (media_transcript_sha256 IS NULL)
    AND (media_transcript IS NULL) = (detected_language_tags IS NULL)
    AND (media_transcript IS NULL) = (media_transcribed_at IS NULL)
    AND (media_transcript IS NULL OR (
      media_transcript_sha256 ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(media_transcript) = 'object'
      AND jsonb_typeof(media_transcript -> 'turns') = 'array'
      AND CASE WHEN media_transcript -> 'noSpeech' = 'true'::jsonb THEN
        cardinality(detected_language_tags) = 0
        AND media_transcript -> 'turns' = '[]'::jsonb
        AND media_transcript -> 'languageTags' = '[]'::jsonb
      ELSE cardinality(detected_language_tags) BETWEEN 1 AND 24 END
    ))
  );
CREATE FUNCTION public.omni_listen_no_speech_checkpoint_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public AS $function$
BEGIN
  IF NEW.media_transcript -> 'noSpeech' = 'true'::jsonb AND NOT EXISTS (
    SELECT 1 FROM public.omni_capture_recordings recording
    WHERE recording.id = NEW.recording_id AND recording.tenant_id = NEW.tenant_id
      AND recording.actor_id = NEW.actor_id AND recording.metadata -> 'listen' = 'true'::jsonb
      AND recording.metadata ->> 'processingTerms' = 'listen-processing:1'
  ) THEN
    RAISE EXCEPTION 'No-speech checkpoints require authorized Listen processing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_listen_no_speech_checkpoint_v1() FROM PUBLIC;
CREATE TRIGGER omni_listen_no_speech_checkpoint
BEFORE INSERT OR UPDATE OF media_transcript ON public.omni_capture_segments
FOR EACH ROW EXECUTE FUNCTION public.omni_listen_no_speech_checkpoint_v1();

CREATE TABLE public.omni_listen_grants (
  id TEXT PRIMARY KEY CHECK (id ~ '^listen-grant:[0-9a-f-]{36}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, user_id TEXT NOT NULL,
  mobile_session_id TEXT NOT NULL, device_id TEXT NOT NULL, actor_role TEXT NOT NULL,
  api_origin TEXT NOT NULL CHECK (char_length(api_origin) BETWEEN 8 AND 500),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  time_zone TEXT NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 80),
  processing_terms TEXT NOT NULL CHECK (processing_terms = 'listen-processing:1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '31 days'),
  CHECK (actor_role IN ('operator', 'admin')),
  FOREIGN KEY (mobile_session_id) REFERENCES public.omni_mobile_sessions(id) ON DELETE CASCADE
);
CREATE INDEX omni_listen_grants_device ON public.omni_listen_grants (tenant_id, actor_id, device_id, api_origin) WHERE revoked_at IS NULL;

-- A deleted phone source remains remembered without retaining its audio or transcript.
-- Repeated folder scans cannot resurrect a recording the owner deleted.
CREATE TABLE public.omni_listen_sources (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  source_key_sha256 TEXT NOT NULL CHECK (source_key_sha256 ~ '^[a-f0-9]{64}$'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('listen', 'call')),
  start_payload JSONB NOT NULL CHECK (jsonb_typeof(start_payload) = 'object' AND pg_column_size(start_payload) <= 8192),
  recording_id TEXT CHECK (recording_id ~ '^capture_recording_[a-f0-9]{48}$'),
  client_context_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (client_context_status IN ('not_requested', 'pending', 'linked', 'needs_attention')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), tombstoned_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, actor_id, source_key_sha256)
);
CREATE UNIQUE INDEX omni_listen_sources_recording ON public.omni_listen_sources (tenant_id, actor_id, recording_id) WHERE recording_id IS NOT NULL;
CREATE FUNCTION public.omni_listen_recording_deleted_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public AS $function$
BEGIN
  IF OLD.metadata ->> 'listen' = 'true' THEN
    UPDATE public.omni_listen_sources SET tombstoned_at = COALESCE(tombstoned_at, clock_timestamp()), start_payload = '{}'::jsonb
    WHERE tenant_id = OLD.tenant_id AND actor_id = OLD.actor_id
      AND (recording_id = OLD.id OR source_key_sha256 = OLD.metadata ->> 'listenSourceKeySha256');
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER omni_listen_recording_deleted AFTER DELETE ON public.omni_capture_recordings
FOR EACH ROW EXECUTE FUNCTION public.omni_listen_recording_deleted_v1();
REVOKE ALL ON FUNCTION public.omni_listen_recording_deleted_v1() FROM PUBLIC;

ALTER TABLE public.omni_listen_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_listen_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_listen_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_listen_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_listen_grants AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_listen_grants_actor ON public.omni_listen_grants AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));
CREATE POLICY omni_tenant_isolation ON public.omni_listen_sources AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_listen_sources_actor ON public.omni_listen_sources AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));
REVOKE ALL ON public.omni_listen_grants, public.omni_listen_sources FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime', 'omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.omni_listen_grants, public.omni_listen_sources TO %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_listen_grants, public.omni_listen_sources TO omni_backup;
  END IF;
END
$grants$;
-- Source deletion/replacement also retires canonical private Listen memories and their derived graph/traces.
CREATE FUNCTION
  public.omni_retire_listen_memories_v1(
    requested_tenant_id TEXT,
    requested_source_owner_actor_id TEXT,
    requested_document_ids TEXT[],
    requested_retired_at TIMESTAMPTZ
  )
RETURNS TABLE(
  retired_memory_ids TEXT[],
  retrieval_trace_ids TEXT[],
  canonical_owner_actor_id TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  resolved_canonical_actor_id TEXT;
  target_memory_ids TEXT[] := '{}'::TEXT[];
  updated_memory_ids TEXT[] := '{}'::TEXT[];
  affected_trace_ids TEXT[] := '{}'::TEXT[];
BEGIN
  IF requested_tenant_id IS NULL
    OR requested_source_owner_actor_id IS NULL
    OR requested_retired_at IS NULL
    OR requested_document_ids IS NULL
    OR cardinality(requested_document_ids) < 1
    OR cardinality(requested_document_ids) > 5000
    OR EXISTS (
      SELECT 1
      FROM unnest(requested_document_ids) requested(document_id)
      WHERE document_id IS NULL
        OR NOT public.omni_source_contract_id_is_valid(document_id)
    )
    OR (
      SELECT COUNT(DISTINCT document_id)
      FROM unnest(requested_document_ids) requested(document_id)
    ) <> cardinality(requested_document_ids)
  THEN
    RAISE EXCEPTION 'Listen source lifecycle input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(current_setting('omni.tenant_id', TRUE), '')
      IS DISTINCT FROM requested_tenant_id
    OR public.omni_current_memory_access_scope_v1() IS NOT NULL
    OR NOT (
      public.omni_actor_scope_v1_allows(
        requested_tenant_id, requested_source_owner_actor_id
      )
      OR public.omni_actor_scope_v1_allows_canonical(
        requested_tenant_id, requested_source_owner_actor_id
      )
    )
  THEN
    RAISE EXCEPTION 'Listen source lifecycle scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT identifier.canonical_actor_id
  INTO resolved_canonical_actor_id
  FROM public.omni_auth_user_actor_identifiers identifier
  JOIN public.omni_auth_users auth_user
    ON auth_user.actor_id = identifier.canonical_actor_id
   AND auth_user.status = 'active'
  JOIN public.omni_auth_memberships membership
    ON membership.user_id = auth_user.id
   AND membership.tenant_id = requested_tenant_id
   AND membership.status = 'active'
  WHERE identifier.actor_identifier = requested_source_owner_actor_id;
  IF resolved_canonical_actor_id IS NULL THEN
    RAISE EXCEPTION 'Listen source lifecycle owner is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    ARRAY_AGG(DISTINCT memory.id ORDER BY memory.id),
    '{}'::TEXT[]
  )
  INTO target_memory_ids
  FROM public.omni_listen_sources listen_source
  JOIN public.omni_knowledge_documents document
    ON document.tenant_id = listen_source.tenant_id
   AND document.source = 'capture:recording:' || listen_source.recording_id
  JOIN public.omni_source_revisions revision
    ON revision.tenant_id = document.tenant_id
   AND revision.id = document.source_revision_id
   AND revision.source_item_id = document.source_item_id
   AND revision.owner_actor_id = requested_source_owner_actor_id
  JOIN public.omni_source_items item
    ON item.tenant_id = revision.tenant_id
   AND item.id = revision.source_item_id
   AND item.owner_actor_id = requested_source_owner_actor_id
  LEFT JOIN public.omni_capture_recordings recording
    ON recording.tenant_id = listen_source.tenant_id
   AND recording.actor_id = listen_source.actor_id
   AND recording.id = listen_source.recording_id
  JOIN public.omni_memories memory
    ON memory.tenant_id = listen_source.tenant_id
   AND memory.owner_actor_id = resolved_canonical_actor_id
   AND memory.source = document.source
  WHERE listen_source.tenant_id = requested_tenant_id
    AND listen_source.actor_id = requested_source_owner_actor_id
    AND document.id = ANY(requested_document_ids)
    AND (listen_source.tombstoned_at IS NOT NULL OR (
      recording.metadata ->> 'listen' = 'true'
      AND recording.metadata ->> 'listenCanonicalActorId' = resolved_canonical_actor_id
      AND recording.metadata ->> 'processingTerms' = 'listen-processing:1'
    ))
    AND memory.access_contract_version = 1
    AND memory.access_state = 'scope_bound'
    AND memory.visibility = 'user_private'
    AND memory.origin_purpose = 'capture.conversation.remember'
    AND memory.id ~ '^conversation-memory:[a-f0-9]{64}$'
    AND ('knowledge:' || document.id) = ANY(memory.evidence_refs)
    AND memory.claim_status <> 'forgotten';

  IF cardinality(target_memory_ids) = 0 THEN
    RETURN QUERY SELECT
      '{}'::TEXT[], '{}'::TEXT[], resolved_canonical_actor_id;
    RETURN;
  END IF;

  WITH updated AS (
    UPDATE public.omni_memories memory
    SET title = '[retired]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[retired]',
        embedding = NULL,
        embedding_vector = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        claim_status = 'superseded',
        valid_to = COALESCE(memory.valid_to, requested_retired_at),
        forgotten_at = NULL,
        updated_at = requested_retired_at
    WHERE memory.tenant_id = requested_tenant_id
      AND memory.id = ANY(target_memory_ids)
      AND memory.claim_status <> 'forgotten'
      AND NOT public.omni_memory_ids_have_deletion_barrier(
        memory.tenant_id, ARRAY[memory.id]
      )
    RETURNING memory.id
  )
  SELECT COALESCE(
    ARRAY_AGG(updated.id ORDER BY updated.id),
    '{}'::TEXT[]
  ) INTO updated_memory_ids
  FROM updated;

  SELECT COALESCE(
    ARRAY_AGG(trace.id ORDER BY trace.id),
    '{}'::TEXT[]
  )
  INTO affected_trace_ids
  FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = requested_tenant_id
    AND trace.memory_ids && updated_memory_ids;

  DELETE FROM public.omni_memory_graph_edges edge
  WHERE edge.tenant_id = requested_tenant_id
    AND (
      edge.memory_ids && updated_memory_ids
      OR EXISTS (
        SELECT 1
        FROM public.omni_memory_graph_nodes endpoint
        WHERE endpoint.tenant_id = edge.tenant_id
          AND endpoint.id IN (edge.source_node_id, edge.target_node_id)
          AND endpoint.memory_ids && updated_memory_ids
      )
    );
  DELETE FROM public.omni_memory_graph_nodes node
  WHERE node.tenant_id = requested_tenant_id
    AND node.memory_ids && updated_memory_ids;
  DELETE FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = requested_tenant_id
    AND trace.id = ANY(affected_trace_ids);
  INSERT INTO public.omni_memory_graph_rebuild_queue AS rebuild (
    tenant_id, requested_at, attempts, last_error, updated_at, generation
  ) VALUES (
    requested_tenant_id, NOW(), 0, NULL, NOW(), 1
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    requested_at = NOW(), attempts = 0, last_error = NULL,
    updated_at = NOW(), generation = rebuild.generation + 1;

  RETURN QUERY SELECT
    updated_memory_ids,
    affected_trace_ids,
    resolved_canonical_actor_id;
END
$function$;

REVOKE ALL ON FUNCTION public.omni_retire_listen_memories_v1(TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM PUBLIC;
DO $listen_retirement_grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime', 'omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_retire_listen_memories_v1(TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO %I', role_name);
    END IF;
  END LOOP;
END
$listen_retirement_grants$;

INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (250, 'listen_capture_v1', '7bafada2e72418b3cdee84df711e76b42107025f1198322cc5cfa6fdd5c832dc', clock_timestamp());
COMMIT;
