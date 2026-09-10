BEGIN;

DO $guard$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 153 OR NOT EXISTS (
    SELECT 1 FROM public.omni_schema_version
    WHERE version = 153
      AND name = 'configurable_ai_model_scopes_v1'
      AND checksum = '7e8e236c9c3c3d0f19dfc32c942ee6bd37aeed0da8f192057c9ecebb78412745'
  ) THEN
    RAISE EXCEPTION 'media_computer_model_scopes_v1 requires exact predecessor 153';
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
      'web_search', 'image_generation', 'video_generation', 'computer_use',
      'speech_synthesis', 'realtime_transcription'
    )
  );

ALTER TABLE public.omni_ai_usage
  DROP CONSTRAINT IF EXISTS omni_ai_usage_operation_check;
ALTER TABLE public.omni_ai_usage
  ADD CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
    'text_generation', 'structured_generation', 'tool_turn',
    'embedding', 'web_search', 'ocr', 'image_generation', 'video_generation',
    'transcription', 'speech_synthesis', 'browser_automation'
  ));

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
        'web_search', 'image_generation', 'video_generation', 'computer_use',
        'speech_synthesis', 'realtime_transcription'
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
      AND pg_get_constraintdef(oid) LIKE '%computer_use%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_operation_check'
      AND pg_get_constraintdef(oid) LIKE '%video_generation%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_assignment_receipt_check'
      AND pg_get_constraintdef(oid) LIKE '%video_generation%'
  ) THEN
    RAISE EXCEPTION 'media_computer_model_scopes_v1 verification failed';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (
  version, name, checksum, applied_at
) VALUES (
  154,
  'media_computer_model_scopes_v1',
  'a8aa943ab72aed3c2d80a7d6abf46efb206b64ed476a6f674298a6e0eb1343f2',
  NOW()
);

COMMIT;
