CREATE OR REPLACE FUNCTION
  omni_user_private_memory_scope_v1_allows_validated(
    access_scope JSONB,
    row_tenant_id TEXT,
    row_owner_actor_id TEXT,
    row_allowed_purpose_ids TEXT[]
  )
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    jsonb_typeof(access_scope) = 'object'
    AND (access_scope ->> 'tenantId') = row_tenant_id
    AND (access_scope ->> 'initiatingActorId') = row_owner_actor_id
    AND (access_scope ->> 'executingPrincipalType') = 'user'
    AND (access_scope ->> 'executingPrincipalId') = row_owner_actor_id
    AND access_scope -> 'workspaceId' = 'null'::JSONB
    AND access_scope -> 'projectId' = 'null'::JSONB
    AND access_scope -> 'missionId' = 'null'::JSONB
    AND (access_scope ->> 'purposeId') = ANY(row_allowed_purpose_ids),
    FALSE
  )
$function$;
CREATE OR REPLACE FUNCTION omni_user_private_memory_scope_v1_allows(
  row_tenant_id TEXT,
  row_owner_actor_id TEXT,
  row_allowed_purpose_ids TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.omni_user_private_memory_scope_v1_allows_validated(
    public.omni_current_memory_access_scope_v1(),
    row_tenant_id,
    row_owner_actor_id,
    row_allowed_purpose_ids
  )
$function$;
REVOKE ALL ON FUNCTION
  omni_user_private_memory_scope_v1_allows_validated(
    JSONB, TEXT, TEXT, TEXT[]
  )
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  omni_user_private_memory_scope_v1_allows_validated(
    JSONB, TEXT, TEXT, TEXT[]
  )
TO PUBLIC;
DO $migration$
DECLARE
  policy_record RECORD;
BEGIN
  FOR policy_record IN
    SELECT * FROM (VALUES
      ('omni_memories', 'omni_memory_access_scope_holdback'),
      ('omni_retrieval_traces', 'omni_retrieval_trace_access_scope'),
      ('omni_memory_graph_nodes', 'omni_memory_graph_nodes_access_scope'),
      ('omni_memory_graph_edges', 'omni_memory_graph_edges_access_scope')
    ) AS policies(table_name, policy_name)
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      policy_record.policy_name,
      policy_record.table_name
    );
    EXECUTE format($policy$
      CREATE POLICY %I
      ON %I
      AS RESTRICTIVE
      FOR ALL
      USING (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND access_state = 'scope_bound'
          AND visibility = 'user_private'
          AND omni_user_private_memory_scope_v1_allows_validated(
            (SELECT omni_current_memory_access_scope_v1()),
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
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND access_state = 'scope_bound'
          AND visibility = 'user_private'
          AND omni_user_private_memory_scope_v1_allows_validated(
            (SELECT omni_current_memory_access_scope_v1()),
            tenant_id,
            owner_actor_id,
            allowed_purpose_ids
          )
        )
      )
    $policy$, policy_record.policy_name, policy_record.table_name);
  END LOOP;
END
$migration$;
DROP POLICY IF EXISTS omni_memory_user_private_insert_purpose
ON omni_memories;
CREATE POLICY omni_memory_user_private_insert_purpose
ON omni_memories
AS RESTRICTIVE
FOR INSERT
WITH CHECK (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
  )
  OR (
    access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
      'memory.write.v1',
      'memory.correct.v1',
      'memory.formation.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_user_private_update_purpose
ON omni_memories;
CREATE POLICY omni_memory_user_private_update_purpose
ON omni_memories
AS RESTRICTIVE
FOR UPDATE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
  )
  OR (
    access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
      'memory.write.v1',
      'memory.correct.v1',
      'memory.forget.v1',
      'memory.maintenance.v1'
    )
  )
)
WITH CHECK (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
  )
  OR (
    access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
      'memory.write.v1',
      'memory.correct.v1',
      'memory.forget.v1',
      'memory.maintenance.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_user_private_delete_purpose
ON omni_memories;
CREATE POLICY omni_memory_user_private_delete_purpose
ON omni_memories
AS RESTRICTIVE
FOR DELETE
USING (
  omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
  )
  OR (
    access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
      'memory.forget.v1',
      'memory.maintenance.v1'
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
    AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
  )
  OR (
    access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
      = 'memory.retrieve.v1'
  )
);
DO $migration$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_memory_graph_nodes',
    'omni_memory_graph_edges'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_insert_purpose',
      table_name
    );
    EXECUTE format($policy$
      CREATE POLICY %I
      ON %I
      AS RESTRICTIVE
      FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
            'memory.write.v1',
            'memory.correct.v1'
          )
        )
      )
    $policy$, table_name || '_insert_purpose', table_name);

    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_update_purpose',
      table_name
    );
    EXECUTE format($policy$
      CREATE POLICY %I
      ON %I
      AS RESTRICTIVE
      FOR UPDATE
      USING (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
            'memory.write.v1',
            'memory.correct.v1'
          )
        )
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' IN (
            'memory.write.v1',
            'memory.correct.v1'
          )
        )
      )
    $policy$, table_name || '_update_purpose', table_name);

    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_delete_purpose',
      table_name
    );
    EXECUTE format($policy$
      CREATE POLICY %I
      ON %I
      AS RESTRICTIVE
      FOR DELETE
      USING (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
            = 'memory.forget.v1'
        )
      )
    $policy$, table_name || '_delete_purpose', table_name);
  END LOOP;
END
$migration$;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
SELECT
  80,
  'memory_access_scope_initplan_policies',
  'bf42db947ea5b5382b3be6917cebb515d40ed260aa1365237aad62039203a290',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM omni_schema_version WHERE version = 80
);
