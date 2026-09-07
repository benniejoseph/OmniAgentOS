ALTER TABLE omni_retrieval_traces
ADD COLUMN IF NOT EXISTS access_contract_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE omni_retrieval_traces
ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'legacy_unattributed';
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS owner_actor_id TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS owner_agent_id TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS mission_id TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS visibility TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS sensitivity TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS origin_purpose TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS access_scope_sha256 TEXT;
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS allowed_purpose_ids TEXT[];
ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS access_bound_at TIMESTAMPTZ;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'omni_retrieval_traces_access_contract_check'
      AND conrelid = 'omni_retrieval_traces'::regclass
  ) THEN
    ALTER TABLE omni_retrieval_traces
    ADD CONSTRAINT omni_retrieval_traces_access_contract_check CHECK (
      (
        access_contract_version = 0
        AND access_state = 'legacy_unattributed'
        AND owner_actor_id IS NULL
        AND owner_agent_id IS NULL
        AND workspace_id IS NULL
        AND project_id IS NULL
        AND mission_id IS NULL
        AND visibility IS NULL
        AND sensitivity IS NULL
        AND origin_purpose IS NULL
        AND allowed_purpose_ids IS NULL
        AND access_scope_sha256 IS NULL
        AND access_bound_at IS NULL
      )
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND owner_agent_id IS NULL
        AND workspace_id IS NULL
        AND project_id IS NULL
        AND mission_id IS NULL
        AND visibility = 'user_private'
        AND sensitivity = 'confidential'
        AND origin_purpose = 'context.retrieval.trace'
        AND allowed_purpose_ids = ARRAY[
          'memory.export.v1',
          'memory.forget.v1',
          'memory.read.v1',
          'memory.retrieve.v1'
        ]::TEXT[]
        AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
        AND access_bound_at IS NOT NULL
      )
    ) NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE omni_retrieval_traces
VALIDATE CONSTRAINT omni_retrieval_traces_access_contract_check;
CREATE OR REPLACE FUNCTION omni_reject_retrieval_trace_access_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.access_contract_version = 1 THEN
    RAISE EXCEPTION 'User-private retrieval traces are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    OLD.tenant_id,
    OLD.access_contract_version,
    OLD.access_state,
    OLD.owner_actor_id,
    OLD.owner_agent_id,
    OLD.workspace_id,
    OLD.project_id,
    OLD.mission_id,
    OLD.visibility,
    OLD.sensitivity,
    OLD.origin_purpose,
    OLD.allowed_purpose_ids,
    OLD.access_scope_sha256,
    OLD.access_bound_at
  ) IS DISTINCT FROM ROW(
    NEW.tenant_id,
    NEW.access_contract_version,
    NEW.access_state,
    NEW.owner_actor_id,
    NEW.owner_agent_id,
    NEW.workspace_id,
    NEW.project_id,
    NEW.mission_id,
    NEW.visibility,
    NEW.sensitivity,
    NEW.origin_purpose,
    NEW.allowed_purpose_ids,
    NEW.access_scope_sha256,
    NEW.access_bound_at
  ) THEN
    RAISE EXCEPTION 'Retrieval trace access scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS omni_retrieval_traces_access_scope_immutable
ON omni_retrieval_traces;
CREATE TRIGGER omni_retrieval_traces_access_scope_immutable
BEFORE UPDATE ON omni_retrieval_traces
FOR EACH ROW
EXECUTE FUNCTION omni_reject_retrieval_trace_access_change();
CREATE INDEX IF NOT EXISTS omni_retrieval_traces_actor_created_idx
ON omni_retrieval_traces (tenant_id, owner_actor_id, created_at DESC)
WHERE access_contract_version = 1;
DROP POLICY IF EXISTS omni_retrieval_trace_access_scope
ON omni_retrieval_traces;
CREATE POLICY omni_retrieval_trace_access_scope
ON omni_retrieval_traces
AS RESTRICTIVE
FOR ALL
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND omni_user_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      allowed_purpose_ids
    )
  )
)
WITH CHECK (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND omni_user_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      allowed_purpose_ids
    )
  )
);
DROP POLICY IF EXISTS omni_retrieval_trace_insert_purpose
ON omni_retrieval_traces;
CREATE POLICY omni_retrieval_trace_insert_purpose
ON omni_retrieval_traces
AS RESTRICTIVE
FOR INSERT
WITH CHECK (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND omni_current_memory_access_scope_v1() ->> 'purposeId'
      = 'memory.retrieve.v1'
  )
);
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  77,
  'user_private_retrieval_traces',
  'f6333159707f3796f1f9ae79f09744536c672b6142c81fddcadd348182ee5093',
  NOW()
);
