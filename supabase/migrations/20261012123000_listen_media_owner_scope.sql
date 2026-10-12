BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 250 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 250 AND name = 'listen_capture_v1'
      AND checksum = '7bafada2e72418b3cdee84df711e76b42107025f1198322cc5cfa6fdd5c832dc'
  ) <> 1 THEN
    RAISE EXCEPTION 'Listen media ownership predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- Capture and its durable jobs retain the exact accepted email owner. The
-- existing media policies admit only canonical actors, so Listen could close
-- an upload and enqueue its job but could not create the media head. Admit
-- only this accepted source, without changing other legacy Capture owners or
-- the canonical native-meeting domain.
--
-- This helper has no privileged table access. Its source reads retain the
-- caller's RLS; the existing closed identity helper alone checks the private
-- registry and locks the exact active alias/canonical membership. Phone grant
-- expiry/revocation prevents new uploads, not reading already accepted notes.
CREATE FUNCTION public.omni_listen_media_owner_v1(
  requested_tenant TEXT,
  requested_owner TEXT,
  requested_recording TEXT,
  require_management BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  accepted_canonical_actor TEXT;
BEGIN
  IF require_management IS NULL
    OR requested_tenant IS NULL
    OR requested_tenant IS DISTINCT FROM public.omni_current_tenant()
    OR requested_owner IS NULL
    OR requested_recording IS NULL
    OR NOT COALESCE(public.omni_actor_scope_v1_allows_validated(
      public.omni_current_actor_scope_v1(), requested_tenant, requested_owner
    ), FALSE)
  THEN RETURN FALSE; END IF;

  SELECT recording.metadata ->> 'listenCanonicalActorId'
  INTO accepted_canonical_actor
  FROM public.omni_capture_recordings recording
  JOIN public.omni_listen_sources source
    ON source.tenant_id = recording.tenant_id
    AND source.actor_id = recording.actor_id
    AND source.recording_id = recording.id
    AND source.source_key_sha256 = recording.metadata ->> 'listenSourceKeySha256'
    AND source.source_kind = recording.metadata ->> 'sourceKind'
  WHERE recording.tenant_id = requested_tenant
    AND recording.actor_id = requested_owner
    AND recording.id = requested_recording
    AND source.tombstoned_at IS NULL
    AND recording.metadata -> 'listen' = 'true'::jsonb
    AND recording.metadata ->> 'processingTerms' = 'listen-processing:1'
    AND recording.metadata -> 'sourceInstructionsTrusted' = 'false'::jsonb
    AND recording.metadata ->> 'listenCanonicalActorId' =
      'actor:' || (recording.metadata ->> 'listenAuthUserId')
    AND NOT EXISTS (
      SELECT 1 FROM public.omni_meeting_recording_processing_acceptances native
      WHERE native.tenant_id = recording.tenant_id
        AND native.owner_actor_id = recording.actor_id
        AND native.recording_id = recording.id
    );

  IF accepted_canonical_actor IS NULL THEN RETURN FALSE; END IF;
  RETURN COALESCE(public.omni_native_private_memory_owner_v1(
    requested_tenant, requested_owner, accepted_canonical_actor, require_management
  ), FALSE);
END
$function$;

REVOKE ALL ON FUNCTION public.omni_listen_media_owner_v1(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime', 'omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_listen_media_owner_v1(TEXT, TEXT, TEXT, BOOLEAN) TO %I', role_name);
    END IF;
  END LOOP;
END
$grants$;

-- Keep the permissive tenant gate, restrictive policy composition, forced
-- RLS, canonical owner branch, immutable revisions and existing grants.
ALTER POLICY omni_capture_media_heads_actor_scope ON public.omni_capture_media_heads
USING (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  OR public.omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, FALSE)
)
WITH CHECK (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  OR public.omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, TRUE)
);
ALTER POLICY omni_capture_media_revisions_actor_scope ON public.omni_capture_media_revisions
USING (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  OR public.omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, FALSE)
)
WITH CHECK (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  OR public.omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, TRUE)
);

DO $boundaries$
BEGIN
  IF (
    SELECT count(*) FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN ('omni_capture_media_heads', 'omni_capture_media_revisions')
      AND relation.relrowsecurity AND relation.relforcerowsecurity
      AND policy.polname = relation.relname || '_actor_scope'
      AND NOT policy.polpermissive AND policy.polcmd = '*'
      AND pg_get_expr(policy.polqual, policy.polrelid) LIKE '%omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, false)%'
      AND pg_get_expr(policy.polwithcheck, policy.polrelid) LIKE '%omni_listen_media_owner_v1(tenant_id, owner_actor_id, recording_id, true)%'
  ) <> 2 THEN
    RAISE EXCEPTION 'Listen media ownership must retain restrictive row security' USING ERRCODE = '55000';
  END IF;
END
$boundaries$;

-- Tombstoning/removing the recording makes this media path unreadable. The
-- v250 Memory retirement function intentionally uses the retained source map
-- and Knowledge lineage, so it still retires derived memory after deletion.
INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (251, 'listen_media_owner_scope_v1', 'ad82f1c2f762cc8a591293c6bcc33b498f8dadb70724e5bb2c0601c5a2ec9d83', clock_timestamp());
COMMIT;
