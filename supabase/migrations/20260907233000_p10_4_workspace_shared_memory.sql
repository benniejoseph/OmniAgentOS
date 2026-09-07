BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 129
      AND name = 'canonical_work_projection_repair_v1'
      AND checksum = '2caff999167ba65438fbef957b194e64b9556c203028995fbb316ed7ba310bfc'
  ) <> 1 THEN
    RAISE EXCEPTION 'Workspace shared memory predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_memories
  DROP CONSTRAINT IF EXISTS omni_memories_private_scope_v1_check;
ALTER TABLE omni_memories
  DROP CONSTRAINT IF EXISTS omni_memories_scope_v2_check;
ALTER TABLE omni_memories
  ADD CONSTRAINT omni_memories_scope_v2_check CHECK (
    access_contract_version = 0
    OR (
      access_contract_version = 1
      AND access_state = 'scope_bound'
      AND owner_actor_id IS NOT NULL
      AND (
        (visibility = 'user_private'
          AND owner_agent_id IS NULL
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL)
        OR
        (visibility = 'agent_private'
          AND owner_agent_id IS NOT NULL
          AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL
          AND tier IN ('working', 'episodic', 'semantic', 'procedural'))
        OR
        (visibility = 'project_shared'
          AND owner_agent_id IS NULL
          AND workspace_id IS NOT NULL AND project_id IS NOT NULL
          AND mission_id IS NULL)
        OR
        (visibility = 'workspace_shared'
          AND owner_agent_id IS NULL
          AND workspace_id IS NOT NULL AND project_id IS NULL
          AND mission_id IS NULL)
      )
    )
  ) NOT VALID;
ALTER TABLE omni_memories VALIDATE CONSTRAINT omni_memories_scope_v2_check;

CREATE OR REPLACE FUNCTION omni_shared_memory_scope_v1_allows(
  row_memory_id TEXT,
  row_tenant_id TEXT,
  row_workspace_id TEXT,
  row_project_id TEXT,
  row_visibility TEXT,
  row_allowed_purpose_ids TEXT[],
  row_byte_count BIGINT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  WITH access_scope AS (
    SELECT public.omni_current_memory_access_scope_v1() AS value
  ), authorized_scope AS (
    SELECT value
    FROM access_scope
    WHERE (value ->> 'tenantId') = row_tenant_id
      AND (value ->> 'workspaceId') = row_workspace_id
      AND value -> 'missionId' = 'null'::JSONB
      AND (value ->> 'purposeId') = ANY(row_allowed_purpose_ids)
      AND (
        (row_visibility = 'project_shared'
          AND (value ->> 'projectId') = row_project_id)
        OR
        (row_visibility = 'workspace_shared'
          AND row_project_id IS NULL
          AND value -> 'projectId' = 'null'::JSONB)
      )
  ), actor_membership AS (
    SELECT scope.value, workspace_membership.access_level
    FROM authorized_scope scope
    JOIN public.omni_tenant_workspace_memberships workspace_membership
      ON workspace_membership.tenant_id = row_tenant_id
      AND workspace_membership.workspace_id = row_workspace_id
      AND workspace_membership.subject_kind = 'user'
      AND workspace_membership.subject_actor_id =
        scope.value ->> 'initiatingActorId'
      AND workspace_membership.state = 'active'
    WHERE row_visibility = 'workspace_shared'
      OR EXISTS (
        SELECT 1
        FROM public.omni_work_project_memberships project_membership
        WHERE project_membership.tenant_id = row_tenant_id
          AND project_membership.workspace_id = row_workspace_id
          AND project_membership.project_id = row_project_id
          AND project_membership.subject_actor_id =
            scope.value ->> 'initiatingActorId'
          AND project_membership.state = 'active'
          AND project_membership.access_level IN ('reader', 'contributor', 'manager')
      )
  )
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM actor_membership membership
    WHERE (
      (membership.value ->> 'executingPrincipalType') = 'user'
      AND (membership.value ->> 'executingPrincipalId') =
        membership.value ->> 'initiatingActorId'
      AND (
        (membership.value ->> 'purposeId') IN (
          'memory.read.v1', 'memory.retrieve.v1', 'memory.export.v1'
        )
        OR membership.access_level IN ('contributor', 'manager')
      )
    ) OR (
      (membership.value ->> 'executingPrincipalType') = 'agent'
      AND EXISTS (
        SELECT 1
        FROM public.omni_tenant_execution_principals principal
        JOIN public.omni_tenant_memory_access_grants grant_record
          ON grant_record.tenant_id = principal.tenant_id
          AND grant_record.grantee_kind = 'agent'
          AND grant_record.grantee_execution_principal_id = principal.principal_id
          AND grant_record.grantee_execution_principal_generation =
            principal.principal_generation
        WHERE principal.tenant_id = row_tenant_id
          AND principal.principal_id =
            membership.value ->> 'executingPrincipalId'
          AND principal.controller_actor_id =
            membership.value ->> 'initiatingActorId'
          AND principal.state = 'active'
          AND grant_record.grant_kind = 'context'
          AND grant_record.grant_id =
            ANY(ARRAY(
              SELECT jsonb_array_elements_text(
                membership.value -> 'contextGrantIds'
              )
            ))
          AND grant_record.purpose_id = membership.value ->> 'purposeId'
          AND grant_record.target_visibility = row_visibility
          AND grant_record.owner_actor_id =
            membership.value ->> 'initiatingActorId'
          AND grant_record.workspace_id = row_workspace_id
          AND grant_record.project_id IS NOT DISTINCT FROM row_project_id
          AND grant_record.mission_id IS NULL
          AND row_memory_id = ANY(grant_record.resource_ids)
          AND grant_record.max_items >= 1
          AND grant_record.max_bytes >= row_byte_count
          AND grant_record.state = 'active'
          AND grant_record.lifecycle_revision = 1
          AND statement_timestamp() >= grant_record.not_before
          AND statement_timestamp() < grant_record.expires_at
      )
    )
  ), FALSE)
$function$;

REVOKE ALL ON FUNCTION omni_shared_memory_scope_v1_allows(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BIGINT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omni_shared_memory_scope_v1_allows(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BIGINT
) TO PUBLIC;

DROP POLICY IF EXISTS omni_memory_access_scope_holdback ON omni_memories;
CREATE POLICY omni_memory_access_scope_holdback
ON omni_memories
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
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND omni_shared_memory_scope_v1_allows(
      id, tenant_id, workspace_id, project_id, visibility,
      allowed_purpose_ids,
      octet_length(title)::BIGINT + octet_length(content)::BIGINT
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
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND omni_agent_private_memory_scope_v1_allows(
      tenant_id, owner_actor_id, owner_agent_id, allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND omni_shared_memory_scope_v1_allows(
      id, tenant_id, workspace_id, project_id, visibility,
      allowed_purpose_ids,
      octet_length(title)::BIGINT + octet_length(content)::BIGINT
    )
  )
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_memories'::regclass
      AND conname = 'omni_memories_scope_v2_check'
      AND contype = 'c' AND convalidated
  ) OR to_regprocedure(
    'public.omni_shared_memory_scope_v1_allows(text,text,text,text,text,text[],bigint)'
  ) IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_memories'::regclass
      AND polname = 'omni_memory_access_scope_holdback'
      AND NOT polpermissive
      AND pg_get_expr(polqual, polrelid) LIKE
        '%omni_shared_memory_scope_v1_allows%'
      AND pg_get_expr(polwithcheck, polrelid) LIKE
        '%omni_shared_memory_scope_v1_allows%'
  ) OR EXISTS (
    SELECT 1 FROM omni_memories
    WHERE access_contract_version = 1
      AND visibility IN ('project_shared', 'workspace_shared')
      AND (
        owner_actor_id IS NULL OR owner_agent_id IS NOT NULL
        OR workspace_id IS NULL OR mission_id IS NOT NULL
        OR (visibility = 'project_shared' AND project_id IS NULL)
        OR (visibility = 'workspace_shared' AND project_id IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'Workspace shared memory boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  130,
  'workspace_shared_memory_v1',
  'ef0d0f512b05dc2ca01585b1f939137dd626d9d20cdc9242b46f07110875e63e',
  NOW()
);

COMMIT;
