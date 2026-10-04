BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 233 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=233 AND name='native_private_memory_actions_v1'
      AND checksum='fc769e804833e1509948919af832c92057d4236de057e60c51c98f8fdf0f9150'
  )<>1 THEN RAISE EXCEPTION 'Private Memory maintenance/graph predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Memory and trace INSERT/UPDATE already share this statement-level fence.
-- Close lifecycle and trace-removal holes before any tuple is acquired, so a
-- complete reviewed source set cannot change between selection and commit.
CREATE TRIGGER omni_memory_lifecycle_graph_statement_lock BEFORE INSERT OR UPDATE OR DELETE
ON public.omni_memory_lifecycle_states FOR EACH STATEMENT EXECUTE FUNCTION public.omni_lock_memory_graph_for_statement();
CREATE TRIGGER omni_retrieval_traces_delete_graph_statement_lock BEFORE DELETE
ON public.omni_retrieval_traces FOR EACH STATEMENT EXECUTE FUNCTION public.omni_lock_memory_graph_for_statement();

-- Preserve the exact233 contract for its existing operations. A new closed
-- validator admits only the two deterministic owner-private operations; it
-- grants no Memory purpose, mutable receipt or generic execution authority.
ALTER FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB)
  RENAME TO omni_native_private_memory_action_valid_233_v1;
CREATE FUNCTION public.omni_native_private_memory_action_valid_v1(op TEXT,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN op IN ('knowledge.cognition.decide','knowledge.source.delete')
    THEN public.omni_native_private_memory_action_valid_233_v1(op,i,a)
    ELSE COALESCE(
      op IN ('memory.maintenance.run','memory.graph.rebuild')
      AND jsonb_typeof(i)='object' AND pg_column_size(i)<=32768
      AND i ?& ARRAY['contract','operation','scope','resourceId','keySha256','request']
      AND i-ARRAY['contract','operation','scope','resourceId','keySha256','request']='{}'::JSONB
      AND i->>'contract'='asael-private-memory-action-intent:1' AND i->>'operation'=op
      AND jsonb_typeof(i->'scope')='object' AND i->'scope' ?& ARRAY['tenantId','ownerActorId','canonicalActorId']
      AND (i->'scope')-ARRAY['tenantId','ownerActorId','canonicalActorId']='{}'::JSONB
      AND i->>'resourceId' ~ '^private-memory-action:[a-f0-9]{64}$' AND i->>'keySha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(i->'request')='object' AND i->'request' ?& ARRAY['contract','review']
      AND (i->'request')-ARRAY['contract','review']='{}'::JSONB
      AND jsonb_typeof(i->'request'->'review')='object'
      AND i->'request'->'review'->>'reviewSha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(a)='object' AND pg_column_size(a)<=32768
      AND a ?& ARRAY['contract','id','operation','scope','resourceId','keySha256','requestSha256','reviewSha256','acceptedAt','result','acceptanceSha256']
      AND a-ARRAY['contract','id','operation','scope','resourceId','keySha256','requestSha256','reviewSha256','acceptedAt','result','acceptanceSha256']='{}'::JSONB
      AND a->>'id' ~ '^private-action-acceptance:[a-f0-9]{64}$' AND a->>'operation'=op AND a->'scope'=i->'scope'
      AND a->>'resourceId'=i->>'resourceId' AND a->>'keySha256'=i->>'keySha256'
      AND a->>'reviewSha256'=i->'request'->'review'->>'reviewSha256' AND a->>'requestSha256' ~ '^[a-f0-9]{64}$'
      AND a->>'acceptanceSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(a->'acceptedAt')='string' AND jsonb_typeof(a->'result')='object'
      AND CASE op WHEN 'memory.maintenance.run' THEN
        i->'request'->>'contract'='asael-memory-maintenance-run:1' AND a->>'contract'='asael-memory-maintenance-acceptance:1'
        AND i->'request'->'review' ?& ARRAY['policyVersion','eligibleMemoryCount','inventorySha256','planSha256','policySha256','reviewSha256']
        AND (i->'request'->'review')-ARRAY['policyVersion','eligibleMemoryCount','inventorySha256','planSha256','policySha256','reviewSha256']='{}'::JSONB
        AND i->'request'->'review'->'policyVersion'='1'::JSONB
        AND i->'request'->'review'->>'inventorySha256' ~ '^[a-f0-9]{64}$'
        AND i->'request'->'review'->>'planSha256' ~ '^[a-f0-9]{64}$' AND i->'request'->'review'->>'policySha256' ~ '^[a-f0-9]{64}$'
        AND a->'result' ?& ARRAY['policyVersion','scanned','eligible','exactDuplicateGroups','autoArchivedDuplicates','pinnedDuplicateConflicts','promotionReviewsCreated','expiredArchived','duplicateRateBefore','duplicateRateAfter','duplicateRateTarget']
        AND (a->'result')-ARRAY['policyVersion','scanned','eligible','exactDuplicateGroups','autoArchivedDuplicates','pinnedDuplicateConflicts','promotionReviewsCreated','expiredArchived','duplicateRateBefore','duplicateRateAfter','duplicateRateTarget']='{}'::JSONB
        AND a->'result'->'policyVersion'='1'::JSONB AND a->'result'->'duplicateRateTarget'='0.01'::JSONB
        AND a->'result'->'scanned'=i->'request'->'review'->'eligibleMemoryCount'
        AND NOT EXISTS(SELECT 1 FROM (VALUES('scanned',500),('eligible',500),('exactDuplicateGroups',250),('autoArchivedDuplicates',500),
          ('pinnedDuplicateConflicts',500),('promotionReviewsCreated',250),('expiredArchived',500)) bound(field,maximum)
          WHERE jsonb_typeof(a->'result'->bound.field) IS DISTINCT FROM 'number'
            OR NOT COALESCE((a->'result'->>bound.field) ~ '^(0|[1-9][0-9]{0,2})$',FALSE)
            OR (a->'result'->bound.field)>to_jsonb(bound.maximum))
        AND NOT EXISTS(SELECT 1 FROM (VALUES('duplicateRateBefore'),('duplicateRateAfter')) rate(field)
          WHERE jsonb_typeof(a->'result'->rate.field) IS DISTINCT FROM 'number' OR (a->'result'->rate.field)<'0'::JSONB OR (a->'result'->rate.field)>'1'::JSONB)
      WHEN 'memory.graph.rebuild' THEN
        i->'request'->>'contract'='asael-memory-graph-rebuild:1' AND a->>'contract'='asael-memory-graph-rebuild-acceptance:1'
        AND i->'request'->'review' ?& ARRAY['memoryCount','traceCount','sourceManifestSha256','graphPolicySha256','reviewSha256']
        AND (i->'request'->'review')-ARRAY['memoryCount','traceCount','sourceManifestSha256','graphPolicySha256','reviewSha256']='{}'::JSONB
        AND i->'request'->'review'->>'sourceManifestSha256' ~ '^[a-f0-9]{64}$' AND i->'request'->'review'->>'graphPolicySha256' ~ '^[a-f0-9]{64}$'
        AND a->'result' ?& ARRAY['memoryCount','traceCount','nodeCount','edgeCount']
        AND (a->'result')-ARRAY['memoryCount','traceCount','nodeCount','edgeCount']='{}'::JSONB
        AND a->'result'->'memoryCount'=i->'request'->'review'->'memoryCount' AND a->'result'->'traceCount'=i->'request'->'review'->'traceCount'
        AND NOT EXISTS(SELECT 1 FROM (VALUES('memoryCount',2000),('traceCount',1000),('nodeCount',10000),('edgeCount',20000)) bound(field,maximum)
          WHERE jsonb_typeof(a->'result'->bound.field) IS DISTINCT FROM 'number'
            OR NOT COALESCE((a->'result'->>bound.field) ~ '^(0|[1-9][0-9]{0,4})$',FALSE)
            OR (a->'result'->bound.field)>to_jsonb(bound.maximum))
      ELSE FALSE END,FALSE) END
$function$;

ALTER TABLE public.omni_native_private_memory_actions DROP CONSTRAINT omni_native_private_memory_operation_check;
ALTER TABLE public.omni_native_private_memory_actions ADD CONSTRAINT omni_native_private_memory_operation_check
  CHECK(operation IN ('knowledge.cognition.decide','knowledge.source.delete','memory.maintenance.run','memory.graph.rebuild'));
ALTER TABLE public.omni_native_private_memory_actions DROP CONSTRAINT omni_native_private_memory_shape_check;
ALTER TABLE public.omni_native_private_memory_actions ADD CONSTRAINT omni_native_private_memory_shape_check
  CHECK(public.omni_native_private_memory_action_valid_v1(operation,intent,acceptance));
ALTER TABLE public.omni_native_private_memory_actions DROP CONSTRAINT omni_native_private_memory_binding_check;
ALTER TABLE public.omni_native_private_memory_actions ADD CONSTRAINT omni_native_private_memory_binding_check CHECK(COALESCE(
  intent->'scope'->>'tenantId'=tenant_id AND intent->'scope'->>'ownerActorId'=owner_actor_id
  AND intent->'scope'->>'canonicalActorId'=canonical_actor_id AND intent->>'resourceId'=resource_id
  AND intent->>'keySha256'=idempotency_key_sha256 AND acceptance->>'requestSha256'=request_sha256
  AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at
  AND CASE WHEN operation='knowledge.cognition.decide' THEN source_document_id IS NOT NULL
    AND cognition_review_id IS NOT NULL AND cognition_review_id=resource_id AND source_document_id=intent->'request'->'review'->>'documentId'
    AND CASE WHEN intent->'request'->>'decision'='confirm' THEN target_memory_id IS NOT NULL
      AND target_memory_id=acceptance->'result'->>'memoryId' ELSE target_memory_id IS NULL END
  WHEN operation IN ('knowledge.source.delete','memory.maintenance.run','memory.graph.rebuild') THEN
    source_document_id IS NULL AND cognition_review_id IS NULL AND target_memory_id IS NULL ELSE FALSE END,FALSE));

REVOKE ALL ON FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(234,'native_private_memory_maintenance_graph_v1','82472e8714f28c2dd3dd64e6ca856f99c5a8c132850b1da8d1e149d510f1a3a7',clock_timestamp());
COMMIT;
