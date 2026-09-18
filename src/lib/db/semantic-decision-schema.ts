type SqlRow = Record<string, unknown>;

export type SemanticDecisionSchemaSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
};

/**
 * Extends the existing Settings and usage-ledger contracts for a dedicated
 * TypeSafe/Jev semantic-decision route. The cross-constraint prevents this
 * provider from being selected for generative work and prevents any fallback
 * or authority expansion on the shadow-only scope.
 */
export async function ensureSemanticDecisionShadowPilotV1(
  sql: SemanticDecisionSchemaSqlClient,
) {
  await sql.query(`
    ALTER TABLE omni_provider_connections
      DROP CONSTRAINT IF EXISTS omni_provider_connections_provider_check;
    ALTER TABLE omni_provider_connections
      ADD CONSTRAINT omni_provider_connections_provider_check CHECK (
        provider IN ('openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe')
      );

    ALTER TABLE omni_model_catalog
      DROP CONSTRAINT IF EXISTS omni_model_catalog_provider_check;
    ALTER TABLE omni_model_catalog
      ADD CONSTRAINT omni_model_catalog_provider_check CHECK (
        provider IN ('openai', 'google', 'anthropic', 'aws_bedrock', 'typesafe')
      );

    ALTER TABLE omni_model_assignments
      DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check,
      DROP CONSTRAINT IF EXISTS omni_model_assignments_provider_check,
      DROP CONSTRAINT IF EXISTS omni_model_assignments_fallback_provider_check,
      DROP CONSTRAINT IF EXISTS omni_model_assignments_semantic_decision_provider_check;
    ALTER TABLE omni_model_assignments
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

    ALTER TABLE omni_ai_usage
      DROP CONSTRAINT IF EXISTS omni_ai_usage_operation_check;
    ALTER TABLE omni_ai_usage
      ADD CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
        'text_generation', 'structured_generation', 'tool_turn',
        'embedding', 'web_search', 'ocr', 'image_generation',
        'video_generation', 'transcription', 'speech_synthesis',
        'browser_automation', 'semantic_decision'
      ));
    ALTER TABLE omni_ai_usage
      DROP CONSTRAINT IF EXISTS omni_ai_usage_assignment_receipt_check;
    ALTER TABLE omni_ai_usage
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
  `);
  await sql.query(`
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
        WHERE conrelid = 'omni_provider_connections'::regclass
          AND conname = 'omni_provider_connections_provider_check'
      ))) = 0
      OR position('semantic_decision' IN pg_get_constraintdef((
        SELECT oid FROM pg_constraint
        WHERE conrelid = 'omni_model_assignments'::regclass
          AND conname = 'omni_model_assignments_scope_check'
      ))) = 0
      OR position('semantic_decision' IN pg_get_constraintdef((
        SELECT oid FROM pg_constraint
        WHERE conrelid = 'omni_ai_usage'::regclass
          AND conname = 'omni_ai_usage_operation_check'
      ))) = 0 THEN
        RAISE EXCEPTION 'Semantic decision shadow schema is incomplete'
          USING ERRCODE = '55000';
      END IF;
    END
    $verify$;
  `);
}
