BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 234 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=234 AND name='native_private_memory_maintenance_graph_v1'
      AND checksum='82472e8714f28c2dd3dd64e6ca856f99c5a8c132850b1da8d1e149d510f1a3a7'
  )<>1 THEN RAISE EXCEPTION 'Native cognition build predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- An immutable reviewed plan plus one durable claim per provider batch. Neither
-- receipt recovery nor an expired worker lease can authorize another attempt.
CREATE FUNCTION public.omni_native_cognition_build_valid_v1(i JSONB,a JSONB,p JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(i)='object' AND pg_column_size(i)<=16384
    AND i ?& ARRAY['contract','scope','documentId','keySha256','request'] AND i-ARRAY['contract','scope','documentId','keySha256','request']='{}'::JSONB
    AND i->>'contract'='asael-knowledge-cognition-build-intent:1'
    AND jsonb_typeof(i->'scope')='object' AND i->'scope' ?& ARRAY['tenantId','ownerActorId','canonicalActorId']
    AND (i->'scope')-ARRAY['tenantId','ownerActorId','canonicalActorId']='{}'::JSONB
    AND jsonb_typeof(i->'scope'->'tenantId')='string' AND jsonb_typeof(i->'scope'->'ownerActorId')='string' AND jsonb_typeof(i->'scope'->'canonicalActorId')='string'
    AND i->>'keySha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(i->'keySha256')='string'
    AND jsonb_typeof(i->'documentId')='string' AND length(i->>'documentId') BETWEEN 1 AND 320
    AND jsonb_typeof(i->'request')='object' AND i->'request' ?& ARRAY['contract','review'] AND (i->'request')-ARRAY['contract','review']='{}'::JSONB
    AND i->'request'->>'contract'='asael-knowledge-cognition-build:1'
    AND jsonb_typeof(i->'request'->'review')='object'
    AND i->'request'->'review' ?& ARRAY['documentId','sourceItemId','sourceRevisionId','sourcePolicySha256','retentionExpiresAt','generationId','sourcePlanSha256','batchCount','existingReviewCount','existingReviewManifestSha256','policySha256','reviewSha256']
    AND (i->'request'->'review')-ARRAY['documentId','sourceItemId','sourceRevisionId','sourcePolicySha256','retentionExpiresAt','generationId','sourcePlanSha256','batchCount','existingReviewCount','existingReviewManifestSha256','policySha256','reviewSha256']='{}'::JSONB
    AND i->'request'->'review'->>'documentId'=i->>'documentId'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['documentId','sourceItemId','sourceRevisionId']) k
      WHERE jsonb_typeof(i->'request'->'review'->k) IS DISTINCT FROM 'string'
        OR NOT COALESCE(char_length(i->'request'->'review'->>k) BETWEEN 1 AND 320
          AND (i->'request'->'review'->>k) ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$',FALSE))
    AND i->'request'->'review'->>'generationId' ~ '^cognition_generation_[a-f0-9]{48}$'
    AND jsonb_typeof(i->'request'->'review'->'retentionExpiresAt') IN ('string','null')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['sourcePolicySha256','sourcePlanSha256','existingReviewManifestSha256','policySha256','reviewSha256']) k
      WHERE jsonb_typeof(i->'request'->'review'->k) IS DISTINCT FROM 'string' OR NOT COALESCE((i->'request'->'review'->>k) ~ '^[a-f0-9]{64}$',FALSE))
    AND jsonb_typeof(a)='object' AND pg_column_size(a)<=16384
    AND a ?& ARRAY['contract','id','scope','documentId','keySha256','requestSha256','reviewSha256','sourcePlanSha256','operationJobId','totalBatches','reusedBatches','acceptedAt','acceptanceSha256']
    AND a-ARRAY['contract','id','scope','documentId','keySha256','requestSha256','reviewSha256','sourcePlanSha256','operationJobId','totalBatches','reusedBatches','acceptedAt','acceptanceSha256']='{}'::JSONB
    AND a->>'contract'='asael-knowledge-cognition-build-acceptance:1' AND a->>'id' ~ '^cognition-build-acceptance:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->>'documentId'=i->>'documentId' AND a->>'keySha256'=i->>'keySha256'
    AND a->>'reviewSha256'=i->'request'->'review'->>'reviewSha256' AND a->>'sourcePlanSha256'=i->'request'->'review'->>'sourcePlanSha256'
    AND a->'totalBatches'=i->'request'->'review'->'batchCount' AND a->'reusedBatches'=i->'request'->'review'->'existingReviewCount'
    AND jsonb_typeof(a->'requestSha256')='string' AND jsonb_typeof(a->'acceptanceSha256')='string'
    AND a->>'requestSha256' ~ '^[a-f0-9]{64}$' AND a->>'acceptanceSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(a->'acceptedAt')='string'
    AND jsonb_typeof(a->'operationJobId')='string' AND length(a->>'operationJobId') BETWEEN 1 AND 320
    AND CASE WHEN jsonb_typeof(p)='array' AND pg_column_size(p)<=1048576 THEN
      jsonb_array_length(p) BETWEEN 1 AND 2048 AND a->'totalBatches'=to_jsonb(jsonb_array_length(p))
      AND a->'reusedBatches'=to_jsonb((SELECT count(*)::INTEGER FROM jsonb_array_elements(p) b WHERE b->'reusedCandidateSha256'<>'null'::JSONB))
      AND (SELECT count(*) FROM jsonb_array_elements(p) b WHERE b->'reusedCandidateSha256'<>'null'::JSONB)<jsonb_array_length(p)
      AND (SELECT count(DISTINCT b->>'batchId') FROM jsonb_array_elements(p) b)=jsonb_array_length(p)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) WITH ORDINALITY AS entries(b,ordinal) WHERE
        jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT (b ?& ARRAY['batchId','batchIndex','batchInputSha256','reusedCandidateSha256'])
        OR b-ARRAY['batchId','batchIndex','batchInputSha256','reusedCandidateSha256']<>'{}'::JSONB
        OR NOT COALESCE(b->>'batchId' ~ '^cognition_batch_[a-f0-9]{48}$',FALSE) OR b->'batchIndex' IS DISTINCT FROM to_jsonb(ordinal-1)
        OR NOT COALESCE(b->>'batchInputSha256' ~ '^[a-f0-9]{64}$',FALSE)
        OR NOT COALESCE(b->'reusedCandidateSha256'='null'::JSONB OR jsonb_typeof(b->'reusedCandidateSha256')='string' AND b->>'reusedCandidateSha256' ~ '^[a-f0-9]{64}$',FALSE))
    ELSE FALSE END,FALSE)
$function$;

CREATE TABLE public.omni_knowledge_native_cognition_builds (
  id TEXT PRIMARY KEY CHECK(id ~ '^cognition-build-acceptance:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 120),owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  document_id TEXT NOT NULL REFERENCES public.omni_knowledge_documents(id) ON DELETE CASCADE,
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  source_plan_sha256 TEXT NOT NULL CHECK(source_plan_sha256 ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL,acceptance JSONB NOT NULL,plan JSONB NOT NULL,accepted_at TIMESTAMPTZ NOT NULL,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),UNIQUE(tenant_id,owner_actor_id,document_id,source_plan_sha256),
  CHECK(public.omni_native_cognition_build_valid_v1(intent,acceptance,plan)),
  CHECK(COALESCE(intent->'scope'->>'tenantId'=tenant_id AND intent->'scope'->>'ownerActorId'=owner_actor_id AND intent->'scope'->>'canonicalActorId'=canonical_actor_id
    AND intent->>'documentId'=document_id AND intent->>'keySha256'=idempotency_key_sha256 AND acceptance->>'id'=id
    AND acceptance->>'sourcePlanSha256'=source_plan_sha256 AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at,FALSE))
);
CREATE INDEX omni_native_cognition_build_document_idx ON public.omni_knowledge_native_cognition_builds(tenant_id,owner_actor_id,document_id);
CREATE TABLE public.omni_knowledge_native_cognition_effects (
  build_id TEXT NOT NULL REFERENCES public.omni_knowledge_native_cognition_builds(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,owner_actor_id TEXT NOT NULL,batch_id TEXT NOT NULL CHECK(batch_id ~ '^cognition_batch_[a-f0-9]{48}$'),
  batch_index INTEGER NOT NULL CHECK(batch_index BETWEEN 0 AND 2047),job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 320),
  claim_id UUID NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('started','committed')),
  candidate_id TEXT,candidate_sha256 TEXT CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),next_job_id TEXT,claimed_at TIMESTAMPTZ NOT NULL,committed_at TIMESTAMPTZ,
  PRIMARY KEY(build_id,batch_id),UNIQUE(build_id,batch_index),UNIQUE(build_id,job_id),
  -- Candidate retention must not erase the once-only provider claim. Its
  -- metadata remains held until the source document erases the whole build.
  CHECK(candidate_id IS NULL OR candidate_id=batch_id),CHECK(next_job_id IS NULL OR length(next_job_id) BETWEEN 1 AND 320),
  CHECK((state='started' AND candidate_id IS NULL AND candidate_sha256 IS NULL AND next_job_id IS NULL AND committed_at IS NULL)
    OR (state='committed' AND candidate_id IS NOT NULL AND candidate_sha256 IS NOT NULL AND committed_at IS NOT NULL AND committed_at>=claimed_at))
);
CREATE INDEX omni_native_cognition_effect_owner_idx ON public.omni_knowledge_native_cognition_effects(tenant_id,owner_actor_id,build_id);
CREATE INDEX omni_native_cognition_effect_candidate_idx ON public.omni_knowledge_native_cognition_effects(tenant_id,candidate_id) WHERE candidate_id IS NOT NULL;

CREATE FUNCTION public.omni_protect_native_cognition_build_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE previous_system TEXT:=current_setting('omni.system_scope',TRUE); previous_reason TEXT:=current_setting('omni.system_reason',TRUE); erased BOOLEAN;
BEGIN
  IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Native cognition build receipts are immutable' USING ERRCODE='55000'; END IF;
  PERFORM set_config('omni.system_scope','true',TRUE); PERFORM set_config('omni.system_reason','exact cognition source privacy closure',TRUE);
  SELECT NOT EXISTS(SELECT 1 FROM public.omni_knowledge_documents WHERE tenant_id=OLD.tenant_id AND id=OLD.document_id) INTO erased;
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  IF erased THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Native cognition build receipts are immutable' USING ERRCODE='55000';
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE); RAISE;
END
$function$;
CREATE TRIGGER omni_native_cognition_build_immutable BEFORE UPDATE OR DELETE ON public.omni_knowledge_native_cognition_builds
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_cognition_build_v1();
CREATE TRIGGER omni_native_cognition_build_no_truncate BEFORE TRUNCATE ON public.omni_knowledge_native_cognition_builds
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_cognition_build_v1();

CREATE FUNCTION public.omni_protect_native_cognition_effect_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE previous_system TEXT:=current_setting('omni.system_scope',TRUE); previous_reason TEXT:=current_setting('omni.system_reason',TRUE); erased BOOLEAN; parent_plan JSONB;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Native cognition claims cannot be truncated' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM set_config('omni.system_scope','true',TRUE); PERFORM set_config('omni.system_reason','exact cognition claim privacy closure',TRUE);
    SELECT NOT EXISTS(SELECT 1 FROM public.omni_knowledge_native_cognition_builds WHERE id=OLD.build_id AND tenant_id=OLD.tenant_id) INTO erased;
    PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
    IF erased THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Native cognition claim cannot be removed' USING ERRCODE='55000';
  END IF;
  IF NOT public.omni_actor_scope_v1_allows(NEW.tenant_id,NEW.owner_actor_id) THEN
    RAISE EXCEPTION 'Native cognition claim requires its exact owner scope' USING ERRCODE='42501'; END IF;
  SELECT plan INTO parent_plan FROM public.omni_knowledge_native_cognition_builds parent
    WHERE parent.id=NEW.build_id AND parent.tenant_id=NEW.tenant_id AND parent.owner_actor_id=NEW.owner_actor_id;
  IF parent_plan IS NULL OR parent_plan->NEW.batch_index->>'batchId' IS DISTINCT FROM NEW.batch_id
    OR parent_plan->NEW.batch_index->'reusedCandidateSha256' IS DISTINCT FROM 'null'::JSONB THEN
    RAISE EXCEPTION 'Native cognition claim parent is invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'started' THEN RAISE EXCEPTION 'A native cognition effect starts exactly once' USING ERRCODE='23514'; END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['state','candidate_id','candidate_sha256','next_job_id','committed_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','candidate_id','candidate_sha256','next_job_id','committed_at'])
    OR OLD.state<>'started' OR NEW.state<>'committed' OR NOT EXISTS(SELECT 1 FROM public.omni_knowledge_cognition_candidates candidate
      WHERE candidate.tenant_id=NEW.tenant_id AND candidate.owner_actor_id=NEW.owner_actor_id AND candidate.id=NEW.batch_id
        AND candidate.contract_sha256=NEW.candidate_sha256 AND candidate.batch_index=NEW.batch_index
        AND candidate.contract->>'batchInputSha256'=parent_plan->NEW.batch_index->>'batchInputSha256') THEN
    RAISE EXCEPTION 'Native cognition output does not settle its exact started claim' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE); RAISE;
END
$function$;
CREATE TRIGGER omni_native_cognition_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_knowledge_native_cognition_effects
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_cognition_effect_v1();
CREATE TRIGGER omni_native_cognition_effect_no_truncate BEFORE TRUNCATE ON public.omni_knowledge_native_cognition_effects
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_cognition_effect_v1();

DO $policies$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_knowledge_native_cognition_builds','omni_knowledge_native_cognition_effects'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id))',table_name);
    EXECUTE format('CREATE POLICY omni_native_cognition_build_actor ON public.%I AS RESTRICTIVE FOR ALL USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id)) WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
  END LOOP;
END
$policies$;
CREATE POLICY omni_native_cognition_build_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'knowledge.cognition.native.build.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'knowledge.cognition.native.build.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON FUNCTION public.omni_native_cognition_build_valid_v1(JSONB,JSONB,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_native_cognition_build_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_native_cognition_effect_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_knowledge_native_cognition_builds TO %I',role_name);
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.omni_knowledge_native_cognition_effects TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_cognition_build_valid_v1(JSONB,JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_knowledge_native_cognition_builds,public.omni_knowledge_native_cognition_effects TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(235,'native_knowledge_cognition_builds_v1','32970b0b3a66989751fc81f1a2ece1dbc357d8c569c3f3deed6b4df7d0851ae0',clock_timestamp());
COMMIT;
