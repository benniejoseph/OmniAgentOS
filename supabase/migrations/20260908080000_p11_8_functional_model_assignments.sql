BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 142
      AND name = 'cohesive_today_preferences_v1'
      AND checksum = 'c2ccb45d121194793876b68fec90c68f2d1bdfadcc889aebdd5abd9f4bd8763d'
  ) <> 1 THEN
    RAISE EXCEPTION 'Functional model assignment predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check;

ALTER TABLE omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_runtime_readiness_check;

UPDATE omni_model_assignments
SET scope = 'planner'
WHERE scope = 'workflow';

ALTER TABLE omni_model_assignments
  ADD COLUMN IF NOT EXISTS contract_version TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS assignment_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS configuration_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;

UPDATE omni_model_assignments
SET runtime_readiness = 'configuration_only',
    contract_version = 'legacy',
    assignment_revision = GREATEST(assignment_revision, 1),
    configuration_sha256 = NULL,
    validated_at = NULL;

ALTER TABLE omni_model_assignments
  ADD CONSTRAINT omni_model_assignments_scope_check CHECK (
    scope IN (
      'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
      'memory', 'embeddings', 'vision', 'audio'
    )
  ),
  ADD CONSTRAINT omni_model_assignments_runtime_readiness_check CHECK (
    runtime_readiness IN ('active', 'configuration_only')
  ),
  ADD CONSTRAINT omni_model_assignments_contract_check CHECK (
    (
      runtime_readiness = 'configuration_only'
      AND contract_version = 'legacy'
      AND configuration_sha256 IS NULL
      AND validated_at IS NULL
    ) OR (
      runtime_readiness = 'active'
      AND contract_version = 'p11.8-model-assignment:1'
      AND configuration_sha256 ~ '^[a-f0-9]{64}$'
      AND validated_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT omni_model_assignments_revision_check CHECK (
    assignment_revision > 0
  );

ALTER TABLE omni_ai_usage
  ADD COLUMN IF NOT EXISTS assignment_scope TEXT,
  ADD COLUMN IF NOT EXISTS assignment_revision INTEGER,
  ADD COLUMN IF NOT EXISTS assignment_configuration_sha256 TEXT;

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
        'memory', 'embeddings', 'vision', 'audio'
      )
      AND assignment_revision > 0
      AND assignment_configuration_sha256 ~ '^[a-f0-9]{64}$'
      AND credential_source = 'tenant_vault'
    )
  );

CREATE INDEX IF NOT EXISTS omni_ai_usage_assignment_receipt_idx
  ON omni_ai_usage (
    tenant_id, actor_id, assignment_id, assignment_revision, recorded_at DESC
  )
  WHERE assignment_id IS NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_model_assignments'::regclass
      AND conname = 'omni_model_assignments_contract_check'
      AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_ai_usage'::regclass
      AND conname = 'omni_ai_usage_assignment_receipt_check'
      AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'omni_ai_usage_assignment_receipt_idx'
  ) THEN
    RAISE EXCEPTION 'Functional model assignment schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  143,
  'functional_model_assignments_v1',
  'b2c0979801a5aed19e44b0c12ed6c457ac766868baae1d4ca27d1abddb269cae',
  clock_timestamp()
);

COMMIT;
