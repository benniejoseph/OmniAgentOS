BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 220 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 220
      AND name = 'meeting_commitment_resolution_intents_v1'
      AND checksum = '45e63154aeaca286c2da9d898873be0e26fa3a2412ab58ac22a373d1f759339b'
  ) <> 1 THEN RAISE EXCEPTION 'Customer account intent predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Additive old-writer compatibility: old binaries may still insert NULL/NULL.
-- Existing snapshots, immutable triggers, policies and grants are unchanged.
-- NULL is legacy/ambiguous evidence, never authorization for the new replay
-- protocol. Rolling back application code preserves data readability, but loses
-- exact-request retry guarantees; never advertise those guarantees for an old
-- writer. Do not drop these columns or rewrite accepted evidence on rollback.
ALTER TABLE public.omni_customer_account_revisions
  ADD COLUMN request_intent JSONB,
  ADD COLUMN request_sha256 TEXT,
  ADD CONSTRAINT omni_customer_account_exact_intent CHECK (
    (request_intent IS NULL AND request_sha256 IS NULL) OR (
      request_intent IS NOT NULL AND request_sha256 IS NOT NULL
      AND request_sha256 ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(request_intent) = 'object'
      AND pg_column_size(request_intent) <= 16384
      AND request_intent ?& ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','mutationId','canonicalActorId','idempotencyKeySha256','request']
      AND request_intent - ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','mutationId','canonicalActorId','idempotencyKeySha256','request'] = '{}'::JSONB
      AND COALESCE(request_intent->'schemaVersion' = '1'::JSONB, FALSE)
      AND COALESCE(request_intent->>'contract' = 'customer-account-mutation-intent:1', FALSE)
      AND request_intent->>'tenantId' IS NOT DISTINCT FROM tenant_id
      AND request_intent->>'workspaceId' IS NOT DISTINCT FROM workspace_id
      AND request_intent->>'accountId' IS NOT DISTINCT FROM account_id
      AND request_intent->>'mutationId' IS NOT DISTINCT FROM mutation_id
      AND request_intent->>'canonicalActorId' IS NOT DISTINCT FROM owner_actor_id
      AND request_intent->>'canonicalActorId' IS NOT DISTINCT FROM account_snapshot->>'revisedByActorId'
      AND COALESCE(request_intent->>'canonicalActorId' ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$', FALSE)
      AND COALESCE(request_intent->>'idempotencyKeySha256' ~ '^[a-f0-9]{64}$', FALSE)
      AND COALESCE(jsonb_typeof(request_intent->'request') = 'object', FALSE)
      AND CASE request_intent->'request'->>'operation'
        WHEN 'account.create' THEN COALESCE(
          revision = 1
          AND request_intent->'request' ?& ARRAY['operation','name','lifecycle','organizationEntityId','accountOwner','customerDataPurposeIds']
          AND (request_intent->'request') - ARRAY['operation','name','lifecycle','organizationEntityId','accountOwner','customerDataPurposeIds'] = '{}'::JSONB
          AND account_snapshot->'crmPermissions'->>'externalWriteState' = 'disabled', FALSE)
        WHEN 'account.revise' THEN COALESCE(
          revision > 1
          AND request_intent->'request' ?& ARRAY['operation','expectedRevision']
          AND (request_intent->'request') - ARRAY['operation','expectedRevision','name','lifecycle','organizationEntityId','accountOwner','customerDataPurposeIds'] = '{}'::JSONB
          AND (request_intent->'request') ?| ARRAY['name','lifecycle','organizationEntityId','accountOwner','customerDataPurposeIds']
          AND request_intent->'request'->'expectedRevision' = to_jsonb(revision - 1), FALSE)
        ELSE FALSE END
      AND COALESCE(NOT (request_intent->'request' ? 'name') OR request_intent->'request'->'name' = account_snapshot->'name', FALSE)
      AND COALESCE(NOT (request_intent->'request' ? 'lifecycle') OR request_intent->'request'->'lifecycle' = account_snapshot->'lifecycle', FALSE)
      AND COALESCE(NOT (request_intent->'request' ? 'organizationEntityId') OR request_intent->'request'->'organizationEntityId' = account_snapshot->'organizationEntityId', FALSE)
      AND COALESCE(NOT (request_intent->'request' ? 'accountOwner') OR request_intent->'request'->'accountOwner' = account_snapshot->'accountOwner', FALSE)
      AND COALESCE(NOT (request_intent->'request' ? 'customerDataPurposeIds') OR request_intent->'request'->'customerDataPurposeIds' = account_snapshot->'crmPermissions'->'customerDataPurposeIds', FALSE)
    )
  );

INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (221,'customer_account_mutation_intents_v1','aaa8677534825332f55e5765c5b6829766a5b7fed8b6f11a1c3762c17aa922ae',clock_timestamp());
COMMIT;
