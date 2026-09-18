BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 183 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 183
      AND name = 'actor_rls_policy_composition_repair_v1'
      AND checksum = '06e06bfc319278f8e676d14c30bfc34f60cdda305ff48b0c4f4944a01e53ba97'
  ) <> 1 THEN
    RAISE EXCEPTION 'Semantic decision shadow predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_provider_connections
  DROP CONSTRAINT IF EXISTS omni_provider_connections_provider_check;
ALTER TABLE public.omni_provider_connections
  ADD CONSTRAINT omni_provider_connections_provider_check CHECK (
    provider IN ('openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe')
  );

ALTER TABLE public.omni_model_catalog
  DROP CONSTRAINT IF EXISTS omni_model_catalog_provider_check;
ALTER TABLE public.omni_model_catalog
  ADD CONSTRAINT omni_model_catalog_provider_check CHECK (
    provider IN ('openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe')
  );

ALTER TABLE public.omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check,
  DROP CONSTRAINT IF EXISTS omni_model_assignments_provider_check,
  DROP CONSTRAINT IF EXISTS omni_model_assignments_fallback_provider_check,
  DROP CONSTRAINT IF EXISTS omni_model_assignments_semantic_decision_provider_check;
ALTER TABLE public.omni_model_assignments
  ADD CONSTRAINT omni_model_assignments_scope_check CHECK (scope IN (
    'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
    'market_research', 'code_builder', 'memory', 'embeddings', 'vision',
    'audio', 'audio_diarization', 'web_search', 'image_generation',
    'video_generation', 'computer_use', 'speech_synthesis',
    'realtime_transcription', 'semantic_decision'
  )),
  ADD CONSTRAINT omni_model_assignments_provider_check CHECK (
    provider IN ('openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe')
  ),
  ADD CONSTRAINT omni_model_assignments_fallback_provider_check CHECK (
    fallback_provider IS NULL OR fallback_provider IN (
      'openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe'
    )
  ),
  ADD CONSTRAINT omni_model_assignments_semantic_decision_provider_check
    CHECK (
      (
        scope = 'semantic_decision'
        AND provider = 'typesafe'
        AND fallback_provider IS NULL
        AND fallback_model_id IS NULL
        AND NOT allow_cross_provider_fallback
      ) OR (
        scope <> 'semantic_decision'
        AND provider <> 'typesafe'
        AND fallback_provider IS DISTINCT FROM 'typesafe'
      )
    );

ALTER TABLE public.omni_ai_usage
  DROP CONSTRAINT IF EXISTS omni_ai_usage_operation_check;
ALTER TABLE public.omni_ai_usage
  ADD CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
    'text_generation', 'structured_generation', 'tool_turn',
    'embedding', 'web_search', 'ocr', 'image_generation',
    'video_generation', 'transcription', 'speech_synthesis',
    'browser_automation', 'semantic_decision'
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
        'market_research', 'code_builder', 'memory', 'embeddings', 'vision',
        'audio', 'audio_diarization', 'web_search', 'image_generation',
        'video_generation', 'computer_use', 'speech_synthesis',
        'realtime_transcription', 'semantic_decision'
      )
      AND assignment_revision > 0
      AND assignment_configuration_sha256 ~ '^[a-f0-9]{64}$'
      AND credential_source = 'tenant_vault'
    )
  );

DO $verify$
DECLARE
  expected_constraints CONSTANT TEXT[] := ARRAY[
    'omni_provider_connections_provider_check',
    'omni_model_catalog_provider_check',
    'omni_model_assignments_scope_check',
    'omni_model_assignments_provider_check',
    'omni_model_assignments_fallback_provider_check',
    'omni_model_assignments_semantic_decision_provider_check',
    'omni_ai_usage_operation_check',
    'omni_ai_usage_assignment_receipt_check'
  ];
BEGIN
  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = ANY(expected_constraints)
      AND contype = 'c'
  ) <> cardinality(expected_constraints)
  OR position('typesafe' IN pg_get_constraintdef((
    SELECT oid FROM pg_constraint
    WHERE conrelid = 'public.omni_provider_connections'::regclass
      AND conname = 'omni_provider_connections_provider_check'
  ))) = 0
  OR position('semantic_decision' IN pg_get_constraintdef((
    SELECT oid FROM pg_constraint
    WHERE conrelid = 'public.omni_model_assignments'::regclass
      AND conname = 'omni_model_assignments_scope_check'
  ))) = 0
  OR position('semantic_decision' IN pg_get_constraintdef((
    SELECT oid FROM pg_constraint
    WHERE conrelid = 'public.omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_operation_check'
  ))) = 0 THEN
    RAISE EXCEPTION 'Semantic decision shadow schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  184,
  'semantic_decision_shadow_pilot_v1',
  '142047c12f42ba8135d7bfd95edde467ebcedf4d42f5c69937b4fe797a865223',
  clock_timestamp()
);

COMMIT;
