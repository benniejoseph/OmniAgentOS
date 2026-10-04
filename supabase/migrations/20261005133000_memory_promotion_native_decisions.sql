BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 226 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=226 AND name='customer_health_evaluation_intents_v1'
      AND checksum='d84ef7defa1802422dd887651f706bc169c0da90818dff5a05e061a4c3babc0d'
  ) <> 1 THEN RAISE EXCEPTION 'Memory promotion predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Legacy review decisions retain NULL. Source/target forget already deletes
-- this row, so exact native intent metadata shares the existing deletion
-- boundary. No token, source digest, or acceptance body is copied to events.
-- Rollback disables native ingress and preserves accepted review evidence.
ALTER TABLE public.omni_memory_promotion_reviews ADD COLUMN native_decision JSONB;
ALTER TABLE public.omni_memory_promotion_reviews ADD CONSTRAINT omni_memory_promotion_native_shape CHECK (
  native_decision IS NULL OR COALESCE((
    access_contract_version=1 AND status='resolved' AND jsonb_typeof(native_decision)='object'
    AND pg_column_size(native_decision)<=65536
    AND native_decision ?& ARRAY['intent','acceptance']
    AND native_decision - ARRAY['intent','acceptance'] = '{}'::JSONB
    AND jsonb_typeof(native_decision->'intent')='object' AND jsonb_typeof(native_decision->'acceptance')='object'
  ),FALSE)
);
CREATE UNIQUE INDEX omni_memory_promotion_native_key
  ON public.omni_memory_promotion_reviews(tenant_id,owner_actor_id,((native_decision->'intent'->>'idempotencyKeySha256')))
  WHERE native_decision IS NOT NULL;

-- A separate metadata reader grants neither maintenance authority nor access
-- to lifecycle contents. Existing parent locks serialize absent-row writers.
CREATE FUNCTION public.omni_memory_promotion_source_snapshot_v1(
  target_tenant TEXT,target_owner TEXT,target_ids TEXT[],lock_rows BOOLEAN
) RETURNS TABLE(memory_id TEXT,lifecycle_revision BIGINT,archived_at TIMESTAMPTZ,archive_reason TEXT,duplicate_of_memory_id TEXT,pinned_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE access_scope JSONB:=public.omni_current_memory_access_scope_v1();
  actor_scope JSONB:=public.omni_current_actor_scope_v1();
  previous_scope TEXT:=current_setting('omni.system_scope',true);
  previous_reason TEXT:=current_setting('omni.system_reason',true);
  target_count INTEGER; visible_count INTEGER;
BEGIN
  IF target_tenant IS NULL OR target_owner IS NULL OR target_ids IS NULL OR lock_rows IS NULL
    OR cardinality(target_ids) NOT BETWEEN 2 AND 50
    OR target_owner !~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR EXISTS(SELECT 1 FROM unnest(target_ids) value WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 200
      OR value !~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
    OR cardinality(target_ids) <> (SELECT count(DISTINCT value) FROM unnest(target_ids) value)
    OR current_setting('omni.tenant_id',true) IS DISTINCT FROM target_tenant
    OR public.omni_system_scope_enabled()
    OR NOT COALESCE(public.omni_actor_scope_v1_allows_validated(actor_scope,target_tenant,target_owner),false)
    OR NOT COALESCE(public.omni_user_private_memory_scope_v1_allows_validated(
      access_scope,target_tenant,target_owner,ARRAY['memory.read.v1','memory.write.v1']),false)
    OR access_scope->'contextGrantIds' IS DISTINCT FROM '[]'::JSONB
    OR access_scope->'capabilityGrantIds' IS DISTINCT FROM '[]'::JSONB
    OR (lock_rows AND access_scope->>'purposeId' IS DISTINCT FROM 'memory.write.v1')
  THEN RAISE EXCEPTION 'Current canonical private Memory authority is required' USING ERRCODE='42501'; END IF;
  target_count:=cardinality(target_ids);
  SELECT count(*) INTO visible_count FROM public.omni_memories memory
    WHERE memory.tenant_id=target_tenant AND memory.id=ANY(target_ids)
      AND memory.access_contract_version=1 AND memory.access_state='scope_bound'
      AND memory.visibility='user_private' AND memory.scope='user' AND memory.owner_actor_id=target_owner
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
      AND memory.visibility='user_private' AND memory.scope='user' AND memory.owner_actor_id=target_owner
      AND memory.owner_agent_id IS NULL AND memory.workspace_id IS NULL AND memory.project_id IS NULL AND memory.mission_id IS NULL
      AND memory.claim_status<>'forgotten' AND memory.forgotten_at IS NULL
      AND memory.allowed_purpose_ids @> ARRAY['memory.read.v1']::TEXT[]
      AND NOT public.omni_memory_ids_have_deletion_barrier(target_tenant,ARRAY[memory.id])
      AND public.omni_user_private_memory_scope_v1_allows_validated(access_scope,memory.tenant_id,memory.owner_actor_id,memory.allowed_purpose_ids);
  IF visible_count<>target_count THEN RAISE EXCEPTION 'Private Memory targets changed' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT memory.id,COALESCE(lifecycle.lifecycle_revision,0::BIGINT),lifecycle.archived_at,lifecycle.archive_reason,lifecycle.duplicate_of_memory_id,lifecycle.pinned_at
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

REVOKE ALL ON FUNCTION public.omni_memory_promotion_source_snapshot_v1(TEXT,TEXT,TEXT[],BOOLEAN) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_memory_promotion_source_snapshot_v1(TEXT,TEXT,TEXT[],BOOLEAN) TO %I',role_name);
    END IF;
  END LOOP;
END
$grants$;

CREATE FUNCTION public.omni_validate_memory_promotion_native_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE intent JSONB; acceptance JSONB; request JSONB; sources JSONB;
  access_scope JSONB:=public.omni_current_memory_access_scope_v1();
  source_count INTEGER; expected_count INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND OLD.native_decision IS NOT NULL THEN
    IF NEW.native_decision IS DISTINCT FROM OLD.native_decision THEN
      RAISE EXCEPTION 'Native Memory promotion acceptance is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.native_decision IS NULL THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' OR OLD.status<>'pending' OR NEW.status<>'resolved'
    OR NEW.access_contract_version<>1 OR NEW.owner_actor_id IS NULL
    OR access_scope->>'purposeId' IS DISTINCT FROM 'memory.write.v1'
    OR public.omni_system_scope_enabled()
    OR NOT COALESCE(public.omni_user_private_memory_scope_v1_allows_validated(
      access_scope,NEW.tenant_id,NEW.owner_actor_id,ARRAY['memory.write.v1']),FALSE)
  THEN RAISE EXCEPTION 'Native promotion requires current private write authority' USING ERRCODE='42501'; END IF;
  intent:=NEW.native_decision->'intent'; acceptance:=NEW.native_decision->'acceptance'; request:=intent->'request';
  sources:=acceptance->'sourceTargets';
  IF NOT COALESCE((
    jsonb_typeof(intent)='object' AND jsonb_typeof(acceptance)='object' AND jsonb_typeof(request)='object'
    AND intent ?& ARRAY['schemaVersion','tenantId','ownerActorId','idempotencyKeySha256','requestSha256','request']
    AND intent-ARRAY['schemaVersion','tenantId','ownerActorId','idempotencyKeySha256','requestSha256','request']='{}'::JSONB
    AND intent->'schemaVersion'='1'::JSONB
    AND intent->>'tenantId'=NEW.tenant_id AND intent->>'ownerActorId'=NEW.owner_actor_id
    AND intent->>'idempotencyKeySha256' ~ '^[a-f0-9]{64}$' AND intent->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND request ?& ARRAY['contract','reviewId','decision','expectedReviewToken','expectedPolicySha256','expectedSourceManifestSha256']
    AND request-ARRAY['contract','reviewId','decision','expectedReviewToken','expectedPolicySha256','expectedSourceManifestSha256']='{}'::JSONB
    AND request->>'contract'='asael-memory-promotion-decision:1' AND request->>'reviewId'=NEW.id AND request->>'decision'=NEW.decision
    AND request->>'expectedReviewToken' ~ '^[a-f0-9]{64}$'
    AND request->>'expectedPolicySha256' ~ '^[a-f0-9]{64}$' AND request->>'expectedSourceManifestSha256' ~ '^[a-f0-9]{64}$'
    AND acceptance ?& ARRAY['contract','id','tenantId','ownerActorId','reviewId','canonicalMemoryId','decision','idempotencyKeySha256','requestSha256','expectedReviewToken','policySha256','sourceManifestSha256','sourceTargets','promotedMemoryId','promotedTargetRevision','resolvedAt']
    AND acceptance-ARRAY['contract','id','tenantId','ownerActorId','reviewId','canonicalMemoryId','decision','idempotencyKeySha256','requestSha256','expectedReviewToken','policySha256','sourceManifestSha256','sourceTargets','promotedMemoryId','promotedTargetRevision','resolvedAt']='{}'::JSONB
    AND acceptance->>'contract'='asael-memory-promotion-acceptance:1'
    AND acceptance->>'id' ~ '^memory-promotion-acceptance:[a-f0-9]{64}$'
    AND acceptance->>'tenantId'=NEW.tenant_id AND acceptance->>'ownerActorId'=NEW.owner_actor_id
    AND acceptance->>'reviewId'=NEW.id AND acceptance->>'canonicalMemoryId'=NEW.canonical_memory_id
    AND acceptance->>'decision'=NEW.decision
    AND acceptance->>'idempotencyKeySha256'=intent->>'idempotencyKeySha256'
    AND acceptance->>'requestSha256'=intent->>'requestSha256'
    AND acceptance->>'expectedReviewToken'=request->>'expectedReviewToken'
    AND acceptance->>'policySha256'=request->>'expectedPolicySha256'
    AND acceptance->>'sourceManifestSha256'=request->>'expectedSourceManifestSha256'
    AND jsonb_typeof(sources)='array'
    AND (acceptance->>'promotedMemoryId') IS NOT DISTINCT FROM NEW.promoted_memory_id
    AND (acceptance->>'resolvedAt')::TIMESTAMPTZ IS NOT DISTINCT FROM NEW.resolved_at
    AND ((NEW.decision='dismiss' AND acceptance->'promotedMemoryId'='null'::JSONB AND acceptance->'promotedTargetRevision'='null'::JSONB)
      OR (NEW.decision='promote' AND jsonb_typeof(acceptance->'promotedTargetRevision')='number'
        AND acceptance->>'promotedTargetRevision' ~ '^[1-9][0-9]{0,15}$'
        AND EXISTS(SELECT 1 FROM public.omni_memories target WHERE target.tenant_id=NEW.tenant_id AND target.id=NEW.promoted_memory_id
          AND target.access_contract_version=1 AND target.visibility='user_private' AND target.scope='user' AND target.owner_actor_id=NEW.owner_actor_id
          AND target.owner_agent_id IS NULL AND target.workspace_id IS NULL AND target.project_id IS NULL AND target.mission_id IS NULL
          AND target.allowed_purpose_ids @> ARRAY['memory.read.v1','memory.write.v1']::TEXT[]
          AND target.lifecycle_target_revision::TEXT=acceptance->>'promotedTargetRevision')))
  ),FALSE) THEN RAISE EXCEPTION 'Native promotion receipt is inconsistent' USING ERRCODE='23514'; END IF;
  expected_count:=cardinality(NEW.source_memory_ids);
  IF expected_count NOT BETWEEN 2 AND 50 OR jsonb_array_length(sources)<>expected_count OR
    ARRAY(SELECT source_target.value->>'memoryId' FROM jsonb_array_elements(sources) AS source_target(value)) IS DISTINCT FROM NEW.source_memory_ids
  THEN RAISE EXCEPTION 'Native promotion source manifest is inconsistent' USING ERRCODE='23514'; END IF;
  -- The helper independently checks every current private read/write source,
  -- the deletion barrier, and parent locking before privileged metadata reads.
  SELECT count(*) INTO source_count
  FROM public.omni_memory_promotion_source_snapshot_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.source_memory_ids,TRUE) lifecycle
  JOIN public.omni_memories memory ON memory.tenant_id=NEW.tenant_id AND memory.id=lifecycle.memory_id
  JOIN jsonb_array_elements(sources) AS source_target(value) ON source_target.value->>'memoryId'=memory.id
  WHERE source_target.value ?& ARRAY['memoryId','claimStatus','targetRevision','lifecycleRevision','sourcePolicySha256']
    AND source_target.value-ARRAY['memoryId','claimStatus','targetRevision','lifecycleRevision','sourcePolicySha256']='{}'::JSONB
    AND source_target.value->>'claimStatus'=memory.claim_status
    AND source_target.value->>'targetRevision'=memory.lifecycle_target_revision::TEXT
    AND source_target.value->>'lifecycleRevision'=lifecycle.lifecycle_revision::TEXT
    AND source_target.value->>'sourcePolicySha256' ~ '^[a-f0-9]{64}$'
    AND (NEW.decision='dismiss' OR (
      (memory.valid_from IS NULL OR memory.valid_from<=statement_timestamp())
      AND (memory.valid_to IS NULL OR memory.valid_to>statement_timestamp())
      AND (memory.retention_expires_at IS NULL OR memory.retention_expires_at>statement_timestamp())
      AND (lifecycle.archived_at IS NULL OR (memory.id<>NEW.canonical_memory_id AND lifecycle.archive_reason='exact_duplicate'
        AND lifecycle.duplicate_of_memory_id=NEW.canonical_memory_id))
    ));
  IF source_count<>expected_count THEN
    RAISE EXCEPTION 'Native promotion source authority or revision changed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_validate_memory_promotion_native_v1() FROM PUBLIC;
CREATE TRIGGER aa_omni_memory_promotion_native_validate BEFORE INSERT OR UPDATE
ON public.omni_memory_promotion_reviews FOR EACH ROW EXECUTE FUNCTION public.omni_validate_memory_promotion_native_v1();

CREATE OR REPLACE FUNCTION omni_validate_memory_promotion_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  canonical_memory public.omni_memories%ROWTYPE;
  source_count INTEGER;
  occurrence_count INTEGER;
  promoted_count INTEGER;
BEGIN
  -- The preceding native trigger has validated exact private source authority
  -- and receipt pins. Dismissing stale evidence must not require that evidence
  -- still qualifies for promotion. Legacy dismiss retains its original checks.
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'resolved'
    AND NEW.decision = 'dismiss' AND OLD.native_decision IS NULL AND NEW.native_decision IS NOT NULL
  THEN
    IF NEW.promoted_memory_id IS NOT NULL OR ROW(
      OLD.id,OLD.tenant_id,OLD.access_contract_version,OLD.owner_actor_id,OLD.policy_version,
      OLD.source_memory_ids,OLD.canonical_memory_id,OLD.source_claim_sha256,OLD.target_tier,OLD.created_at
    ) IS DISTINCT FROM ROW(
      NEW.id,NEW.tenant_id,NEW.access_contract_version,NEW.owner_actor_id,NEW.policy_version,
      NEW.source_memory_ids,NEW.canonical_memory_id,NEW.source_claim_sha256,NEW.target_tier,NEW.created_at
    ) THEN RAISE EXCEPTION 'Memory promotion review is immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NOT public.omni_source_id_array_is_canonical(NEW.source_memory_ids, 64)
    OR cardinality(NEW.source_memory_ids) < 2
    OR NOT (NEW.canonical_memory_id = ANY(NEW.source_memory_ids))
  THEN
    RAISE EXCEPTION 'Memory promotion source ids are invalid'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO canonical_memory
  FROM public.omni_memories memory
  WHERE memory.id = NEW.canonical_memory_id
    AND memory.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory promotion canonical source is missing'
      USING ERRCODE = '23503';
  END IF;
  SELECT COUNT(*), COUNT(DISTINCT md5(
    memory.source || ':' || array_to_string(memory.evidence_refs, E'\x1f')
  ))
  INTO source_count, occurrence_count
  FROM public.omni_memories memory
  WHERE memory.tenant_id = NEW.tenant_id
    AND memory.id = ANY(NEW.source_memory_ids)
    AND memory.claim_status = 'active'
    AND memory.tier = 'episodic'
    AND memory.formation_reason IN (
      'explicit_user_request', 'canonical_source_observation', 'verified_effect'
    )
    AND memory.confidence >= 0.8
    AND cardinality(memory.evidence_refs) > 0
    AND memory.access_contract_version = NEW.access_contract_version
    AND memory.owner_actor_id IS NOT DISTINCT FROM NEW.owner_actor_id
    AND memory.type = canonical_memory.type
    AND memory.scope = canonical_memory.scope
    AND memory.tags = canonical_memory.tags
    AND memory.valid_from IS NOT DISTINCT FROM canonical_memory.valid_from
    AND memory.valid_to IS NOT DISTINCT FROM canonical_memory.valid_to
    AND memory.access_scope_sha256 IS NOT DISTINCT FROM canonical_memory.access_scope_sha256
    AND regexp_replace(lower(btrim(memory.title)), '\s+', ' ', 'g')
      = regexp_replace(lower(btrim(canonical_memory.title)), '\s+', ' ', 'g')
    AND regexp_replace(lower(btrim(memory.content)), '\s+', ' ', 'g')
      = regexp_replace(lower(btrim(canonical_memory.content)), '\s+', ' ', 'g');
  IF source_count <> cardinality(NEW.source_memory_ids)
    OR occurrence_count < 2
    OR canonical_memory.access_contract_version <> NEW.access_contract_version
    OR canonical_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR public.omni_memory_ids_have_deletion_barrier(
      NEW.tenant_id,
      NEW.source_memory_ids
    )
  THEN
    RAISE EXCEPTION 'Memory promotion evidence boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.promoted_memory_id IS NOT NULL THEN
    SELECT COUNT(*) INTO promoted_count
    FROM public.omni_memories memory
    WHERE memory.id = NEW.promoted_memory_id
      AND memory.tenant_id = NEW.tenant_id
      AND memory.claim_status = 'active'
      AND memory.tier = 'procedural'
      AND memory.formation_reason = 'maintenance_promotion'
      AND memory.promoted_from_tier = 'episodic'
      AND memory.access_contract_version = NEW.access_contract_version
      AND memory.owner_actor_id IS NOT DISTINCT FROM NEW.owner_actor_id
      AND NEW.source_memory_ids <@ ARRAY(
        SELECT substring(reference FROM 8)
        FROM unnest(memory.evidence_refs) reference
        WHERE reference LIKE 'memory:%'
      );
    IF promoted_count <> 1 THEN
      RAISE EXCEPTION 'Promoted memory lineage is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      OLD.id, OLD.tenant_id, OLD.access_contract_version,
      OLD.owner_actor_id, OLD.policy_version, OLD.source_memory_ids,
      OLD.canonical_memory_id, OLD.source_claim_sha256,
      OLD.target_tier, OLD.created_at
    ) IS DISTINCT FROM ROW(
      NEW.id, NEW.tenant_id, NEW.access_contract_version,
      NEW.owner_actor_id, NEW.policy_version, NEW.source_memory_ids,
      NEW.canonical_memory_id, NEW.source_claim_sha256,
      NEW.target_tier, NEW.created_at
    ) OR OLD.status = 'resolved' AND ROW(
      OLD.status, OLD.decision, OLD.promoted_memory_id, OLD.resolved_at
    ) IS DISTINCT FROM ROW(
      NEW.status, NEW.decision, NEW.promoted_memory_id, NEW.resolved_at
    ) THEN
      RAISE EXCEPTION 'Memory promotion review is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- Add only the ordinary private write purpose to review visibility/update.
-- Review creation/deletion and the lifecycle table retain maintenance-only
-- mutation policies. A write-scope update must carry the validated receipt.
DROP POLICY omni_memory_promotion_reviews_actor_scope ON public.omni_memory_promotion_reviews;
CREATE POLICY omni_memory_promotion_reviews_actor_scope ON public.omni_memory_promotion_reviews AS RESTRICTIVE FOR ALL
USING (public.omni_system_scope_enabled()
  OR (access_contract_version=0 AND (SELECT public.omni_current_memory_access_scope_v1()) IS NULL)
  OR (access_contract_version=1 AND public.omni_user_private_memory_scope_v1_allows_validated(
    (SELECT public.omni_current_memory_access_scope_v1()),tenant_id,owner_actor_id,
    ARRAY['memory.export.v1','memory.forget.v1','memory.maintenance.v1','memory.read.v1','memory.retrieve.v1','memory.write.v1']::TEXT[])))
WITH CHECK (public.omni_system_scope_enabled()
  OR (access_contract_version=0 AND (SELECT public.omni_current_memory_access_scope_v1()) IS NULL)
  OR (access_contract_version=1 AND public.omni_user_private_memory_scope_v1_allows_validated(
    (SELECT public.omni_current_memory_access_scope_v1()),tenant_id,owner_actor_id,
    ARRAY['memory.export.v1','memory.forget.v1','memory.maintenance.v1','memory.read.v1','memory.retrieve.v1','memory.write.v1']::TEXT[])));
DROP POLICY omni_memory_promotion_reviews_update_purpose ON public.omni_memory_promotion_reviews;
CREATE POLICY omni_memory_promotion_reviews_update_purpose ON public.omni_memory_promotion_reviews AS RESTRICTIVE FOR UPDATE
USING (public.omni_system_scope_enabled() OR access_contract_version=0
  OR (SELECT public.omni_current_memory_access_scope_v1())->>'purposeId' IN ('memory.maintenance.v1','memory.write.v1'))
WITH CHECK (public.omni_system_scope_enabled() OR access_contract_version=0
  OR (SELECT public.omni_current_memory_access_scope_v1())->>'purposeId'='memory.maintenance.v1'
  OR ((SELECT public.omni_current_memory_access_scope_v1())->>'purposeId'='memory.write.v1' AND native_decision IS NOT NULL));

INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(227,'memory_promotion_native_decisions_v1','bf9e9132d165e7fb1ddb6c51888e1c763231ba1eb5456d6f318930a2656d6780',clock_timestamp());
COMMIT;
