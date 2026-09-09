BEGIN;

DO $guard$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 151 OR NOT EXISTS (
    SELECT 1 FROM public.omni_schema_version
    WHERE version = 151
      AND name = 'maintenance_system_scope_v1'
      AND checksum = '6eeab2482987d833ab99862640348951d6d798d732cb91df91791ac29b098679'
  ) THEN
    RAISE EXCEPTION 'memory_graph_scope_v2 requires exact predecessor 151';
  END IF;
END
$guard$;

ALTER TABLE public.omni_memory_graph_nodes
  DROP CONSTRAINT IF EXISTS omni_memory_graph_nodes_access_contract_check,
  DROP CONSTRAINT IF EXISTS omni_memory_graph_nodes_scope_v2_check;
ALTER TABLE public.omni_memory_graph_nodes
  ADD CONSTRAINT omni_memory_graph_nodes_scope_v2_check CHECK (
    (access_contract_version = 0
      AND access_state = 'legacy_unattributed'
      AND owner_actor_id IS NULL AND owner_agent_id IS NULL
      AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL
      AND visibility IS NULL AND sensitivity IS NULL
      AND origin_purpose IS NULL AND allowed_purpose_ids IS NULL
      AND access_scope_sha256 IS NULL AND access_bound_at IS NULL)
    OR
    (access_contract_version = 1
      AND access_state = 'scope_bound'
      AND public.omni_source_contract_id_is_valid(owner_actor_id)
      AND sensitivity IN ('confidential', 'restricted')
      AND origin_purpose = 'memory.graph.projection'
      AND allowed_purpose_ids = ARRAY[
        'memory.correct.v1', 'memory.export.v1', 'memory.forget.v1',
        'memory.read.v1', 'memory.retrieve.v1', 'memory.write.v1'
      ]::TEXT[]
      AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
      AND access_bound_at IS NOT NULL
      AND (
        (visibility = 'user_private'
          AND owner_agent_id IS NULL
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL)
        OR
        (visibility = 'agent_private'
          AND public.omni_source_contract_id_is_valid(owner_agent_id)
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL)
        OR
        (visibility = 'project_shared'
          AND owner_agent_id IS NULL
          AND public.omni_source_contract_id_is_valid(workspace_id)
          AND public.omni_source_contract_id_is_valid(project_id)
          AND mission_id IS NULL)
        OR
        (visibility = 'workspace_shared'
          AND owner_agent_id IS NULL
          AND public.omni_source_contract_id_is_valid(workspace_id)
          AND project_id IS NULL AND mission_id IS NULL)
      ))
  ) NOT VALID;

ALTER TABLE public.omni_memory_graph_edges
  DROP CONSTRAINT IF EXISTS omni_memory_graph_edges_access_contract_check,
  DROP CONSTRAINT IF EXISTS omni_memory_graph_edges_scope_v2_check;
ALTER TABLE public.omni_memory_graph_edges
  ADD CONSTRAINT omni_memory_graph_edges_scope_v2_check CHECK (
    (access_contract_version = 0
      AND access_state = 'legacy_unattributed'
      AND owner_actor_id IS NULL AND owner_agent_id IS NULL
      AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL
      AND visibility IS NULL AND sensitivity IS NULL
      AND origin_purpose IS NULL AND allowed_purpose_ids IS NULL
      AND access_scope_sha256 IS NULL AND access_bound_at IS NULL)
    OR
    (access_contract_version = 1
      AND access_state = 'scope_bound'
      AND public.omni_source_contract_id_is_valid(owner_actor_id)
      AND sensitivity IN ('confidential', 'restricted')
      AND origin_purpose = 'memory.graph.projection'
      AND allowed_purpose_ids = ARRAY[
        'memory.correct.v1', 'memory.export.v1', 'memory.forget.v1',
        'memory.read.v1', 'memory.retrieve.v1', 'memory.write.v1'
      ]::TEXT[]
      AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
      AND access_bound_at IS NOT NULL
      AND (
        (visibility = 'user_private'
          AND owner_agent_id IS NULL
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL)
        OR
        (visibility = 'agent_private'
          AND public.omni_source_contract_id_is_valid(owner_agent_id)
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL)
        OR
        (visibility = 'project_shared'
          AND owner_agent_id IS NULL
          AND public.omni_source_contract_id_is_valid(workspace_id)
          AND public.omni_source_contract_id_is_valid(project_id)
          AND mission_id IS NULL)
        OR
        (visibility = 'workspace_shared'
          AND owner_agent_id IS NULL
          AND public.omni_source_contract_id_is_valid(workspace_id)
          AND project_id IS NULL AND mission_id IS NULL)
      ))
  ) NOT VALID;

ALTER TABLE public.omni_memory_graph_nodes
  VALIDATE CONSTRAINT omni_memory_graph_nodes_scope_v2_check;
ALTER TABLE public.omni_memory_graph_edges
  VALIDATE CONSTRAINT omni_memory_graph_edges_scope_v2_check;

DROP POLICY IF EXISTS omni_memory_graph_nodes_access_scope
  ON public.omni_memory_graph_nodes;
CREATE POLICY omni_memory_graph_nodes_access_scope
ON public.omni_memory_graph_nodes
AS RESTRICTIVE
FOR ALL
USING (
  public.omni_system_scope_enabled()
  OR (access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL)
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND EXISTS (
      SELECT 1 FROM public.omni_memories source_memory
      WHERE source_memory.tenant_id = omni_memory_graph_nodes.tenant_id
        AND source_memory.id = ANY(omni_memory_graph_nodes.memory_ids)
        AND public.omni_shared_memory_scope_v1_allows(
          source_memory.id,
          omni_memory_graph_nodes.tenant_id,
          omni_memory_graph_nodes.workspace_id,
          omni_memory_graph_nodes.project_id,
          omni_memory_graph_nodes.visibility,
          omni_memory_graph_nodes.allowed_purpose_ids,
          octet_length(source_memory.title)::BIGINT +
            octet_length(source_memory.content)::BIGINT)))
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR (access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL)
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND EXISTS (
      SELECT 1 FROM public.omni_memories source_memory
      WHERE source_memory.tenant_id = omni_memory_graph_nodes.tenant_id
        AND source_memory.id = ANY(omni_memory_graph_nodes.memory_ids)
        AND public.omni_shared_memory_scope_v1_allows(
          source_memory.id,
          omni_memory_graph_nodes.tenant_id,
          omni_memory_graph_nodes.workspace_id,
          omni_memory_graph_nodes.project_id,
          omni_memory_graph_nodes.visibility,
          omni_memory_graph_nodes.allowed_purpose_ids,
          octet_length(source_memory.title)::BIGINT +
            octet_length(source_memory.content)::BIGINT)))
);

DROP POLICY IF EXISTS omni_memory_graph_edges_access_scope
  ON public.omni_memory_graph_edges;
CREATE POLICY omni_memory_graph_edges_access_scope
ON public.omni_memory_graph_edges
AS RESTRICTIVE
FOR ALL
USING (
  public.omni_system_scope_enabled()
  OR (access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL)
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND EXISTS (
      SELECT 1 FROM public.omni_memories source_memory
      WHERE source_memory.tenant_id = omni_memory_graph_edges.tenant_id
        AND source_memory.id = ANY(omni_memory_graph_edges.memory_ids)
        AND public.omni_shared_memory_scope_v1_allows(
          source_memory.id,
          omni_memory_graph_edges.tenant_id,
          omni_memory_graph_edges.workspace_id,
          omni_memory_graph_edges.project_id,
          omni_memory_graph_edges.visibility,
          omni_memory_graph_edges.allowed_purpose_ids,
          octet_length(source_memory.title)::BIGINT +
            octet_length(source_memory.content)::BIGINT)))
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR (access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL)
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids))
  OR (access_contract_version = 1 AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND EXISTS (
      SELECT 1 FROM public.omni_memories source_memory
      WHERE source_memory.tenant_id = omni_memory_graph_edges.tenant_id
        AND source_memory.id = ANY(omni_memory_graph_edges.memory_ids)
        AND public.omni_shared_memory_scope_v1_allows(
          source_memory.id,
          omni_memory_graph_edges.tenant_id,
          omni_memory_graph_edges.workspace_id,
          omni_memory_graph_edges.project_id,
          omni_memory_graph_edges.visibility,
          omni_memory_graph_edges.allowed_purpose_ids,
          octet_length(source_memory.title)::BIGINT +
            octet_length(source_memory.content)::BIGINT)))
);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_memory_graph_nodes'::regclass
      AND conname = 'omni_memory_graph_nodes_scope_v2_check'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_memory_graph_edges'::regclass
      AND conname = 'omni_memory_graph_edges_scope_v2_check'
      AND convalidated
  ) OR EXISTS (
    SELECT 1 FROM public.omni_memory_graph_nodes
    WHERE access_contract_version = 1
      AND visibility NOT IN (
        'user_private', 'agent_private', 'project_shared', 'workspace_shared'
      )
  ) OR EXISTS (
    SELECT 1 FROM public.omni_memory_graph_edges
    WHERE access_contract_version = 1
      AND visibility NOT IN (
        'user_private', 'agent_private', 'project_shared', 'workspace_shared'
      )
  ) THEN
    RAISE EXCEPTION 'memory_graph_scope_v2 verification failed';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (
  version, name, checksum, applied_at
) VALUES (
  152,
  'memory_graph_scope_v2',
  '80fb478914e814d44034b303b3bcf39e4f99c7f66f0240f114fe23e704ab29ae',
  NOW()
);

COMMIT;
