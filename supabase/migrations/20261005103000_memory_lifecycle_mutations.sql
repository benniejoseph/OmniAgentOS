BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 221 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=221 AND name='customer_account_mutation_intents_v1'
      AND checksum='aaa8677534825332f55e5765c5b6829766a5b7fed8b6f11a1c3762c17aa922ae'
  ) <> 1 THEN RAISE EXCEPTION 'Memory lifecycle predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Old writers omit these columns. Database triggers, not caller-supplied
-- revisions, cover their writes too. No private-content fingerprint is kept.
ALTER TABLE public.omni_memories ADD COLUMN lifecycle_target_revision BIGINT NOT NULL DEFAULT 1
  CHECK (lifecycle_target_revision BETWEEN 1 AND 9007199254740990);
ALTER TABLE public.omni_memory_lifecycle_states ADD COLUMN lifecycle_revision BIGINT NOT NULL DEFAULT 1
  CHECK (lifecycle_revision BETWEEN 1 AND 9007199254740990);
CREATE FUNCTION public.omni_memory_lifecycle_target_revision_v1() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP='INSERT' THEN NEW.lifecycle_target_revision:=1;
  ELSE
    -- Explicit exclusions are operational usage/vector state and the generic
    -- update clock. Every other present/future field invalidates the token.
    IF (to_jsonb(NEW)-ARRAY['lifecycle_target_revision','last_used_at','use_count','embedding','embedding_vector','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lifecycle_target_revision','last_used_at','use_count','embedding','embedding_vector','updated_at'])
    THEN NEW.lifecycle_target_revision:=OLD.lifecycle_target_revision+1;
    ELSE NEW.lifecycle_target_revision:=OLD.lifecycle_target_revision; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_omni_memory_lifecycle_target_revision BEFORE INSERT OR UPDATE ON public.omni_memories
FOR EACH ROW EXECUTE FUNCTION public.omni_memory_lifecycle_target_revision_v1();
CREATE FUNCTION public.omni_memory_lifecycle_revision_v1() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP='INSERT' THEN NEW.lifecycle_revision:=1;
  ELSE NEW.lifecycle_revision:=OLD.lifecycle_revision+1; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_omni_memory_lifecycle_revision BEFORE INSERT OR UPDATE ON public.omni_memory_lifecycle_states
FOR EACH ROW EXECUTE FUNCTION public.omni_memory_lifecycle_revision_v1();

CREATE TABLE public.omni_memory_lifecycle_mutations (
  id TEXT NOT NULL UNIQUE CHECK(id ~ '^memory-lifecycle-acceptance:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL CHECK(owner_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  memory_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('pin','unpin','archive','restore')),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT, expected_target_token TEXT, acceptance JSONB,
  accepted_at TIMESTAMPTZ NOT NULL, forgotten_at TIMESTAMPTZ, deletion_receipt_id TEXT,
  PRIMARY KEY(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK ((forgotten_at IS NULL AND deletion_receipt_id IS NULL AND request_sha256 IS NOT NULL
      AND request_sha256 ~ '^[a-f0-9]{64}$' AND expected_target_token IS NOT NULL AND expected_target_token ~ '^[a-f0-9]{64}$'
      AND acceptance IS NOT NULL AND jsonb_typeof(acceptance)='object' AND pg_column_size(acceptance)<=8192)
    OR (forgotten_at IS NOT NULL AND deletion_receipt_id IS NOT NULL AND request_sha256 IS NULL
      AND expected_target_token IS NULL AND acceptance IS NULL))
);
CREATE INDEX omni_memory_lifecycle_mutations_target ON public.omni_memory_lifecycle_mutations(tenant_id,memory_id);

CREATE FUNCTION public.omni_memory_lifecycle_mutation_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE memory public.omni_memories%ROWTYPE; lifecycle public.omni_memory_lifecycle_states%ROWTYPE; snapshot JSONB;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Memory lifecycle acceptance cannot be removed' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.forgotten_at IS NOT NULL OR NEW.request_sha256 IS NOT NULL OR NEW.expected_target_token IS NOT NULL OR NEW.acceptance IS NOT NULL
      OR ROW(NEW.id,NEW.tenant_id,NEW.owner_actor_id,NEW.memory_id,NEW.action,NEW.idempotency_key_sha256,NEW.accepted_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.owner_actor_id,OLD.memory_id,OLD.action,OLD.idempotency_key_sha256,OLD.accepted_at)
      OR NOT EXISTS(SELECT 1 FROM public.omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id=NEW.tenant_id AND receipt.id=NEW.deletion_receipt_id AND receipt.forgotten_at=NEW.forgotten_at
          AND (receipt.memory_id=NEW.memory_id OR NEW.memory_id=ANY(receipt.descendant_memory_ids)))
    THEN RAISE EXCEPTION 'Only exact receipt-bound forgetting can scrub acceptance' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.forgotten_at IS NOT NULL OR NEW.deletion_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'A new acceptance cannot be a tombstone' USING ERRCODE='23514'; END IF;
  SELECT * INTO memory FROM public.omni_memories WHERE tenant_id=NEW.tenant_id AND id=NEW.memory_id FOR UPDATE;
  SELECT * INTO lifecycle FROM public.omni_memory_lifecycle_states WHERE tenant_id=NEW.tenant_id AND memory_id=NEW.memory_id FOR UPDATE;
  snapshot:=NEW.acceptance;
  IF memory.id IS NULL OR memory.access_contract_version<>1 OR memory.access_state<>'scope_bound' OR memory.visibility<>'user_private'
    OR memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id OR memory.claim_status='forgotten'
    OR public.omni_memory_ids_have_deletion_barrier(NEW.tenant_id,ARRAY[NEW.memory_id]) OR lifecycle.memory_id IS NULL
    OR NOT COALESCE(snapshot->>'contract'='asael-memory-lifecycle-acceptance:1'
      AND snapshot ?& ARRAY['contract','id','tenantId','ownerActorId','memoryId','action','idempotencyKeySha256','requestSha256','expectedTargetToken','acceptedAt','targetRevision','beforeLifecycleRevision','afterLifecycleRevision','lifecycle','historicalTruthChanged','permanentDeletion']
      AND snapshot-ARRAY['contract','id','tenantId','ownerActorId','memoryId','action','idempotencyKeySha256','requestSha256','expectedTargetToken','acceptedAt','targetRevision','beforeLifecycleRevision','afterLifecycleRevision','lifecycle','historicalTruthChanged','permanentDeletion']='{}'::JSONB
      AND snapshot->>'id'=NEW.id AND snapshot->>'tenantId'=NEW.tenant_id AND snapshot->>'ownerActorId'=NEW.owner_actor_id
      AND snapshot->>'memoryId'=NEW.memory_id AND snapshot->>'action'=NEW.action
      AND snapshot->>'idempotencyKeySha256'=NEW.idempotency_key_sha256 AND snapshot->>'requestSha256'=NEW.request_sha256
      AND snapshot->>'expectedTargetToken'=NEW.expected_target_token
      AND (snapshot->>'acceptedAt')::TIMESTAMPTZ=NEW.accepted_at
      AND snapshot->'targetRevision'=to_jsonb(memory.lifecycle_target_revision)
      AND snapshot->'afterLifecycleRevision'=to_jsonb(lifecycle.lifecycle_revision)
      AND (snapshot->>'beforeLifecycleRevision')::BIGINT+1=lifecycle.lifecycle_revision
      AND snapshot->'historicalTruthChanged'='false'::JSONB AND snapshot->'permanentDeletion'='false'::JSONB
      AND CASE NEW.action
        WHEN 'pin' THEN lifecycle.pinned_at IS NOT NULL AND lifecycle.archived_at IS NULL
        WHEN 'archive' THEN lifecycle.pinned_at IS NULL AND lifecycle.archived_at IS NOT NULL AND lifecycle.archive_reason='manual'
        ELSE lifecycle.pinned_at IS NULL AND lifecycle.archived_at IS NULL END
      AND snapshot->'lifecycle' ?& ARRAY['policyVersion','pinnedAt','archivedAt','archiveReason','duplicateOfMemoryId','updatedAt']
      AND (snapshot->'lifecycle')-ARRAY['policyVersion','pinnedAt','archivedAt','archiveReason','duplicateOfMemoryId','updatedAt']='{}'::JSONB
      AND snapshot->'lifecycle'->'policyVersion'='1'::JSONB
      AND (snapshot->'lifecycle'->>'pinnedAt')::TIMESTAMPTZ IS NOT DISTINCT FROM lifecycle.pinned_at
      AND (snapshot->'lifecycle'->>'archivedAt')::TIMESTAMPTZ IS NOT DISTINCT FROM lifecycle.archived_at
      AND snapshot->'lifecycle'->>'archiveReason' IS NOT DISTINCT FROM lifecycle.archive_reason
      AND snapshot->'lifecycle'->>'duplicateOfMemoryId' IS NOT DISTINCT FROM lifecycle.duplicate_of_memory_id
      AND (snapshot->'lifecycle'->>'updatedAt')::TIMESTAMPTZ=lifecycle.updated_at,FALSE)
  THEN RAISE EXCEPTION 'Memory lifecycle acceptance does not bind its current transition' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.omni_events event WHERE event.id=NEW.id AND event.tenant_id=NEW.tenant_id
    AND event.actor_id=NEW.owner_actor_id AND event.type='memory.lifecycle.'||NEW.action
    AND event.payload->>'memoryId'=NEW.memory_id AND event.payload->>'action'=NEW.action)
  THEN RAISE EXCEPTION 'Memory lifecycle acceptance requires its exact event' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_memory_lifecycle_mutations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_memory_lifecycle_mutations
FOR EACH ROW EXECUTE FUNCTION public.omni_memory_lifecycle_mutation_guard_v1();
CREATE TRIGGER omni_memory_lifecycle_mutations_no_truncate BEFORE TRUNCATE ON public.omni_memory_lifecycle_mutations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_memory_lifecycle_mutation_guard_v1();

-- Same reviewed closure as the existing forget receipt, including restricted
-- descendants. Only this constrained definer can update the append-only ledger.
CREATE FUNCTION public.omni_scrub_memory_lifecycle_mutations_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE previous_scope TEXT:=current_setting('omni.system_scope',true); previous_reason TEXT:=current_setting('omni.system_reason',true);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('memory-graph:'||NEW.tenant_id,0));
  PERFORM set_config('omni.system_scope','true',true);
  PERFORM set_config('omni.system_reason','memory lifecycle acceptance forget scrub',true);
  PERFORM id FROM public.omni_memories WHERE tenant_id=NEW.tenant_id AND (id=NEW.memory_id OR id=ANY(NEW.descendant_memory_ids)) ORDER BY id FOR UPDATE;
  UPDATE public.omni_memory_lifecycle_mutations SET request_sha256=NULL,expected_target_token=NULL,acceptance=NULL,
    forgotten_at=NEW.forgotten_at,deletion_receipt_id=NEW.id
    WHERE tenant_id=NEW.tenant_id AND (memory_id=NEW.memory_id OR memory_id=ANY(NEW.descendant_memory_ids)) AND forgotten_at IS NULL;
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
  RETURN NULL;
END
$function$;
CREATE TRIGGER omni_memory_deletion_receipts_lifecycle_mutations AFTER INSERT ON public.omni_memory_deletion_receipts
FOR EACH ROW EXECUTE FUNCTION public.omni_scrub_memory_lifecycle_mutations_v1();

CREATE FUNCTION public.omni_require_memory_lifecycle_forget_scrub_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE target_tenant TEXT; targets TEXT[];
  previous_scope TEXT:=current_setting('omni.system_scope',true); previous_reason TEXT:=current_setting('omni.system_reason',true);
BEGIN
  IF TG_TABLE_NAME='omni_memory_deletion_receipts' THEN target_tenant:=NEW.tenant_id; targets:=ARRAY[NEW.memory_id]||NEW.descendant_memory_ids;
  ELSE target_tenant:=NEW.tenant_id; targets:=ARRAY[NEW.memory_id]; END IF;
  PERFORM set_config('omni.system_scope','true',true);
  PERFORM set_config('omni.system_reason','verify memory lifecycle acceptance forget scrub',true);
  IF EXISTS(SELECT 1 FROM public.omni_memory_lifecycle_mutations mutation WHERE mutation.tenant_id=target_tenant
    AND mutation.memory_id=ANY(targets) AND mutation.forgotten_at IS NULL
    AND public.omni_memory_ids_have_deletion_barrier(target_tenant,ARRAY[mutation.memory_id]))
  THEN RAISE EXCEPTION 'Forgotten Memory cannot retain lifecycle replay evidence' USING ERRCODE='23514'; END IF;
  PERFORM set_config('omni.system_scope',COALESCE(previous_scope,''),true);
  PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),true);
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_memory_lifecycle_mutations_forget_barrier AFTER INSERT OR UPDATE ON public.omni_memory_lifecycle_mutations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_memory_lifecycle_forget_scrub_v1();
CREATE CONSTRAINT TRIGGER omni_memory_deletion_receipts_lifecycle_scrub AFTER INSERT ON public.omni_memory_deletion_receipts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_memory_lifecycle_forget_scrub_v1();

ALTER TABLE public.omni_memory_lifecycle_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_memory_lifecycle_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_memory_lifecycle_mutations AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_memory_lifecycle_mutations_actor ON public.omni_memory_lifecycle_mutations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_memory_lifecycle_mutations_memory_scope ON public.omni_memory_lifecycle_mutations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_user_private_memory_scope_v1_allows_validated((SELECT public.omni_current_memory_access_scope_v1()),tenant_id,owner_actor_id,ARRAY['memory.read.v1','memory.maintenance.v1','memory.forget.v1']))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_user_private_memory_scope_v1_allows_validated((SELECT public.omni_current_memory_access_scope_v1()),tenant_id,owner_actor_id,ARRAY['memory.maintenance.v1']));
REVOKE ALL ON public.omni_memory_lifecycle_mutations FROM PUBLIC;
DO $lifecycle_grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('GRANT SELECT,INSERT ON public.omni_memory_lifecycle_mutations TO %I',role_name); END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_memory_lifecycle_mutations TO omni_backup; END IF;
END
$lifecycle_grants$;
REVOKE ALL ON FUNCTION public.omni_memory_lifecycle_target_revision_v1(),public.omni_memory_lifecycle_revision_v1(),
  public.omni_memory_lifecycle_mutation_guard_v1(),public.omni_scrub_memory_lifecycle_mutations_v1(),public.omni_require_memory_lifecycle_forget_scrub_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(222,'memory_lifecycle_mutations_v1','35264a49f7eaf88153a1e83f1a35e6baa7933c21277977c6c5442d5341677a1b',clock_timestamp());
COMMIT;
