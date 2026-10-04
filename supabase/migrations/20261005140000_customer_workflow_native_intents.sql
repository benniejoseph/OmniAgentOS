BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 227 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 227
      AND name = 'memory_promotion_native_decisions_v1'
      AND checksum = 'bf9e9132d165e7fb1ddb6c51888e1c763231ba1eb5456d6f318930a2656d6780'
  ) <> 1 THEN RAISE EXCEPTION 'Customer workflow native intent predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Legacy evidence remains NULL/NULL and never becomes a native acceptance.
-- The existing owner/workspace/key uniqueness and immutable revision guard
-- protect this intent alongside its accepted run. No new purpose or policy is
-- introduced. Rollback retains accepted intent columns and their evidence.
-- Canonical JSON digests are checked by the application; JSONB text is not the
-- canonical JSON encoding used by the published native contract.
ALTER TABLE public.omni_customer_success_workflow_run_revisions
  ADD COLUMN native_intent JSONB,
  ADD COLUMN native_intent_sha256 TEXT,
  ADD CONSTRAINT omni_customer_workflow_exact_native_intent CHECK (
    (native_intent IS NULL AND native_intent_sha256 IS NULL) OR COALESCE((
      native_intent IS NOT NULL AND native_intent_sha256 IS NOT NULL
      AND native_intent_sha256 ~ '^[a-f0-9]{64}$'
      AND native_intent_sha256 = mutation_request_sha256
      AND jsonb_typeof(native_intent) = 'object' AND pg_column_size(native_intent) <= 262144
      AND native_intent ?& ARRAY['schemaVersion','contract','operation','tenantId','workspaceId','accountId','runId','canonicalActorId','idempotencyKeySha256','request']
      AND native_intent - ARRAY['schemaVersion','contract','operation','tenantId','workspaceId','accountId','runId','canonicalActorId','idempotencyKeySha256','request'] = '{}'::JSONB
      AND native_intent->'schemaVersion' = '1'::JSONB
      AND native_intent->>'contract' = 'customer-success-workflow-intent:1'
      AND native_intent->>'operation' IN ('start','outcome')
      AND native_intent->>'tenantId' = tenant_id
      AND native_intent->>'workspaceId' = workspace_id
      AND native_intent->>'accountId' = account_id
      AND native_intent->>'runId' = run_id
      AND native_intent->>'canonicalActorId' = owner_actor_id
      AND native_intent->>'canonicalActorId' ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND native_intent->>'idempotencyKeySha256' = mutation_idempotency_sha256
      AND native_intent->>'tenantId' = run_snapshot->>'tenantId'
      AND native_intent->>'workspaceId' = run_snapshot->>'workspaceId'
      AND native_intent->>'accountId' = run_snapshot->>'accountId'
      AND native_intent->>'runId' = run_snapshot->>'runId'
      AND native_intent->>'canonicalActorId' = run_snapshot->>'ownerActorId'
      AND native_intent->>'canonicalActorId' = run_snapshot->'outcome'->>'recordedByActorId'
      AND jsonb_typeof(native_intent->'request') = 'object'
      AND native_intent->'request'->>'expectedAccountSha256' ~ '^[a-f0-9]{64}$'
      AND native_intent->'request'->>'expectedDefinitionSha256' = definition_sha256
      AND CASE WHEN jsonb_typeof(native_intent->'request'->'expectedAccountRevision') = 'number'
          AND native_intent->'request'->>'expectedAccountRevision' ~ '^[1-9][0-9]{0,9}$'
        THEN (native_intent->'request'->>'expectedAccountRevision')::BIGINT BETWEEN 1 AND 2147483647
          AND (native_intent->'request'->>'expectedAccountRevision')::BIGINT >= (run_snapshot->>'accountRevision')::BIGINT
          AND ((native_intent->'request'->>'expectedAccountRevision')::BIGINT > (run_snapshot->>'accountRevision')::BIGINT
            OR native_intent->'request'->>'expectedAccountSha256' = run_snapshot->>'accountSha256')
        ELSE FALSE END
      AND CASE WHEN native_intent->>'operation' = 'start' THEN
        (native_intent->'request') ?& ARRAY['expectedAccountRevision','expectedAccountSha256','expectedDefinitionSha256','input']
        AND (native_intent->'request') - ARRAY['expectedAccountRevision','expectedAccountSha256','expectedDefinitionSha256','input'] = '{}'::JSONB
        AND revision = 1 AND outcome_status = 'in_progress'
        AND native_intent->'request'->'expectedAccountRevision' = run_snapshot->'accountRevision'
        AND native_intent->'request'->>'expectedAccountSha256' = run_snapshot->>'accountSha256'
        AND native_intent->'request'->'input' = run_snapshot->'input'
        AND run_snapshot->'outcome'->'summary' = '""'::JSONB
        AND run_snapshot->'outcome'->'artifactReceipts' = '[]'::JSONB
      ELSE
        (native_intent->'request') ?& ARRAY['runId','expectedAccountRevision','expectedAccountSha256','expectedRunRevision','expectedRunSha256','expectedDefinitionSha256','status','summary','artifactReceipts','nextAction']
        AND (native_intent->'request') - ARRAY['runId','expectedAccountRevision','expectedAccountSha256','expectedRunRevision','expectedRunSha256','expectedDefinitionSha256','status','summary','artifactReceipts','nextAction'] = '{}'::JSONB
        AND native_intent->'request'->>'runId' = run_id
        AND native_intent->'request'->>'expectedRunSha256' ~ '^[a-f0-9]{64}$'
        AND CASE WHEN jsonb_typeof(native_intent->'request'->'expectedRunRevision') = 'number'
            AND native_intent->'request'->>'expectedRunRevision' ~ '^[1-9][0-9]{0,9}$'
          THEN (native_intent->'request'->>'expectedRunRevision')::BIGINT BETWEEN 1 AND 2147483646
            AND (native_intent->'request'->>'expectedRunRevision')::BIGINT + 1 = revision
          ELSE FALSE END
        AND outcome_status IN ('completed','blocked','cancelled')
        AND native_intent->'request'->'status' = run_snapshot->'outcome'->'status'
        AND native_intent->'request'->'summary' = run_snapshot->'outcome'->'summary'
        AND native_intent->'request'->'artifactReceipts' = run_snapshot->'outcome'->'artifactReceipts'
        AND native_intent->'request'->'nextAction' = run_snapshot->'outcome'->'nextAction'
      END
    ), FALSE)
  );

-- The application holds the Account/run serialization locks before INSERT.
-- This invoker guard additionally binds native admission to the currently
-- visible owner/pin and exact immutable predecessor under existing RLS.
CREATE FUNCTION public.omni_validate_customer_workflow_native_intent_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $function$
DECLARE account_pin RECORD; previous_revision RECORD;
BEGIN
  IF NEW.native_intent IS NULL THEN RETURN NEW; END IF;
  SELECT current_revision,account_sha256 INTO account_pin FROM public.omni_customer_accounts
    WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND account_id=NEW.account_id
      AND owner_actor_id=NEW.owner_actor_id
      AND allowed_purpose_ids @> ARRAY['customer_success.account.read','customer_success.account.manage']::TEXT[]
      AND public.omni_customer_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,TRUE);
  IF NOT FOUND OR account_pin.current_revision::TEXT IS DISTINCT FROM NEW.native_intent->'request'->>'expectedAccountRevision'
    OR account_pin.account_sha256 IS DISTINCT FROM NEW.native_intent->'request'->>'expectedAccountSha256'
  THEN RAISE EXCEPTION 'Native workflow Account authority or pin changed' USING ERRCODE='23514'; END IF;
  IF NEW.native_intent->>'operation' = 'outcome' THEN
    SELECT run_sha256,run_snapshot,outcome_status,recorded_at INTO previous_revision
      FROM public.omni_customer_success_workflow_run_revisions
      WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND run_id=NEW.run_id
        AND owner_actor_id=NEW.owner_actor_id AND revision=NEW.revision-1;
    IF NOT FOUND OR previous_revision.run_sha256 IS DISTINCT FROM NEW.native_intent->'request'->>'expectedRunSha256'
      OR previous_revision.outcome_status IN ('completed','cancelled') OR NEW.recorded_at <= previous_revision.recorded_at
      OR NEW.run_snapshot->>'previousRunRevisionId' IS DISTINCT FROM previous_revision.run_snapshot->>'runRevisionId'
      OR (previous_revision.run_snapshot - ARRAY['revision','runRevisionId','previousRunRevisionId','runSha256','outcome'])
        IS DISTINCT FROM (NEW.run_snapshot - ARRAY['revision','runRevisionId','previousRunRevisionId','runSha256','outcome'])
    THEN RAISE EXCEPTION 'Native workflow predecessor is inconsistent' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_validate_customer_workflow_native_intent_v1() FROM PUBLIC;
CREATE TRIGGER omni_customer_workflow_native_intent_validate
  BEFORE INSERT ON public.omni_customer_success_workflow_run_revisions
  FOR EACH ROW EXECUTE FUNCTION public.omni_validate_customer_workflow_native_intent_v1();

INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (228,'customer_workflow_native_intents_v1','7dc7d3678239c34047ecf1732eb0f42ed80944c836c45e87eece1739c144c309',clock_timestamp());
COMMIT;
