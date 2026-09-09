BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 149
      AND name = 'delegation_actor_identifier_compatibility_v1'
      AND checksum =
        'e23652ba4ff4fb4598d3671175e36d8a4a2974af839031477033d9924bc03810'
  ) <> 1 THEN
    RAISE EXCEPTION 'Legacy memory owner enrollment predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM omni_schema_version WHERE version = 150) THEN
    RAISE EXCEPTION 'Migration 150 is already recorded'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION omni_reject_retrieval_trace_access_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  controlled_owner_enrollment BOOLEAN :=
    omni_system_scope_enabled()
    AND current_setting('omni.memory_owner_enrollment_v1', TRUE) = 'true';
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
  ) AND NOT (
    controlled_owner_enrollment
    AND OLD.access_contract_version = 0
    AND OLD.access_state = 'legacy_unattributed'
    AND OLD.owner_actor_id IS NULL
    AND NEW.tenant_id = OLD.tenant_id
    AND NEW.access_contract_version = 1
    AND NEW.access_state = 'scope_bound'
    AND omni_source_contract_id_is_valid(NEW.owner_actor_id)
    AND NEW.owner_agent_id IS NULL
    AND NEW.workspace_id IS NULL
    AND NEW.project_id IS NULL
    AND NEW.mission_id IS NULL
    AND NEW.visibility = 'user_private'
    AND NEW.sensitivity = 'confidential'
    AND NEW.origin_purpose = 'context.retrieval.trace'
    AND NEW.allowed_purpose_ids = ARRAY[
      'memory.export.v1', 'memory.forget.v1',
      'memory.read.v1', 'memory.retrieve.v1'
    ]::TEXT[]
    AND NEW.access_scope_sha256 ~ '^[0-9a-f]{64}$'
    AND NEW.access_bound_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Retrieval trace access scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION omni_validate_memory_reconciliation_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  candidate_memory public.omni_memories%ROWTYPE;
  existing_memory public.omni_memories%ROWTYPE;
  controlled_owner_enrollment BOOLEAN :=
    public.omni_system_scope_enabled()
    AND current_setting('omni.memory_owner_enrollment_v1', TRUE) = 'true';
BEGIN
  IF TG_OP = 'UPDATE'
    AND ROW(
      OLD.tenant_id, OLD.owner_actor_id, OLD.kind,
      OLD.detection_reason, OLD.candidate_memory_id,
      OLD.existing_memory_id, OLD.created_at
    ) IS DISTINCT FROM ROW(
      NEW.tenant_id, NEW.owner_actor_id, NEW.kind,
      NEW.detection_reason, NEW.candidate_memory_id,
      NEW.existing_memory_id, NEW.created_at
    )
    AND NOT (
      controlled_owner_enrollment
      AND OLD.owner_actor_id IS NULL
      AND public.omni_source_contract_id_is_valid(NEW.owner_actor_id)
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.kind = NEW.kind
      AND OLD.detection_reason = NEW.detection_reason
      AND OLD.candidate_memory_id = NEW.candidate_memory_id
      AND OLD.existing_memory_id IS NOT DISTINCT FROM NEW.existing_memory_id
      AND OLD.created_at = NEW.created_at
    )
  THEN
    RAISE EXCEPTION 'Memory reconciliation identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO candidate_memory
  FROM public.omni_memories memory
  WHERE memory.tenant_id = NEW.tenant_id
    AND memory.id = NEW.candidate_memory_id;
  IF NOT FOUND
    OR candidate_memory.claim_status = 'forgotten'
    OR candidate_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
  THEN
    RAISE EXCEPTION 'Memory reconciliation candidate is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.existing_memory_id IS NOT NULL THEN
    SELECT * INTO existing_memory
    FROM public.omni_memories memory
    WHERE memory.tenant_id = NEW.tenant_id
      AND memory.id = NEW.existing_memory_id;
    IF NOT FOUND
      OR existing_memory.claim_status = 'forgotten'
      OR existing_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    THEN
      RAISE EXCEPTION 'Memory reconciliation existing claim is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  150,
  'legacy_memory_owner_enrollment_v1',
  'd43fafd08d25aa6f3c7646828a43596a1c9301fc3b99d8fa82c077175a57cab2',
  clock_timestamp()
);

COMMIT;
