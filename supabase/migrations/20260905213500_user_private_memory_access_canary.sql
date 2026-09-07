DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.omni_memories WHERE access_contract_version <> 0
  ) THEN
    RAISE EXCEPTION 'User-private memory canary requires an empty bound-memory cohort'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;
ALTER TABLE public.omni_memories
DROP CONSTRAINT IF EXISTS omni_memories_access_enrollment_hold_check;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'omni_memories_user_private_canary_check'
      AND conrelid = 'public.omni_memories'::regclass
  ) THEN
    ALTER TABLE public.omni_memories
    ADD CONSTRAINT omni_memories_user_private_canary_check CHECK (
      access_contract_version = 0
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND visibility = 'user_private'
        AND owner_actor_id IS NOT NULL
        AND owner_agent_id IS NULL
        AND workspace_id IS NULL
        AND project_id IS NULL
        AND mission_id IS NULL
      )
    ) NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE public.omni_memories
VALIDATE CONSTRAINT omni_memories_user_private_canary_check;
CREATE OR REPLACE FUNCTION public.omni_user_private_memory_scope_v1_allows(
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
  WITH access_scope AS (
    SELECT public.omni_current_memory_access_scope_v1() AS value
  )
  SELECT COALESCE(
    (value ->> 'tenantId') = row_tenant_id
    AND (value ->> 'initiatingActorId') = row_owner_actor_id
    AND (value ->> 'executingPrincipalType') = 'user'
    AND (value ->> 'executingPrincipalId') = row_owner_actor_id
    AND value -> 'workspaceId' = 'null'::JSONB
    AND value -> 'projectId' = 'null'::JSONB
    AND value -> 'missionId' = 'null'::JSONB
    AND (value ->> 'purposeId') = ANY(row_allowed_purpose_ids),
    FALSE
  )
  FROM access_scope
$function$;
REVOKE ALL ON FUNCTION public.omni_memory_access_scope_v1_is_valid(JSONB)
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_current_memory_access_scope_v1()
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_user_private_memory_scope_v1_allows(
  TEXT, TEXT, TEXT[]
)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.omni_memory_access_scope_v1_is_valid(JSONB)
TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.omni_current_memory_access_scope_v1()
TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.omni_user_private_memory_scope_v1_allows(
  TEXT, TEXT, TEXT[]
)
TO PUBLIC;
DROP POLICY IF EXISTS omni_memory_access_scope_holdback
ON public.omni_memories;
CREATE POLICY omni_memory_access_scope_holdback
ON public.omni_memories
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
DROP POLICY IF EXISTS omni_memory_user_private_insert_purpose
ON public.omni_memories;
CREATE POLICY omni_memory_user_private_insert_purpose
ON public.omni_memories
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
      'memory.write.v1', 'memory.correct.v1', 'memory.formation.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_user_private_update_purpose
ON public.omni_memories;
CREATE POLICY omni_memory_user_private_update_purpose
ON public.omni_memories
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
      'memory.write.v1', 'memory.correct.v1', 'memory.forget.v1',
      'memory.maintenance.v1'
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
      'memory.write.v1', 'memory.correct.v1', 'memory.forget.v1',
      'memory.maintenance.v1'
    )
  )
);
DROP POLICY IF EXISTS omni_memory_user_private_delete_purpose
ON public.omni_memories;
CREATE POLICY omni_memory_user_private_delete_purpose
ON public.omni_memories
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
    AND omni_current_memory_access_scope_v1() ->> 'purposeId' IN (
      'memory.forget.v1', 'memory.maintenance.v1'
    )
  )
);
INSERT INTO public.omni_schema_version (
  version, name, checksum, applied_at
) VALUES (
  72,
  'user_private_memory_access_canary',
  '4cf4b3dc4549d5d8f05e19501f810462c2de6064a7bcc1dd27e7c97f6506f1bc',
  NOW()
);
