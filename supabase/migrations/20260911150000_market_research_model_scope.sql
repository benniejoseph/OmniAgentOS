BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 156 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 156
      AND name = 'conversation_summary_enrichments_v1'
      AND checksum =
        '83e7878f29b3ea25df0ecb40bd94521a3e84af93f5eae6a34ad03bd4b9071a37'
  ) <> 1 THEN
    RAISE EXCEPTION 'Market research model scope predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check;
ALTER TABLE public.omni_model_assignments
  ADD CONSTRAINT omni_model_assignments_scope_check CHECK (
    scope IN (
      'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
      'market_research', 'memory', 'embeddings', 'vision', 'audio',
      'audio_diarization', 'web_search', 'image_generation',
      'video_generation', 'computer_use', 'speech_synthesis',
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
        'market_research', 'memory', 'embeddings', 'vision', 'audio',
        'audio_diarization', 'web_search', 'image_generation',
        'video_generation', 'computer_use', 'speech_synthesis',
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
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%market_research%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_assignment_receipt_check'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%market_research%'
  ) THEN
    RAISE EXCEPTION 'Market research model scope verification failed'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  157,
  'market_research_model_scope_v1',
  'f1c276a830957ba8409e6f776f8dce5499324a75db8b7980533bafcbd612b749',
  clock_timestamp()
);

COMMIT;
