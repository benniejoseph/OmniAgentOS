BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 146
      AND name = 'mobile_push_delivery_v1'
      AND checksum = 'f1b9d4b2c1cacd0e2ef0035665d485dbedb50b159d640a0d78b5111e02f5c959'
  ) <> 1 THEN
    RAISE EXCEPTION 'Loop v2 context-text predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_agent_loop_v2_checkpoints
DROP CONSTRAINT IF EXISTS
  omni_agent_loop_v2_checkpoints_engine_configuration_check;

ALTER TABLE omni_agent_loop_v2_checkpoints
ADD CONSTRAINT omni_agent_loop_v2_checkpoints_engine_configuration_check
CHECK (
  checkpoint_json #>> '{enginePin,engineVersionId}' = engine_version_id
  AND checkpoint_json #>> '{enginePin,contractVersionId}' =
    contract_version_id
  AND checkpoint_json #>> '{enginePin,configurationSha256}' =
    configuration_sha256
  AND checkpoint_json #>> '{enginePin,rolloutMode}' = 'canary'
  AND (checkpoint_json #>> '{enginePin,rolloutGeneration}')::BIGINT =
    rollout_generation
  AND (
    checkpoint_json #>> '{enginePin,rolloutLifecycleRevision}'
  )::BIGINT = rollout_lifecycle_revision
  AND (
    (
      checkpoint_json #>> '{enginePin,capabilityId}' = 'agent_loop_v2'
      AND engine_version_id = 'agent_loop_v2_read_only_canary_1'
      AND configuration_sha256 =
        'e0d1898a2de59ca2e4ec6fa6d5b5442347bae76e43700a29cfadbfa88a4e308b'
    )
    OR (
      checkpoint_json #>> '{enginePin,capabilityId}' =
        'agent_loop_v2_model_text'
      AND engine_version_id = 'agent_loop_v2_model_text_canary_1'
      AND configuration_sha256 =
        'b9106374788a0e7f74dc00f79269848f7de0d57f210364a68151c3c161dab690'
    )
    OR (
      checkpoint_json #>> '{enginePin,capabilityId}' =
        'agent_loop_v2_context_text'
      AND engine_version_id = 'agent_loop_v2_context_text_canary_1'
      AND configuration_sha256 =
        '70581030987f63fde99ded6d0c718945647c5ff5ff68aa3108a7473510135404'
    )
  )
) NOT VALID;

ALTER TABLE omni_agent_loop_v2_checkpoints
VALIDATE CONSTRAINT
  omni_agent_loop_v2_checkpoints_engine_configuration_check;

DO $migration$
DECLARE
  constraint_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO constraint_definition
  FROM pg_constraint
  WHERE conname =
      'omni_agent_loop_v2_checkpoints_engine_configuration_check'
    AND conrelid = 'omni_agent_loop_v2_checkpoints'::regclass
    AND contype = 'c'
    AND convalidated;

  IF constraint_definition IS NULL
    OR constraint_definition NOT LIKE '%agent_loop_v2_read_only_canary_1%'
    OR constraint_definition NOT LIKE '%agent_loop_v2_model_text_canary_1%'
    OR constraint_definition NOT LIKE '%agent_loop_v2_context_text_canary_1%'
    OR constraint_definition NOT LIKE
      '%70581030987f63fde99ded6d0c718945647c5ff5ff68aa3108a7473510135404%'
  THEN
    RAISE EXCEPTION 'Loop v2 context-text engine boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  147,
  'loop_v2_context_text_engine_v1',
  '2baa891cc5e1a1b3440198a2001caba943d1bc9aab258276564d430972ae83a3',
  clock_timestamp()
);

COMMIT;
