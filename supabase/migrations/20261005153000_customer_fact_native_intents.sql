BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 230 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=230
      AND name='meeting_recording_native_processing_v1'
      AND checksum='c372f6d625795a7b8c0b11b449ef2babc80e877389e66207576a684b45dbd468'
  ) <> 1 THEN RAISE EXCEPTION 'Native manual fact predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Existing immutable revisions remain NULL/NULL. Rollback disables native
-- ingress and retains accepted evidence; legacy rows are never native proof.
-- Canonical intent/source hashes are verified by application schemas, not by
-- hashing PostgreSQL's different JSONB text serialization.
ALTER TABLE public.omni_customer_fact_revisions
  ADD COLUMN native_intent JSONB,
  ADD COLUMN native_intent_sha256 TEXT,
  ADD CONSTRAINT omni_customer_fact_native_intent CHECK (
    (native_intent IS NULL AND native_intent_sha256 IS NULL) OR COALESCE((
      native_intent IS NOT NULL AND native_intent_sha256 IS NOT NULL AND native_intent_sha256 ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(native_intent)='object' AND pg_column_size(native_intent)<=131072
      AND native_intent ?& ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','canonicalActorId','factId','mutationId','idempotencyKeySha256','request']
      AND native_intent-ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','canonicalActorId','factId','mutationId','idempotencyKeySha256','request']='{}'::JSONB
      AND native_intent->'schemaVersion'='1'::JSONB AND native_intent->>'contract'='customer-fact-mutation-intent:1'
      AND native_intent->>'tenantId'=tenant_id AND native_intent->>'workspaceId'=workspace_id
      AND native_intent->>'accountId'=account_id AND native_intent->>'factId'=fact_id AND native_intent->>'mutationId'=mutation_id
      AND native_intent->>'canonicalActorId'=owner_actor_id
      AND native_intent->>'canonicalActorId' ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND native_intent->>'idempotencyKeySha256' ~ '^[a-f0-9]{64}$'
      AND native_intent->>'tenantId'=fact_snapshot->>'tenantId' AND native_intent->>'workspaceId'=fact_snapshot->>'workspaceId'
      AND native_intent->>'accountId'=fact_snapshot->>'accountId' AND native_intent->>'canonicalActorId'=fact_snapshot->>'recordedByActorId'
      AND jsonb_typeof(native_intent->'request')='object'
      AND (native_intent->'request') ?& ARRAY['expectedAccountRevision','expectedAccountSha256','operation','factId','expectedFactRevision','expectedFactSha256','factKey','value','owner','confidenceBasisPoints','validFrom','validTo','staleAfter','manualSource','allowedPurposeIds']
      AND (native_intent->'request')-ARRAY['expectedAccountRevision','expectedAccountSha256','operation','factId','expectedFactRevision','expectedFactSha256','factKey','value','owner','confidenceBasisPoints','validFrom','validTo','staleAfter','manualSource','allowedPurposeIds']='{}'::JSONB
      AND native_intent->'request'->>'expectedAccountSha256' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(native_intent->'request'->'expectedAccountRevision')='number'
          AND native_intent->'request'->>'expectedAccountRevision' ~ '^[1-9][0-9]{0,9}$'
        THEN (native_intent->'request'->>'expectedAccountRevision')::BIGINT BETWEEN 1 AND 2147483647 ELSE FALSE END
      AND native_intent->'request'->>'operation' IN ('create','revise','retract')
      AND native_intent->'request'->>'factKey'=fact_key
      AND native_intent->'request'->'value'=fact_snapshot->'value'
      AND native_intent->'request'->'owner'=fact_snapshot->'owner'
      AND native_intent->'request'->'confidenceBasisPoints'=fact_snapshot->'confidenceBasisPoints'
      AND native_intent->'request'->'validFrom'=fact_snapshot->'validFrom'
      AND native_intent->'request'->'validTo'=fact_snapshot->'validTo'
      AND native_intent->'request'->'staleAfter'=fact_snapshot->'staleAfter'
      AND fact_state=CASE WHEN native_intent->'request'->>'operation'='retract' THEN 'retracted' ELSE 'active' END
      AND jsonb_typeof(native_intent->'request'->'manualSource')='object'
      AND (native_intent->'request'->'manualSource') ?& ARRAY['label','observedAt']
      AND (native_intent->'request'->'manualSource')-ARRAY['label','observedAt']='{}'::JSONB
      AND fact_snapshot->'source'->>'sourceKind'='manual'
      AND fact_snapshot->'source'->>'permissionBasis'='operator_assertion'
      AND fact_snapshot->'source'->>'sourceId'='customer-manual-source:'||native_intent_sha256
      AND fact_snapshot->'source'->>'sourceRevisionId'='customer-manual-source:'||native_intent_sha256||':v1'
      AND fact_snapshot->'source'->'providerId'='null'::JSONB
      AND fact_snapshot->'source'->'providerObjectType'='null'::JSONB
      AND fact_snapshot->'source'->'providerObjectIdSha256'='null'::JSONB
      AND fact_snapshot->'source'->'sourceLabel'=native_intent->'request'->'manualSource'->'label'
      AND fact_snapshot->'source'->'observedAt'=native_intent->'request'->'manualSource'->'observedAt'
      AND fact_snapshot->'source'->'ingestedAt'=fact_snapshot->'recordedAt'
      AND fact_snapshot->'source'->'allowedPurposeIds'=native_intent->'request'->'allowedPurposeIds'
      AND fact_snapshot->'source'->'allowedPurposeIds'=to_jsonb(allowed_purpose_ids)
      AND 'customer_success.account.read'=ANY(allowed_purpose_ids)
      AND CASE WHEN native_intent->'request'->>'operation'='create' THEN
        revision=1 AND native_intent->'request'->'factId'='null'::JSONB
        AND native_intent->'request'->'expectedFactRevision'='null'::JSONB AND native_intent->'request'->'expectedFactSha256'='null'::JSONB
      ELSE native_intent->'request'->>'factId'=fact_id
        AND native_intent->'request'->>'expectedFactSha256' ~ '^[a-f0-9]{64}$'
        AND CASE WHEN jsonb_typeof(native_intent->'request'->'expectedFactRevision')='number'
            AND native_intent->'request'->>'expectedFactRevision' ~ '^[1-9][0-9]{0,9}$'
          THEN (native_intent->'request'->>'expectedFactRevision')::BIGINT BETWEEN 1 AND 2147483646
            AND (native_intent->'request'->>'expectedFactRevision')::BIGINT+1=revision ELSE FALSE END END
    ),FALSE)
  );
CREATE UNIQUE INDEX omni_customer_fact_native_key ON public.omni_customer_fact_revisions
  (tenant_id,workspace_id,owner_actor_id,(native_intent->>'idempotencyKeySha256')) WHERE native_intent IS NOT NULL;

CREATE FUNCTION public.omni_validate_customer_fact_native_intent_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE account_pin RECORD; previous_fact RECORD;
BEGIN
  IF NEW.native_intent IS NULL THEN RETURN NEW; END IF;
  SELECT current_revision,account_sha256,allowed_purpose_ids INTO account_pin FROM public.omni_customer_accounts
    WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND account_id=NEW.account_id AND owner_actor_id=NEW.owner_actor_id
      AND allowed_purpose_ids @> ARRAY['customer_success.account.read','customer_success.account.manage']::TEXT[]
      AND public.omni_customer_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,TRUE);
  IF NOT FOUND OR account_pin.current_revision::TEXT IS DISTINCT FROM NEW.native_intent->'request'->>'expectedAccountRevision'
    OR account_pin.account_sha256 IS DISTINCT FROM NEW.native_intent->'request'->>'expectedAccountSha256'
    OR NOT NEW.allowed_purpose_ids <@ account_pin.allowed_purpose_ids
  THEN RAISE EXCEPTION 'Native fact Account authority or pin changed' USING ERRCODE='23514'; END IF;
  IF NEW.native_intent->'request'->>'operation' IN ('revise','retract') THEN
    SELECT fact_sha256,fact_snapshot,fact_key,fact_kind INTO previous_fact FROM public.omni_customer_fact_revisions
      WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND account_id=NEW.account_id
        AND fact_id=NEW.fact_id AND owner_actor_id=NEW.owner_actor_id AND revision=NEW.revision-1;
    IF NOT FOUND OR previous_fact.fact_sha256 IS DISTINCT FROM NEW.native_intent->'request'->>'expectedFactSha256'
      OR previous_fact.fact_key<>NEW.fact_key OR previous_fact.fact_kind<>NEW.fact_kind
      OR previous_fact.fact_snapshot->'source'->>'sourceKind' IS DISTINCT FROM 'manual'
      OR previous_fact.fact_snapshot->'source'->>'permissionBasis' IS DISTINCT FROM 'operator_assertion'
      OR previous_fact.fact_snapshot->>'recordedByActorId' IS DISTINCT FROM NEW.owner_actor_id
    THEN RAISE EXCEPTION 'Native fact predecessor must be an exact owned manual assertion' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_validate_customer_fact_native_intent_v1() FROM PUBLIC;
CREATE TRIGGER omni_customer_fact_native_intent_validate BEFORE INSERT ON public.omni_customer_fact_revisions
  FOR EACH ROW EXECUTE FUNCTION public.omni_validate_customer_fact_native_intent_v1();
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(231,'customer_fact_native_intents_v1','8a422f415c5ca73a375c954a1d10368afa60273cb9f8c801cb21990f72503b42',clock_timestamp());
COMMIT;
