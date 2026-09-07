CREATE TABLE IF NOT EXISTS omni_run_forks (
  schema_version INTEGER NOT NULL,
  fork_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  initiating_actor_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_checkpoint_id TEXT NOT NULL,
  source_checkpoint_sha256 TEXT NOT NULL,
  source_checkpoint_sequence INTEGER NOT NULL,
  fork_run_id TEXT NOT NULL,
  execution_scope_sha256 TEXT NOT NULL,
  context_grant_ids_sha256 TEXT NOT NULL,
  capability_grant_ids_sha256 TEXT NOT NULL,
  correction_length INTEGER NOT NULL,
  correction_sha256 TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  source_event_prefix_count INTEGER NOT NULL,
  source_event_prefix_last_seq BIGINT NOT NULL,
  source_event_prefix_sha256 TEXT NOT NULL,
  lineage_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_run_forks_schema_check CHECK (schema_version = 1),
  CONSTRAINT omni_run_forks_id_check CHECK (
    length(fork_id) BETWEEN 1 AND 240
    AND length(tenant_id) BETWEEN 1 AND 240
    AND length(initiating_actor_id) BETWEEN 1 AND 240
    AND length(source_run_id) BETWEEN 1 AND 240
    AND length(source_checkpoint_id) BETWEEN 1 AND 240
    AND length(fork_run_id) BETWEEN 1 AND 240
  ),
  CONSTRAINT omni_run_forks_sha_check CHECK (
    source_checkpoint_sha256 ~ '^[a-f0-9]{64}$'
    AND execution_scope_sha256 ~ '^[a-f0-9]{64}$'
    AND context_grant_ids_sha256 ~ '^[a-f0-9]{64}$'
    AND capability_grant_ids_sha256 ~ '^[a-f0-9]{64}$'
    AND correction_sha256 ~ '^[a-f0-9]{64}$'
    AND idempotency_key_sha256 ~ '^[a-f0-9]{64}$'
    AND source_event_prefix_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT omni_run_forks_bounds_check CHECK (
    source_checkpoint_sequence BETWEEN 0 AND 1000000000
    AND correction_length BETWEEN 1 AND 4000
    AND source_event_prefix_count BETWEEN 1 AND 2000
    AND source_event_prefix_last_seq >= 1
  ),
  CONSTRAINT omni_run_forks_json_check CHECK (
    jsonb_typeof(lineage_json) = 'object'
    AND (lineage_json ->> 'schemaVersion')::INTEGER = schema_version
    AND lineage_json ->> 'forkId' = fork_id
    AND lineage_json ->> 'tenantId' = tenant_id
    AND lineage_json ->> 'initiatingActorId' = initiating_actor_id
    AND lineage_json #>> '{source,runId}' = source_run_id
    AND lineage_json #>> '{source,checkpointId}' = source_checkpoint_id
    AND lineage_json #>> '{source,checkpointSha256}' = source_checkpoint_sha256
    AND (lineage_json #>> '{source,checkpointSequence}')::INTEGER =
      source_checkpoint_sequence
    AND lineage_json #>> '{target,runId}' = fork_run_id
    AND lineage_json #>> '{target,executionScopeSha256}' =
      execution_scope_sha256
    AND lineage_json #>> '{target,contextGrantIdsSha256}' =
      context_grant_ids_sha256
    AND lineage_json #>> '{target,capabilityGrantIdsSha256}' =
      capability_grant_ids_sha256
    AND lineage_json #>> '{target,approvalInheritance}' = 'none'
    AND lineage_json #>> '{target,continuationInheritance}' = 'none'
    AND (lineage_json #>> '{correction,length}')::INTEGER = correction_length
    AND lineage_json #>> '{correction,sha256}' = correction_sha256
    AND lineage_json ->> 'idempotencyKeySha256' = idempotency_key_sha256
  ),
  CONSTRAINT omni_run_forks_fork_run_unique UNIQUE (tenant_id, fork_run_id),
  CONSTRAINT omni_run_forks_idempotency_unique UNIQUE (
    tenant_id, source_run_id, idempotency_key_sha256
  ),
  CONSTRAINT omni_run_forks_checkpoint_fk FOREIGN KEY (
    tenant_id, source_run_id, source_checkpoint_id, source_checkpoint_sha256
  ) REFERENCES omni_run_checkpoints (
    tenant_id, run_id, checkpoint_id, checkpoint_sha256
  ) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS omni_run_forks_source_idx
ON omni_run_forks (
  tenant_id, source_run_id, source_checkpoint_sequence, created_at
);
CREATE OR REPLACE FUNCTION omni_reject_run_fork_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Run fork lineage is append-only' USING ERRCODE = '55000';
END
$function$;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_run_forks'::regclass
      AND tgname = 'omni_run_forks_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER omni_run_forks_immutable
    BEFORE UPDATE OR DELETE ON omni_run_forks
    FOR EACH ROW EXECUTE FUNCTION omni_reject_run_fork_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_run_forks'::regclass
      AND tgname = 'omni_run_forks_no_truncate'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER omni_run_forks_no_truncate
    BEFORE TRUNCATE ON omni_run_forks
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_run_fork_mutation();
  END IF;
END
$migration$;
ALTER TABLE omni_run_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_run_forks FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_run_forks'::regclass
      AND polname = 'omni_tenant_isolation'
  ) THEN
    CREATE POLICY omni_tenant_isolation ON omni_run_forks FOR ALL
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id));
  END IF;
END
$migration$;
REVOKE ALL ON TABLE omni_run_forks FROM PUBLIC;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  70,
  'run_checkpoint_fork_lineage',
  '8bdc17f17f5c51ee1e646e3e6d9a230c5fe051e80611dd90cd8b2b35152e7115',
  NOW()
);
