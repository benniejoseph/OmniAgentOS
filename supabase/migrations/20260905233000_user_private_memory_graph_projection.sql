ALTER TABLE omni_memory_graph_nodes
  ADD COLUMN IF NOT EXISTS access_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'legacy_unattributed',
  ADD COLUMN IF NOT EXISTS owner_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS owner_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS mission_id TEXT,
  ADD COLUMN IF NOT EXISTS visibility TEXT,
  ADD COLUMN IF NOT EXISTS sensitivity TEXT,
  ADD COLUMN IF NOT EXISTS origin_purpose TEXT,
  ADD COLUMN IF NOT EXISTS allowed_purpose_ids TEXT[],
  ADD COLUMN IF NOT EXISTS access_scope_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS access_bound_at TIMESTAMPTZ;
ALTER TABLE omni_memory_graph_edges
  ADD COLUMN IF NOT EXISTS access_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'legacy_unattributed',
  ADD COLUMN IF NOT EXISTS owner_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS owner_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS mission_id TEXT,
  ADD COLUMN IF NOT EXISTS visibility TEXT,
  ADD COLUMN IF NOT EXISTS sensitivity TEXT,
  ADD COLUMN IF NOT EXISTS origin_purpose TEXT,
  ADD COLUMN IF NOT EXISTS allowed_purpose_ids TEXT[],
  ADD COLUMN IF NOT EXISTS access_scope_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS access_bound_at TIMESTAMPTZ;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omni_memory_graph_nodes_access_contract_check'
      AND conrelid = 'omni_memory_graph_nodes'::regclass
  ) THEN
    ALTER TABLE omni_memory_graph_nodes
    ADD CONSTRAINT omni_memory_graph_nodes_access_contract_check CHECK (
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
        AND origin_purpose = 'memory.graph.projection'
        AND allowed_purpose_ids = ARRAY[
          'memory.correct.v1',
          'memory.export.v1',
          'memory.forget.v1',
          'memory.read.v1',
          'memory.retrieve.v1',
          'memory.write.v1'
        ]::TEXT[]
        AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
        AND access_bound_at IS NOT NULL
      )
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omni_memory_graph_edges_access_contract_check'
      AND conrelid = 'omni_memory_graph_edges'::regclass
  ) THEN
    ALTER TABLE omni_memory_graph_edges
    ADD CONSTRAINT omni_memory_graph_edges_access_contract_check CHECK (
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
        AND origin_purpose = 'memory.graph.projection'
        AND allowed_purpose_ids = ARRAY[
          'memory.correct.v1',
          'memory.export.v1',
          'memory.forget.v1',
          'memory.read.v1',
          'memory.retrieve.v1',
          'memory.write.v1'
        ]::TEXT[]
        AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
        AND access_bound_at IS NOT NULL
      )
    ) NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE omni_memory_graph_nodes
  VALIDATE CONSTRAINT omni_memory_graph_nodes_access_contract_check;
ALTER TABLE omni_memory_graph_edges
  VALIDATE CONSTRAINT omni_memory_graph_edges_access_contract_check;
CREATE OR REPLACE FUNCTION omni_reject_memory_graph_access_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
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
    RAISE EXCEPTION 'Memory graph access scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS omni_memory_graph_nodes_access_scope_immutable
  ON omni_memory_graph_nodes;
CREATE TRIGGER omni_memory_graph_nodes_access_scope_immutable
BEFORE UPDATE OF
  tenant_id, access_contract_version, access_state, owner_actor_id,
  owner_agent_id, workspace_id, project_id, mission_id, visibility,
  sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256,
  access_bound_at
ON omni_memory_graph_nodes
FOR EACH ROW EXECUTE FUNCTION omni_reject_memory_graph_access_change();
DROP TRIGGER IF EXISTS omni_memory_graph_edges_access_scope_immutable
  ON omni_memory_graph_edges;
CREATE TRIGGER omni_memory_graph_edges_access_scope_immutable
BEFORE UPDATE OF
  tenant_id, access_contract_version, access_state, owner_actor_id,
  owner_agent_id, workspace_id, project_id, mission_id, visibility,
  sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256,
  access_bound_at
ON omni_memory_graph_edges
FOR EACH ROW EXECUTE FUNCTION omni_reject_memory_graph_access_change();
DROP POLICY IF EXISTS omni_memory_graph_nodes_access_scope
  ON omni_memory_graph_nodes;
CREATE POLICY omni_memory_graph_nodes_access_scope
ON omni_memory_graph_nodes
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
      tenant_id, owner_actor_id, allowed_purpose_ids
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
      tenant_id, owner_actor_id, allowed_purpose_ids
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_edges_access_scope
  ON omni_memory_graph_edges;
CREATE POLICY omni_memory_graph_edges_access_scope
ON omni_memory_graph_edges
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
      tenant_id, owner_actor_id, allowed_purpose_ids
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
      tenant_id, owner_actor_id, allowed_purpose_ids
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_nodes_insert_purpose
  ON omni_memory_graph_nodes;
CREATE POLICY omni_memory_graph_nodes_insert_purpose
ON omni_memory_graph_nodes
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
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_edges_insert_purpose
  ON omni_memory_graph_edges;
CREATE POLICY omni_memory_graph_edges_insert_purpose
ON omni_memory_graph_edges
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
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_nodes_update_purpose
  ON omni_memory_graph_nodes;
CREATE POLICY omni_memory_graph_nodes_update_purpose
ON omni_memory_graph_nodes
AS RESTRICTIVE
FOR UPDATE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
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
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_edges_update_purpose
  ON omni_memory_graph_edges;
CREATE POLICY omni_memory_graph_edges_update_purpose
ON omni_memory_graph_edges
AS RESTRICTIVE
FOR UPDATE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
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
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.write.v1', 'memory.correct.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_graph_nodes_delete_purpose
  ON omni_memory_graph_nodes;
CREATE POLICY omni_memory_graph_nodes_delete_purpose
ON omni_memory_graph_nodes
AS RESTRICTIVE
FOR DELETE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND omni_current_memory_access_scope_v1() ->> 'purposeId'
      = 'memory.forget.v1'
  )
);
DROP POLICY IF EXISTS omni_memory_graph_edges_delete_purpose
  ON omni_memory_graph_edges;
CREATE POLICY omni_memory_graph_edges_delete_purpose
ON omni_memory_graph_edges
AS RESTRICTIVE
FOR DELETE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND omni_current_memory_access_scope_v1() ->> 'purposeId'
      = 'memory.forget.v1'
  )
);
CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_actor_rank_idx
ON omni_memory_graph_nodes (
  tenant_id, owner_actor_id, weight DESC, source_count DESC, updated_at DESC
)
WHERE access_contract_version = 1;
CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_actor_rank_idx
ON omni_memory_graph_edges (
  tenant_id, owner_actor_id, weight DESC, evidence_count DESC, updated_at DESC
)
WHERE access_contract_version = 1;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
SELECT
  79,
  'user_private_memory_graph_projection',
  '5d491f28e211333c21caa8c65fac6b0819c98ef833322512340b38d30b1bbdf4',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM omni_schema_version WHERE version = 79
);
