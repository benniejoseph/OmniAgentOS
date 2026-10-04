BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 225 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 225
      AND name = 'personal_context_consent_row_validator_grant_v1'
      AND checksum = 'd1b7856075f4d3f6212cb85b13c6f1e59fe82376f908418d098ae6963657850b'
  ) <> 1 THEN RAISE EXCEPTION 'Customer health intent predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Existing writers retain NULL/NULL. The immutable score remains the source
-- of evaluated evidence; these columns bind only the exact native request.
-- Rollback retains columns and accepted evidence. NULL is never native proof.
-- Canonical JSON digests are checked by the application; this CHECK does not
-- pretend that PostgreSQL JSONB text serialization has that same digest.
ALTER TABLE public.omni_customer_health_score_revisions
  ADD COLUMN request_intent JSONB,
  ADD COLUMN request_sha256 TEXT,
  ADD CONSTRAINT omni_customer_health_exact_intent CHECK (
    (request_intent IS NULL AND request_sha256 IS NULL) OR COALESCE((
      request_intent IS NOT NULL AND request_sha256 IS NOT NULL
      AND request_sha256 ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(request_intent) = 'object'
      AND pg_column_size(request_intent) <= 16384
      AND request_intent ?& ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','evaluationId','canonicalActorId','idempotencyKeySha256','request']
      AND request_intent - ARRAY['schemaVersion','contract','tenantId','workspaceId','accountId','evaluationId','canonicalActorId','idempotencyKeySha256','request'] = '{}'::JSONB
      AND request_intent->'schemaVersion' = '1'::JSONB
      AND request_intent->>'contract' = 'customer-health-evaluation-intent:1'
      AND jsonb_typeof(request_intent->'tenantId') = 'string'
      AND jsonb_typeof(request_intent->'workspaceId') = 'string'
      AND jsonb_typeof(request_intent->'accountId') = 'string'
      AND jsonb_typeof(request_intent->'evaluationId') = 'string'
      AND jsonb_typeof(request_intent->'canonicalActorId') = 'string'
      AND jsonb_typeof(request_intent->'idempotencyKeySha256') = 'string'
      AND request_intent->>'tenantId' IS NOT DISTINCT FROM tenant_id
      AND request_intent->>'workspaceId' IS NOT DISTINCT FROM workspace_id
      AND request_intent->>'accountId' IS NOT DISTINCT FROM account_id
      AND request_intent->>'evaluationId' IS NOT DISTINCT FROM evaluation_id
      AND request_intent->>'canonicalActorId' IS NOT DISTINCT FROM owner_actor_id
      AND request_intent->>'canonicalActorId' ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND request_intent->>'idempotencyKeySha256' ~ '^[a-f0-9]{64}$'
      AND request_intent->>'tenantId' IS NOT DISTINCT FROM score_snapshot->>'tenantId'
      AND request_intent->>'workspaceId' IS NOT DISTINCT FROM score_snapshot->>'workspaceId'
      AND request_intent->>'accountId' IS NOT DISTINCT FROM score_snapshot->>'accountId'
      AND request_intent->>'evaluationId' IS NOT DISTINCT FROM score_snapshot->>'evaluationId'
      AND request_intent->>'canonicalActorId' IS NOT DISTINCT FROM score_snapshot->>'evaluatedByActorId'
      AND jsonb_typeof(request_intent->'request') = 'object'
      AND (request_intent->'request') ?& ARRAY['expectedAccountRevision','expectedAccountSha256','modelSuggestions']
      AND (request_intent->'request') - ARRAY['expectedAccountRevision','expectedAccountSha256','modelSuggestions'] = '{}'::JSONB
      AND jsonb_typeof(request_intent->'request'->'expectedAccountSha256') = 'string'
      AND request_intent->'request'->>'expectedAccountSha256' ~ '^[a-f0-9]{64}$'
      AND request_intent->'request'->>'expectedAccountSha256' IS NOT DISTINCT FROM account_sha256
      AND request_intent->'request'->>'expectedAccountSha256' IS NOT DISTINCT FROM score_snapshot->>'accountSha256'
      AND request_intent->'request'->'modelSuggestions' = '[]'::JSONB
      AND score_snapshot->'suggestions' = '[]'::JSONB
      AND score_snapshot->>'authority' = 'deterministic_policy'
      AND CASE WHEN jsonb_typeof(request_intent->'request'->'expectedAccountRevision') = 'number'
        AND request_intent->'request'->>'expectedAccountRevision' ~ '^[1-9][0-9]{0,9}$'
        THEN (request_intent->'request'->>'expectedAccountRevision')::BIGINT <= 2147483647
          AND score_snapshot->>'accountRevisionId' = account_id || ':v' || (request_intent->'request'->>'expectedAccountRevision')
        ELSE FALSE END
    ), FALSE)
  );

INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (226,'customer_health_evaluation_intents_v1','d84ef7defa1802422dd887651f706bc169c0da90818dff5a05e061a4c3babc0d',clock_timestamp());
COMMIT;
