BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 222 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=222 AND name='memory_lifecycle_mutations_v1'
      AND checksum='35264a49f7eaf88153a1e83f1a35e6baa7933c21277977c6c5442d5341677a1b'
  ) <> 1 THEN RAISE EXCEPTION 'Memory reconciliation predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Every old and new lifecycle writer now shares the parent Memory lock.
-- This covers an absent lifecycle row, which a row lock on lifecycle alone
-- cannot fence. It confers no new lifecycle mutation purpose or table grant.
CREATE FUNCTION public.omni_memory_lifecycle_parent_lock_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE previous_scope TEXT:=current_setting('omni.system_scope',true);
  previous_reason TEXT:=current_setting('omni.system_reason',true);
  old_tenant TEXT; old_id TEXT; new_tenant TEXT; new_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_tenant:=OLD.tenant_id; old_id:=OLD.memory_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_tenant:=NEW.tenant_id; new_id:=NEW.memory_id; END IF;
  PERFORM set_config('omni.system_scope','true',true);
  PERFORM set_config('omni.system_reason','serialize exact Memory lifecycle parent',true);
  PERFORM memory.id FROM public.omni_memories memory
    WHERE (memory.tenant_id=old_tenant AND memory.id=old_id)
      OR (memory.tenant_id=new_tenant AND memory.id=new_id)
    ORDER BY memory.tenant_id,memory.id FOR UPDATE;
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
  RAISE;
END
$function$;
CREATE TRIGGER aa_omni_memory_lifecycle_parent_lock BEFORE INSERT OR UPDATE OR DELETE
ON public.omni_memory_lifecycle_states FOR EACH ROW EXECUTE FUNCTION public.omni_memory_lifecycle_parent_lock_v1();
REVOKE ALL ON FUNCTION public.omni_memory_lifecycle_parent_lock_v1() FROM PUBLIC;

-- Correct scope intentionally cannot read the lifecycle table. Expose only
-- its counter after current canonical read/correct authority and every exact
-- target have passed the existing private Memory boundary. Correct-mode
-- snapshots retain the parent locks until the accepting transaction commits.
CREATE FUNCTION public.omni_memory_reconciliation_lifecycle_snapshot_v1(
  target_tenant TEXT,target_owner TEXT,target_ids TEXT[],lock_rows BOOLEAN
) RETURNS TABLE(memory_id TEXT,lifecycle_revision BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE access_scope JSONB:=public.omni_current_memory_access_scope_v1();
  actor_scope JSONB:=public.omni_current_actor_scope_v1();
  previous_scope TEXT:=current_setting('omni.system_scope',true);
  previous_reason TEXT:=current_setting('omni.system_reason',true);
  target_count INTEGER; visible_count INTEGER;
BEGIN
  IF target_tenant IS NULL OR target_owner IS NULL OR target_ids IS NULL OR lock_rows IS NULL
    OR cardinality(target_ids) NOT BETWEEN 1 AND 2
    OR target_owner !~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR EXISTS(SELECT 1 FROM unnest(target_ids) value WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 200
      OR value !~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
    OR cardinality(target_ids) <> (SELECT count(DISTINCT value) FROM unnest(target_ids) value)
    OR current_setting('omni.tenant_id',true) IS DISTINCT FROM target_tenant
    OR public.omni_system_scope_enabled()
    OR NOT COALESCE(public.omni_actor_scope_v1_allows_validated(actor_scope,target_tenant,target_owner),false)
    OR NOT COALESCE(public.omni_user_private_memory_scope_v1_allows_validated(
      access_scope,target_tenant,target_owner,ARRAY['memory.read.v1','memory.correct.v1']),false)
    OR access_scope->'contextGrantIds' IS DISTINCT FROM '[]'::JSONB
    OR access_scope->'capabilityGrantIds' IS DISTINCT FROM '[]'::JSONB
    OR (lock_rows AND access_scope->>'purposeId' IS DISTINCT FROM 'memory.correct.v1')
  THEN RAISE EXCEPTION 'Current canonical private Memory authority is required' USING ERRCODE='42501'; END IF;
  target_count:=cardinality(target_ids);
  SELECT count(*) INTO visible_count FROM public.omni_memories memory
    WHERE memory.tenant_id=target_tenant AND memory.id=ANY(target_ids)
      AND memory.access_contract_version=1 AND memory.access_state='scope_bound'
      AND memory.visibility='user_private' AND memory.owner_actor_id=target_owner
      AND memory.owner_agent_id IS NULL AND memory.workspace_id IS NULL AND memory.project_id IS NULL AND memory.mission_id IS NULL
      AND memory.claim_status<>'forgotten' AND memory.forgotten_at IS NULL
      AND memory.allowed_purpose_ids @> ARRAY['memory.read.v1']::TEXT[]
      AND NOT public.omni_memory_ids_have_deletion_barrier(target_tenant,ARRAY[memory.id])
      AND public.omni_user_private_memory_scope_v1_allows_validated(access_scope,memory.tenant_id,memory.owner_actor_id,memory.allowed_purpose_ids);
  IF visible_count<>target_count THEN RAISE EXCEPTION 'Private Memory targets are unavailable' USING ERRCODE='42501'; END IF;
  PERFORM set_config('omni.system_scope','true',true);
  PERFORM set_config('omni.system_reason','read exact Memory lifecycle revision metadata',true);
  IF lock_rows THEN
    PERFORM memory.id FROM public.omni_memories memory
      WHERE memory.tenant_id=target_tenant AND memory.id=ANY(target_ids) ORDER BY memory.id FOR UPDATE;
  END IF;
  -- Revalidate after acquiring locks: a concurrent correction/forget or scope
  -- change before the lock must never turn a preflight read into authority.
  SELECT count(*) INTO visible_count FROM public.omni_memories memory
    WHERE memory.tenant_id=target_tenant AND memory.id=ANY(target_ids)
      AND memory.access_contract_version=1 AND memory.access_state='scope_bound'
      AND memory.visibility='user_private' AND memory.owner_actor_id=target_owner
      AND memory.owner_agent_id IS NULL AND memory.workspace_id IS NULL AND memory.project_id IS NULL AND memory.mission_id IS NULL
      AND memory.claim_status<>'forgotten' AND memory.forgotten_at IS NULL
      AND memory.allowed_purpose_ids @> ARRAY['memory.read.v1']::TEXT[]
      AND NOT public.omni_memory_ids_have_deletion_barrier(target_tenant,ARRAY[memory.id])
      AND public.omni_user_private_memory_scope_v1_allows_validated(access_scope,memory.tenant_id,memory.owner_actor_id,memory.allowed_purpose_ids);
  IF visible_count<>target_count THEN RAISE EXCEPTION 'Private Memory targets changed' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT memory.id,COALESCE(lifecycle.lifecycle_revision,0::BIGINT)
    FROM public.omni_memories memory LEFT JOIN public.omni_memory_lifecycle_states lifecycle
      ON lifecycle.tenant_id=memory.tenant_id AND lifecycle.memory_id=memory.id
      AND lifecycle.access_contract_version=1 AND lifecycle.owner_actor_id=target_owner
    WHERE memory.tenant_id=target_tenant AND memory.id=ANY(target_ids) ORDER BY memory.id;
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
  RAISE;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_memory_reconciliation_lifecycle_snapshot_v1(TEXT,TEXT,TEXT[],BOOLEAN) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_memory_reconciliation_lifecycle_snapshot_v1(TEXT,TEXT,TEXT[],BOOLEAN) TO %I',role_name);
    END IF;
  END LOOP;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(223,'memory_reconciliation_native_fences_v1','c6eb6a4e6550aa5585b2c15fd417e8fca797b232b9dc12d25459e9ebcf08b27a',clock_timestamp());
COMMIT;
