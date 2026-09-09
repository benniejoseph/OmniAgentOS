BEGIN;

DO $guard$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 152 OR NOT EXISTS (
    SELECT 1 FROM public.omni_schema_version
    WHERE version = 152
      AND name = 'memory_graph_scope_v2'
      AND checksum = '80fb478914e814d44034b303b3bcf39e4f99c7f66f0240f114fe23e704ab29ae'
  ) THEN
    RAISE EXCEPTION 'configurable_ai_model_scopes_v1 requires exact predecessor 152';
  END IF;
END
$guard$;

ALTER TABLE public.omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check;
ALTER TABLE public.omni_model_assignments
  ADD CONSTRAINT omni_model_assignments_scope_check CHECK (
    scope IN (
      'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
      'memory', 'embeddings', 'vision', 'audio', 'audio_diarization',
      'web_search', 'image_generation', 'speech_synthesis',
      'realtime_transcription'
    )
  );

ALTER TABLE public.omni_ai_usage
  DROP CONSTRAINT IF EXISTS omni_ai_usage_assignment_receipt_check;
ALTER TABLE public.omni_ai_usage
  ADD CONSTRAINT omni_ai_usage_assignment_receipt_check CHECK (
    (
      assignment_scope IS NULL
      AND assignment_revision IS NULL
      AND assignment_configuration_sha256 IS NULL
    ) OR (
      assignment_id IS NOT NULL
      AND assignment_scope IN (
        'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
        'memory', 'embeddings', 'vision', 'audio', 'audio_diarization',
        'web_search', 'image_generation', 'speech_synthesis',
        'realtime_transcription'
      )
      AND assignment_revision > 0
      AND assignment_configuration_sha256 ~ '^[a-f0-9]{64}$'
      AND credential_source = 'tenant_vault'
    )
  );

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_model_assignments'::regclass
      AND conname = 'omni_model_assignments_scope_check'
      AND pg_get_constraintdef(oid) LIKE '%realtime_transcription%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_assignment_receipt_check'
      AND pg_get_constraintdef(oid) LIKE '%image_generation%'
  ) THEN
    RAISE EXCEPTION 'configurable_ai_model_scopes_v1 verification failed';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (
  version, name, checksum, applied_at
) VALUES (
  153,
  'configurable_ai_model_scopes_v1',
  '7e8e236c9c3c3d0f19dfc32c942ee6bd37aeed0da8f192057c9ecebb78412745',
  NOW()
);

COMMIT;
