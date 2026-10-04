BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 232 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=232 AND name='salesforce_native_actions_v1'
      AND checksum='68250ab3f08534b5e9e1fffda2563281759eb6e2e7d416e3ad624cf60ff0dbd0'
  )<>1 THEN RAISE EXCEPTION 'Native private Memory predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Closed receipt storage: it grants no source purpose or executable authority.
-- Rollback disables native ingress and retains accepted history. Canonical JSON
-- digests are checked by domain code; JSONB serialization is not that algorithm.
-- The identity registry remains private. This closed boolean check pins only
-- the current alias/canonical pair and never publishes registry rows.
CREATE FUNCTION public.omni_native_private_memory_owner_v1(
  requested_tenant TEXT,requested_owner TEXT,requested_canonical TEXT,require_management BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF require_management IS NULL OR requested_tenant IS DISTINCT FROM public.omni_current_tenant()
    OR requested_tenant IS NULL OR length(requested_tenant) NOT BETWEEN 1 AND 120 OR requested_tenant<>btrim(requested_tenant)
    OR requested_owner IS NULL OR length(requested_owner) NOT BETWEEN 1 AND 320 OR requested_owner<>btrim(requested_owner)
    OR requested_canonical IS NULL OR requested_canonical !~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR COALESCE(public.omni_system_scope_enabled(),FALSE)
    OR NOT COALESCE(public.omni_actor_scope_v1_allows(requested_tenant,requested_owner),FALSE)
  THEN RETURN FALSE; END IF;
  PERFORM 1 FROM public.omni_auth_user_actor_identifiers identifier
    JOIN public.omni_auth_users u ON u.actor_id=identifier.canonical_actor_id AND u.status='active'
    JOIN public.omni_auth_memberships member ON member.user_id=u.id AND member.tenant_id=requested_tenant AND member.status='active'
    WHERE identifier.actor_identifier COLLATE "C"=requested_owner COLLATE "C" AND identifier.canonical_actor_id=requested_canonical
      AND (NOT require_management OR member.role IN ('operator','admin','system')) FOR SHARE OF identifier,u,member;
  RETURN FOUND;
END
$function$;
-- Metadata-only closure for exact owned connected sources. Application receipt
-- admission and this closed local retirement graph share one transaction.
CREATE FUNCTION public.omni_native_knowledge_deletion_lineage_v1(
  requested_tenant TEXT,requested_owner TEXT,requested_canonical TEXT,requested_prefix TEXT,
  requested_documents TEXT[],apply_retirement BOOLEAN,retired_at TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  previous_system TEXT:=current_setting('omni.system_scope',TRUE);
  previous_reason TEXT:=current_setting('omni.system_reason',TRUE);
  ids TEXT[]:='{}'; selected_trace_ids TEXT[]:='{}'; selected_node_ids TEXT[]:='{}'; selected_edge_ids TEXT[]:='{}';
  targets JSONB:='[]'; unsupported BOOLEAN:=FALSE; overflow BOOLEAN:=FALSE; result JSONB;
BEGIN
  IF requested_tenant IS DISTINCT FROM public.omni_current_tenant()
    OR requested_prefix IS NULL OR requested_prefix NOT IN ('google:','google:mail:','google:calendar:','google:drive:')
    OR requested_documents IS NULL OR cardinality(requested_documents)>500
    OR apply_retirement IS NULL OR retired_at IS NULL OR public.omni_current_memory_access_scope_v1() IS NOT NULL
    OR NOT COALESCE(public.omni_actor_scope_v1_allows(requested_tenant,requested_owner),FALSE)
    OR NOT COALESCE(public.omni_native_private_memory_owner_v1(requested_tenant,requested_owner,requested_canonical,apply_retirement),FALSE)
  THEN RAISE EXCEPTION 'Exact current connected-source owner is required' USING ERRCODE='42501'; END IF;
  IF (SELECT count(DISTINCT id) FROM unnest(requested_documents) id)<>cardinality(requested_documents)
    OR EXISTS(SELECT 1 FROM unnest(requested_documents) id WHERE id IS NULL OR length(id) NOT BETWEEN 1 AND 320)
  THEN RAISE EXCEPTION 'Invalid exact source document set' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory-graph:' || requested_tenant,0));
  PERFORM 1 FROM public.omni_knowledge_documents document
    JOIN public.omni_source_items item ON item.tenant_id=document.tenant_id AND item.id=document.source_item_id
    JOIN public.omni_source_revisions revision ON revision.tenant_id=document.tenant_id AND revision.id=document.source_revision_id AND revision.source_item_id=item.id
    WHERE document.tenant_id=requested_tenant AND document.id=ANY(requested_documents)
      AND starts_with(document.source,requested_prefix) AND item.owner_actor_id=requested_owner AND revision.owner_actor_id=requested_owner
      AND item.visibility='user_private' AND revision.visibility='user_private' FOR SHARE OF document,item,revision;
  IF (SELECT count(*) FROM public.omni_knowledge_documents document
    JOIN public.omni_source_items item ON item.tenant_id=document.tenant_id AND item.id=document.source_item_id
    JOIN public.omni_source_revisions revision ON revision.tenant_id=document.tenant_id AND revision.id=document.source_revision_id
      AND revision.source_item_id=item.id
    WHERE document.tenant_id=requested_tenant AND document.id=ANY(requested_documents)
      AND starts_with(document.source,requested_prefix) AND item.owner_actor_id=requested_owner AND revision.owner_actor_id=requested_owner
      AND item.visibility='user_private' AND revision.visibility='user_private')<>cardinality(requested_documents)
  THEN RAISE EXCEPTION 'Source deletion cannot include another owner or legacy document' USING ERRCODE='42501'; END IF;
  PERFORM set_config('omni.system_scope','true',TRUE);
  PERFORM set_config('omni.system_reason','exact private source deletion lineage',TRUE);
  WITH RECURSIVE lineage AS (
    SELECT m.id FROM public.omni_memories m WHERE m.tenant_id=requested_tenant AND m.claim_status<>'forgotten'
      AND EXISTS(SELECT 1 FROM unnest(requested_documents) document_id
        WHERE ('knowledge:' || document_id)=ANY(m.evidence_refs) OR starts_with(m.id,document_id || '_memory_'))
    UNION
    SELECT child.id FROM lineage JOIN public.omni_memories child ON child.tenant_id=requested_tenant AND child.claim_status<>'forgotten'
      AND (child.supersedes_id=lineage.id OR child.contradiction_of_id=lineage.id OR ('memory:' || lineage.id)=ANY(child.evidence_refs))
  ) SELECT COALESCE(array_agg(id ORDER BY id COLLATE "C"),'{}') INTO ids FROM (SELECT id FROM lineage LIMIT 2001) bounded;
  overflow:=cardinality(ids)>2000;
  IF NOT overflow THEN
    PERFORM 1 FROM public.omni_memories m WHERE m.tenant_id=requested_tenant AND m.id=ANY(ids) ORDER BY m.id COLLATE "C" FOR UPDATE;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'targetRevision',m.lifecycle_target_revision,
      'lifecycleRevision',COALESCE(lifecycle.lifecycle_revision,0),'accessScopeSha256',m.access_scope_sha256,'claimStatus',m.claim_status)
      ORDER BY m.id COLLATE "C"),'[]'::JSONB),
      COALESCE(bool_or(m.access_contract_version<>1 OR m.access_state<>'scope_bound' OR m.visibility<>'user_private'
        OR m.owner_actor_id IS DISTINCT FROM requested_canonical OR m.owner_agent_id IS NOT NULL OR m.workspace_id IS NOT NULL
        OR m.project_id IS NOT NULL OR m.mission_id IS NOT NULL OR m.scope<>'user'
        OR NOT COALESCE(ARRAY['memory.read.v1','memory.forget.v1']::TEXT[]<@m.allowed_purpose_ids,FALSE)),FALSE)
    INTO targets,unsupported FROM public.omni_memories m LEFT JOIN public.omni_memory_lifecycle_states lifecycle
      ON lifecycle.tenant_id=m.tenant_id AND lifecycle.memory_id=m.id WHERE m.tenant_id=requested_tenant AND m.id=ANY(ids);
    SELECT COALESCE(array_agg(id ORDER BY id COLLATE "C"),'{}') INTO selected_trace_ids FROM (
      SELECT trace.id FROM public.omni_retrieval_traces trace WHERE trace.tenant_id=requested_tenant AND (
        trace.memory_ids && ids OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(trace.results)='array' THEN trace.results ELSE '[]'::JSONB END) entry
          WHERE entry->>'kind'='memory' AND entry->>'id'=ANY(ids))) LIMIT 5001) bounded;
    SELECT COALESCE(array_agg(id ORDER BY id COLLATE "C"),'{}') INTO selected_node_ids FROM (
      SELECT node.id FROM public.omni_memory_graph_nodes node WHERE node.tenant_id=requested_tenant AND (node.memory_ids && ids OR node.trace_ids && selected_trace_ids) LIMIT 5001) bounded;
    SELECT COALESCE(array_agg(id ORDER BY id COLLATE "C"),'{}') INTO selected_edge_ids FROM (
      SELECT edge.id FROM public.omni_memory_graph_edges edge WHERE edge.tenant_id=requested_tenant AND (edge.memory_ids && ids OR edge.trace_ids && selected_trace_ids
        OR edge.source_node_id=ANY(selected_node_ids) OR edge.target_node_id=ANY(selected_node_ids)) LIMIT 5001) bounded;
    overflow:=cardinality(selected_trace_ids)>5000 OR cardinality(selected_node_ids)>5000 OR cardinality(selected_edge_ids)>5000;
  END IF;
  result:=jsonb_build_object('targets',targets,'retrievalTraceIds',selected_trace_ids,'graphNodeIds',selected_node_ids,'graphEdgeIds',selected_edge_ids,
    'unsupported',unsupported,'overflow',overflow);
  IF apply_retirement THEN
    IF unsupported OR overflow THEN RAISE EXCEPTION 'Source deletion lineage exceeds its reviewed authority or bounds' USING ERRCODE='42501'; END IF;
    UPDATE public.omni_memories m SET title='[retired]',content='',tags='{}',source='[retired]',embedding=NULL,embedding_vector=NULL,evidence_refs='{}',
      supersedes_id=NULL,contradiction_of_id=NULL,claim_status='superseded',valid_to=COALESCE(m.valid_to,retired_at),updated_at=retired_at
      WHERE m.tenant_id=requested_tenant AND m.id=ANY(ids) AND m.claim_status<>'forgotten';
    DELETE FROM public.omni_memory_graph_edges WHERE tenant_id=requested_tenant AND id=ANY(selected_edge_ids);
    DELETE FROM public.omni_memory_graph_nodes WHERE tenant_id=requested_tenant AND id=ANY(selected_node_ids);
    DELETE FROM public.omni_retrieval_traces WHERE tenant_id=requested_tenant AND id=ANY(selected_trace_ids);
  END IF;
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  RAISE;
END
$function$;

CREATE FUNCTION public.omni_native_private_memory_action_valid_v1(op TEXT,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(
    jsonb_typeof(i)='object' AND pg_column_size(i)<=32768
    AND i ?& ARRAY['contract','operation','scope','resourceId','keySha256','request']
    AND i-ARRAY['contract','operation','scope','resourceId','keySha256','request']='{}'::JSONB
    AND i->>'contract'='asael-private-memory-action-intent:1' AND i->>'operation'=op
    AND jsonb_typeof(i->'scope')='object' AND i->'scope' ?& ARRAY['tenantId','ownerActorId','canonicalActorId']
    AND (i->'scope')-ARRAY['tenantId','ownerActorId','canonicalActorId']='{}'::JSONB
    AND jsonb_typeof(i->'scope'->'tenantId')='string' AND jsonb_typeof(i->'scope'->'ownerActorId')='string'
    AND jsonb_typeof(i->'scope'->'canonicalActorId')='string' AND jsonb_typeof(i->'resourceId')='string'
    AND jsonb_typeof(i->'keySha256')='string'
    AND i->>'keySha256' ~ '^[a-f0-9]{64}$' AND length(i->>'resourceId') BETWEEN 1 AND 320
    AND jsonb_typeof(a)='object' AND pg_column_size(a)<=32768
    AND a ?& ARRAY['contract','id','operation','scope','resourceId','keySha256','requestSha256','reviewSha256','acceptedAt','result','acceptanceSha256']
    AND a-ARRAY['contract','id','operation','scope','resourceId','keySha256','requestSha256','reviewSha256','acceptedAt','result','acceptanceSha256']='{}'::JSONB
    AND a->>'id' ~ '^private-action-acceptance:[a-f0-9]{64}$' AND a->>'operation'=op
    AND a->'scope'=i->'scope' AND a->>'resourceId'=i->>'resourceId' AND a->>'keySha256'=i->>'keySha256'
    AND a->>'requestSha256' ~ '^[a-f0-9]{64}$' AND a->>'reviewSha256' ~ '^[a-f0-9]{64}$'
    AND a->>'acceptanceSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(a->'acceptedAt')='string'
    AND jsonb_typeof(a->'requestSha256')='string' AND jsonb_typeof(a->'reviewSha256')='string' AND jsonb_typeof(a->'acceptanceSha256')='string'
    AND jsonb_typeof(i->'request')='object' AND jsonb_typeof(i->'request'->'review')='object'
    AND a->>'reviewSha256'=i->'request'->'review'->>'reviewSha256'
    AND CASE op WHEN 'knowledge.cognition.decide' THEN
      a->>'contract'='asael-knowledge-cognition-acceptance:1'
      AND i->>'resourceId' ~ '^cognition_batch_[a-f0-9]{48}$'
      AND i->'request' ?& ARRAY['contract','decision','review']
      AND (i->'request')-ARRAY['contract','decision','review']='{}'::JSONB
      AND i->'request'->>'contract'='asael-knowledge-cognition-decision:1'
      AND i->'request'->>'decision' IN ('confirm','dismiss')
      AND i->'request'->'review' ?& ARRAY['candidateId','candidateSha256','documentId','sourceItemId','sourceRevisionId','sourcePolicySha256','retentionExpiresAt','reviewStateSha256','policySha256','reviewSha256']
      AND (i->'request'->'review')-ARRAY['candidateId','candidateSha256','documentId','sourceItemId','sourceRevisionId','sourcePolicySha256','retentionExpiresAt','reviewStateSha256','policySha256','reviewSha256']='{}'::JSONB
      AND i->'request'->'review'->>'candidateId'=i->>'resourceId'
      AND i->'request'->'review'->>'candidateSha256' ~ '^[a-f0-9]{64}$'
      AND i->'request'->'review'->>'sourcePolicySha256' ~ '^[a-f0-9]{64}$'
      AND i->'request'->'review'->>'reviewStateSha256' ~ '^[a-f0-9]{64}$'
      AND i->'request'->'review'->>'policySha256' ~ '^[a-f0-9]{64}$'
      AND (jsonb_typeof(i->'request'->'review'->'retentionExpiresAt') IN ('null','string'))
      AND jsonb_typeof(a->'result')='object' AND a->'result' ?& ARRAY['decision','status','memoryId','memoryTargetRevision']
      AND (a->'result')-ARRAY['decision','status','memoryId','memoryTargetRevision']='{}'::JSONB
      AND a->'result'->>'decision'=i->'request'->>'decision'
      AND CASE WHEN i->'request'->>'decision'='confirm' THEN
        a->'result'->>'status'='confirmed' AND a->'result'->>'memoryId'='memory:' || (i->>'resourceId')
        AND a->'result'->'memoryTargetRevision'='1'::JSONB
      ELSE a->'result'->>'status'='dismissed' AND a->'result'->'memoryId'='null'::JSONB
        AND a->'result'->'memoryTargetRevision'='null'::JSONB END
    WHEN 'knowledge.source.delete' THEN
      a->>'contract'='asael-knowledge-source-deletion-acceptance:1'
      AND i->>'resourceId' ~ '^knowledge_source_[a-f0-9]{64}$'
      AND i->'request' ?& ARRAY['contract','review'] AND (i->'request')-ARRAY['contract','review']='{}'::JSONB
      AND i->'request'->>'contract'='asael-knowledge-source-delete:1'
      AND i->'request'->'review' ?& ARRAY['sourceKind','documentCount','derivedMemoryCount','retrievalTraceCount','graphNodeCount','graphEdgeCount','manifestSha256','policySha256','reviewSha256']
      AND (i->'request'->'review')-ARRAY['sourceKind','documentCount','derivedMemoryCount','retrievalTraceCount','graphNodeCount','graphEdgeCount','manifestSha256','policySha256','reviewSha256']='{}'::JSONB
      AND i->'request'->'review'->>'sourceKind' IN ('google','mail','calendar','drive')
      AND i->'request'->'review'->>'manifestSha256' ~ '^[a-f0-9]{64}$'
      AND i->'request'->'review'->>'policySha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(a->'result')='object'
      AND a->'result' ?& ARRAY['sourceKind','localOnly','manifestSha256','documents','memories','retrievalTraces','graphNodes','graphEdges']
      AND (a->'result')-ARRAY['sourceKind','localOnly','manifestSha256','documents','memories','retrievalTraces','graphNodes','graphEdges']='{}'::JSONB
      AND a->'result'->>'sourceKind'=i->'request'->'review'->>'sourceKind' AND a->'result'->'localOnly'='true'::JSONB
      AND a->'result'->>'manifestSha256'=i->'request'->'review'->>'manifestSha256'
      AND NOT EXISTS(SELECT 1 FROM (VALUES ('documentCount','documents',500),('derivedMemoryCount','memories',2000),
          ('retrievalTraceCount','retrievalTraces',5000),('graphNodeCount','graphNodes',5000),('graphEdgeCount','graphEdges',5000)) bound(pin_key,result_key,maximum)
        WHERE jsonb_typeof(i->'request'->'review'->bound.pin_key) IS DISTINCT FROM 'number'
          OR NOT COALESCE((i->'request'->'review'->>bound.pin_key) ~ '^(0|[1-9][0-9]{0,3})$',FALSE)
          OR (i->'request'->'review'->bound.pin_key)>'5000'::JSONB
          OR (i->'request'->'review'->bound.pin_key)>to_jsonb(bound.maximum)
          OR (a->'result'->bound.result_key) IS DISTINCT FROM (i->'request'->'review'->bound.pin_key))
    ELSE FALSE END
  ,FALSE)
$function$;

CREATE TABLE public.omni_native_private_memory_actions (
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 120),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL CONSTRAINT omni_native_private_memory_operation_check CHECK(operation IN ('knowledge.cognition.decide','knowledge.source.delete')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 320),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL, acceptance JSONB NOT NULL,
  source_document_id TEXT REFERENCES public.omni_knowledge_documents(id) ON DELETE CASCADE,
  cognition_review_id TEXT,
  target_memory_id TEXT REFERENCES public.omni_memories(id) ON DELETE CASCADE,
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,owner_actor_id,idempotency_key_sha256),
  FOREIGN KEY(tenant_id,cognition_review_id) REFERENCES public.omni_knowledge_cognition_candidates(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT omni_native_private_memory_shape_check CHECK(public.omni_native_private_memory_action_valid_v1(operation,intent,acceptance)),
  CONSTRAINT omni_native_private_memory_binding_check CHECK(COALESCE(intent->'scope'->>'tenantId'=tenant_id AND intent->'scope'->>'ownerActorId'=owner_actor_id
    AND intent->'scope'->>'canonicalActorId'=canonical_actor_id AND intent->>'resourceId'=resource_id
    AND intent->>'keySha256'=idempotency_key_sha256 AND acceptance->>'requestSha256'=request_sha256
    AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at
    AND CASE WHEN operation='knowledge.cognition.decide' THEN source_document_id IS NOT NULL
      AND cognition_review_id IS NOT NULL AND cognition_review_id=resource_id
      AND source_document_id=intent->'request'->'review'->>'documentId'
      AND CASE WHEN intent->'request'->>'decision'='confirm' THEN target_memory_id IS NOT NULL
        AND target_memory_id=acceptance->'result'->>'memoryId' ELSE target_memory_id IS NULL END
    WHEN operation='knowledge.source.delete' THEN source_document_id IS NULL AND cognition_review_id IS NULL AND target_memory_id IS NULL
    ELSE FALSE END,FALSE))
);
CREATE INDEX omni_native_private_memory_resource_idx ON public.omni_native_private_memory_actions(tenant_id,owner_actor_id,operation,resource_id,accepted_at DESC);
CREATE INDEX omni_native_private_memory_document_idx ON public.omni_native_private_memory_actions(source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX omni_native_private_memory_cognition_idx ON public.omni_native_private_memory_actions(tenant_id,cognition_review_id) WHERE cognition_review_id IS NOT NULL;
CREATE INDEX omni_native_private_memory_target_idx ON public.omni_native_private_memory_actions(target_memory_id) WHERE target_memory_id IS NOT NULL;

-- Delete is available only through exact source/Memory parent privacy closure.
-- SECURITY DEFINER observes real parent existence, not an RLS-hidden absence.
CREATE FUNCTION public.omni_native_private_memory_immutable_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  previous_system TEXT:=current_setting('omni.system_scope',TRUE);
  previous_reason TEXT:=current_setting('omni.system_reason',TRUE);
  parent_erased BOOLEAN:=FALSE;
BEGIN
  IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Native private Memory acceptances are immutable' USING ERRCODE='55000'; END IF;
  PERFORM set_config('omni.system_scope','true',TRUE);
  PERFORM set_config('omni.system_reason','exact private Memory acceptance parent closure',TRUE);
  SELECT (
    OLD.source_document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.omni_knowledge_documents d WHERE d.tenant_id=OLD.tenant_id AND d.id=OLD.source_document_id)
    OR OLD.cognition_review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.omni_knowledge_cognition_candidates c WHERE c.tenant_id=OLD.tenant_id AND c.id=OLD.cognition_review_id)
    OR OLD.target_memory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.omni_memories m WHERE m.tenant_id=OLD.tenant_id AND m.id=OLD.target_memory_id AND m.claim_status<>'forgotten')
  ) INTO parent_erased;
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  IF parent_erased THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Native private Memory acceptances are immutable' USING ERRCODE='55000';
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  RAISE;
END
$function$;
CREATE TRIGGER omni_native_private_memory_immutable BEFORE UPDATE OR DELETE ON public.omni_native_private_memory_actions
FOR EACH ROW EXECUTE FUNCTION public.omni_native_private_memory_immutable_v1();
CREATE TRIGGER omni_native_private_memory_no_truncate BEFORE TRUNCATE ON public.omni_native_private_memory_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_native_private_memory_immutable_v1();
CREATE FUNCTION public.omni_native_private_memory_forget_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  previous_system TEXT:=current_setting('omni.system_scope',TRUE);
  previous_reason TEXT:=current_setting('omni.system_reason',TRUE);
BEGIN
  IF NEW.claim_status='forgotten' AND OLD.claim_status IS DISTINCT FROM NEW.claim_status THEN
    PERFORM set_config('omni.system_scope','true',TRUE);
    PERFORM set_config('omni.system_reason','exact forgotten Memory acceptance closure',TRUE);
    DELETE FROM public.omni_native_private_memory_actions WHERE tenant_id=NEW.tenant_id AND target_memory_id=NEW.id;
    PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
    PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  RAISE;
END
$function$;
CREATE TRIGGER omni_native_private_memory_forget AFTER UPDATE OF claim_status ON public.omni_memories
FOR EACH ROW EXECUTE FUNCTION public.omni_native_private_memory_forget_v1();
ALTER TABLE public.omni_native_private_memory_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_private_memory_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_private_memory_actions AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_private_memory_actor ON public.omni_native_private_memory_actions AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_private_memory_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type<>'private_memory.native_action.accepted' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type<>'private_memory.native_action.accepted' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_native_private_memory_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_private_memory_owner_v1(TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_private_memory_immutable_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_private_memory_forget_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_knowledge_deletion_lineage_v1(TEXT,TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TIMESTAMPTZ) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
    GRANT SELECT,INSERT ON public.omni_native_private_memory_actions TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB) TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_private_memory_owner_v1(TEXT,TEXT,TEXT,BOOLEAN) TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_knowledge_deletion_lineage_v1(TEXT,TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TIMESTAMPTZ) TO omni_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_maintenance') THEN
    GRANT SELECT,INSERT ON public.omni_native_private_memory_actions TO omni_maintenance;
    GRANT EXECUTE ON FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB) TO omni_maintenance;
    GRANT EXECUTE ON FUNCTION public.omni_native_private_memory_owner_v1(TEXT,TEXT,TEXT,BOOLEAN) TO omni_maintenance;
    GRANT EXECUTE ON FUNCTION public.omni_native_knowledge_deletion_lineage_v1(TEXT,TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TIMESTAMPTZ) TO omni_maintenance;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_native_private_memory_actions TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(233,'native_private_memory_actions_v1','fc769e804833e1509948919af832c92057d4236de057e60c51c98f8fdf0f9150',clock_timestamp());
COMMIT;
