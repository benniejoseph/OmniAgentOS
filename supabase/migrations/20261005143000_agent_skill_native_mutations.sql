BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 228 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=228
      AND name='customer_workflow_native_intents_v1'
      AND checksum='8e550cb21de1a527a3d4227ecc2b7e4e968f62d96b14cb227fef73c782156ffc'
  ) <> 1 THEN RAISE EXCEPTION 'Native Agent/Skill predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Native only. Legacy Skill/Trash records are never adopted as an acceptance.
-- Rollback disables native ingress and retains immutable accepted evidence.
-- JSON canonical hashes are verified by the application, not JSONB text hashes.
CREATE TABLE public.omni_agent_skill_native_mutations (
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 240),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 240),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL CHECK(operation IN ('agent.delete','skill.create','skill.update','skill.delete')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('custom_agent','agent_skill')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL,
  acceptance JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK((operation='agent.delete')=(resource_type='custom_agent')),
  CHECK(COALESCE(
    jsonb_typeof(intent)='object' AND pg_column_size(intent)<=131072
    AND intent ?& ARRAY['contract','scope','operation','resourceId','keySha256','request']
    AND intent-ARRAY['contract','scope','operation','resourceId','keySha256','request']='{}'::JSONB
    AND intent->>'contract'='asael-agent-skill-intent:1'
    AND jsonb_typeof(intent->'scope')='object'
    AND intent->'scope' ?& ARRAY['tenantId','ownerActorId','canonicalActorId']
    AND (intent->'scope')-ARRAY['tenantId','ownerActorId','canonicalActorId']='{}'::JSONB
    AND intent->'scope'->>'tenantId'=tenant_id
    AND intent->'scope'->>'ownerActorId'=owner_actor_id
    AND intent->'scope'->>'canonicalActorId'=canonical_actor_id
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->>'operation'=operation
    AND jsonb_typeof(intent->'request')='object'
    AND CASE WHEN operation='skill.create' THEN intent->'resourceId'='null'::JSONB AND intent->'request'->>'contract'='asael-skill-create:1'
      ELSE intent->>'resourceId'=resource_id AND intent->'request'->'review'->>'resourceId'=resource_id
        AND intent->'request'->'review'->>'resourceType'=resource_type AND intent->'request'->'review'->>'operation'=operation
        AND intent->'request'->>'contract'=CASE WHEN operation='skill.update' THEN 'asael-skill-update:1' ELSE 'asael-agent-skill-delete:1' END END
  ,FALSE)),
  CHECK(COALESCE(
    jsonb_typeof(acceptance)='object' AND pg_column_size(acceptance)<=65536
    AND acceptance ?& ARRAY['contract','id','scope','operation','resourceType','resourceId','keySha256','requestSha256','reviewSha256',
      'beforeVersion','afterVersion','beforeResourceSha256','afterResourceSha256','affectedAgentIds','trash','acceptedAt','acceptanceSha256']
    AND acceptance-ARRAY['contract','id','scope','operation','resourceType','resourceId','keySha256','requestSha256','reviewSha256',
      'beforeVersion','afterVersion','beforeResourceSha256','afterResourceSha256','affectedAgentIds','trash','acceptedAt','acceptanceSha256']='{}'::JSONB
    AND acceptance->>'contract'='asael-agent-skill-acceptance:1'
    AND acceptance->>'id' ~ '^agent-skill-acceptance:[a-f0-9]{64}$'
    AND acceptance->'scope'=intent->'scope' AND acceptance->>'operation'=operation
    AND acceptance->>'resourceType'=resource_type AND acceptance->>'resourceId'=resource_id
    AND acceptance->>'keySha256'=idempotency_key_sha256 AND acceptance->>'requestSha256'=request_sha256
    AND acceptance->>'acceptanceSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(acceptance->'affectedAgentIds')='array' AND jsonb_array_length(acceptance->'affectedAgentIds')<=100
    AND jsonb_typeof(acceptance->'acceptedAt')='string' AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at
    AND CASE WHEN operation='skill.create' THEN
      acceptance->'reviewSha256'='null'::JSONB AND acceptance->'beforeVersion'='null'::JSONB
      AND acceptance->'beforeResourceSha256'='null'::JSONB AND acceptance->'afterVersion'='1'::JSONB
      AND acceptance->>'afterResourceSha256' ~ '^[a-f0-9]{64}$' AND acceptance->'trash'='null'::JSONB
    WHEN operation='skill.update' THEN
      acceptance->>'reviewSha256' ~ '^[a-f0-9]{64}$' AND acceptance->>'beforeResourceSha256' ~ '^[a-f0-9]{64}$'
      AND acceptance->>'afterResourceSha256' ~ '^[a-f0-9]{64}$' AND acceptance->'trash'='null'::JSONB
      AND CASE WHEN acceptance->>'beforeVersion' ~ '^[1-9][0-9]{0,9}$' AND acceptance->>'afterVersion' ~ '^[1-9][0-9]{0,9}$'
        THEN (acceptance->>'afterVersion')::BIGINT=(acceptance->>'beforeVersion')::BIGINT+1
          AND (acceptance->>'afterVersion')::BIGINT<=2147483647 ELSE FALSE END
    ELSE acceptance->>'reviewSha256' ~ '^[a-f0-9]{64}$' AND acceptance->>'beforeResourceSha256' ~ '^[a-f0-9]{64}$'
      AND acceptance->'afterVersion'='null'::JSONB AND acceptance->'afterResourceSha256'='null'::JSONB
      AND jsonb_typeof(acceptance->'trash')='object'
      AND acceptance->'trash'->>'targetSha256'=acceptance->>'reviewSha256'
      AND acceptance->'trash'->>'previewSha256'=intent->'request'->'preview'->>'previewSha256'
      AND acceptance->'trash'->>'receiptSha256' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN operation='agent.delete' THEN acceptance->'beforeVersion'='null'::JSONB AND acceptance->'trash'->>'compensation'='equivalent_action'
        ELSE acceptance->>'beforeVersion' ~ '^[1-9][0-9]{0,9}$' AND acceptance->'trash'->>'compensation'='exact_restore' END END
  ,FALSE))
);
CREATE INDEX omni_agent_skill_native_resource_idx ON public.omni_agent_skill_native_mutations(tenant_id,owner_actor_id,resource_type,resource_id,accepted_at DESC);
CREATE FUNCTION public.omni_agent_skill_native_immutable_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN RAISE EXCEPTION 'Native Agent/Skill acceptances are immutable' USING ERRCODE='55000'; END
$function$;
CREATE TRIGGER omni_agent_skill_native_immutable BEFORE UPDATE OR DELETE ON public.omni_agent_skill_native_mutations
FOR EACH ROW EXECUTE FUNCTION public.omni_agent_skill_native_immutable_v1();
CREATE TRIGGER omni_agent_skill_native_no_truncate BEFORE TRUNCATE ON public.omni_agent_skill_native_mutations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_agent_skill_native_immutable_v1();
ALTER TABLE public.omni_agent_skill_native_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_agent_skill_native_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_agent_skill_native_mutations AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_agent_skill_native_actor ON public.omni_agent_skill_native_mutations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_agent_skill_native_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type<>'agent_skill.native_mutation.accepted' OR (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type<>'agent_skill.native_mutation.accepted' OR (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));

-- The existing boundary checks remain. Hold the exact compatibility parent
-- before they inspect it so connection creation cannot race Agent deletion.
CREATE FUNCTION public.omni_lock_moltbook_agent_parent_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  PERFORM 1 FROM public.omni_custom_agents agent WHERE agent.tenant_id=NEW.tenant_id
    AND agent.actor_id=NEW.owner_actor_id AND agent.id=NEW.agent_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact Moltbook Agent parent is unavailable' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER aa_omni_moltbook_agent_parent_lock BEFORE INSERT OR UPDATE OF tenant_id,owner_actor_id,agent_id,
  principal_id,principal_generation,principal_sha256,definition_version,definition_sha256,policy_boundary_sha256
ON public.omni_moltbook_connections FOR EACH ROW EXECUTE FUNCTION public.omni_lock_moltbook_agent_parent_v1();
REVOKE ALL ON public.omni_agent_skill_native_mutations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_agent_skill_native_immutable_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_lock_moltbook_agent_parent_v1() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
    GRANT SELECT,INSERT ON public.omni_agent_skill_native_mutations TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_lock_moltbook_agent_parent_v1() TO omni_runtime;
    -- Existing Agent row CHECKs invoke this pure JSON validator. Its earlier
    -- PUBLIC revoke must not prevent the serving role from preserving them.
    GRANT EXECUTE ON FUNCTION public.omni_agent_persona_v1_is_valid(JSONB) TO omni_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.omni_lock_moltbook_agent_parent_v1() TO omni_maintenance;
    GRANT EXECUTE ON FUNCTION public.omni_agent_persona_v1_is_valid(JSONB) TO omni_maintenance;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_agent_skill_native_mutations TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(229,'agent_skill_native_mutations_v1','b2bf2d0724e57516e2d40cd378f21479d249743699ca0eabee6052a8770ac34d',clock_timestamp());
COMMIT;
