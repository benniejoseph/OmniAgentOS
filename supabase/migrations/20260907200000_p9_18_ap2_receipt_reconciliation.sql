BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 126
      AND name = 'ap2_credential_authorization_v1'
      AND checksum = '58e206e5cf85d52958965d7ae06d89a1f61059ee41532970c3645b1dfff60708'
  ) <> 1 THEN
    RAISE EXCEPTION 'AP2 receipt reconciliation predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_ap2_payment_transactions (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  canonical_status TEXT NOT NULL,
  paid BOOLEAN NOT NULL,
  discrepancy BOOLEAN NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  projection_sha256 TEXT NOT NULL,
  projection JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, transaction_id),
  UNIQUE (tenant_id, owner_actor_id, review_id),
  UNIQUE (tenant_id, owner_actor_id, grant_id),
  FOREIGN KEY (tenant_id, owner_actor_id, review_id)
    REFERENCES omni_ap2_mandate_reviews (tenant_id, owner_actor_id, review_id),
  FOREIGN KEY (tenant_id, owner_actor_id, grant_id)
    REFERENCES omni_ap2_credential_grants (tenant_id, owner_actor_id, grant_id),
  CHECK (transaction_id ~ '^ap2_payment:[0-9a-f-]{36}$'),
  CHECK (amount_minor >= 0),
  CHECK (currency ~ '^[A-Z]{3}$'),
  CHECK (canonical_status IN (
    'pending', 'checkout_rejected', 'payment_rejected', 'authorized', 'paid',
    'settled', 'canceled', 'partially_refunded', 'refunded', 'disputed',
    'fulfilled', 'discrepancy'
  )),
  CHECK (paid = (canonical_status IN ('paid', 'settled', 'partially_refunded', 'fulfilled'))),
  CHECK (discrepancy = (canonical_status = 'discrepancy')),
  CHECK (lifecycle_revision >= 1),
  CHECK (projection_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (projection ->> 'transactionId' = transaction_id),
  CHECK (projection ->> 'tenantId' = tenant_id),
  CHECK (projection ->> 'ownerActorId' = owner_actor_id),
  CHECK (projection ->> 'reviewId' = review_id),
  CHECK (projection ->> 'grantId' = grant_id),
  CHECK ((projection ->> 'amountMinor')::BIGINT = amount_minor),
  CHECK (projection ->> 'currency' = currency),
  CHECK (projection ->> 'canonicalStatus' = canonical_status),
  CHECK ((projection ->> 'paid')::BOOLEAN = paid),
  CHECK ((projection ->> 'lifecycleRevision')::INTEGER = lifecycle_revision),
  CHECK (projection ->> 'projectionSha256' = projection_sha256)
);

CREATE TABLE IF NOT EXISTS omni_ap2_payment_receipts (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  jwt_sha256 TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  receipt_jwt TEXT NOT NULL,
  verified_receipt JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, receipt_id),
  UNIQUE (tenant_id, owner_actor_id, transaction_id, kind),
  UNIQUE (tenant_id, owner_actor_id, jwt_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, transaction_id)
    REFERENCES omni_ap2_payment_transactions (tenant_id, owner_actor_id, transaction_id),
  CHECK (receipt_id ~ '^ap2_receipt:[0-9a-f-]{36}$'),
  CHECK (kind IN ('checkout', 'payment')),
  CHECK (jwt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (length(receipt_jwt) BETWEEN 16 AND 300000),
  CHECK (verified_receipt ->> 'receiptId' = receipt_id),
  CHECK (verified_receipt ->> 'kind' = kind),
  CHECK (verified_receipt ->> 'tenantId' = tenant_id),
  CHECK (verified_receipt ->> 'ownerActorId' = owner_actor_id),
  CHECK (verified_receipt ->> 'authorityId' = authority_id),
  CHECK (verified_receipt ->> 'jwtSha256' = jwt_sha256),
  CHECK (verified_receipt ->> 'receiptSha256' = receipt_sha256)
);

CREATE TABLE IF NOT EXISTS omni_ap2_reconciliation_observations (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  authority_role TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  observation_sha256 TEXT NOT NULL,
  signed_observation JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, observation_id),
  UNIQUE (tenant_id, owner_actor_id, transaction_id, authority_id, sequence),
  UNIQUE (tenant_id, owner_actor_id, observation_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, transaction_id)
    REFERENCES omni_ap2_payment_transactions (tenant_id, owner_actor_id, transaction_id),
  CHECK (observation_id ~ '^ap2_reconciliation:[0-9a-f-]{36}$'),
  CHECK (authority_role IN ('merchant', 'merchant_payment_processor')),
  CHECK (sequence >= 1),
  CHECK (observation_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (signed_observation ->> 'observationId' = observation_id),
  CHECK (signed_observation ->> 'transactionId' = transaction_id),
  CHECK (signed_observation ->> 'authorityId' = authority_id),
  CHECK (signed_observation ->> 'authorityRole' = authority_role),
  CHECK ((signed_observation ->> 'sequence')::BIGINT = sequence),
  CHECK (signed_observation ->> 'observationSha256' = observation_sha256)
);

CREATE TABLE IF NOT EXISTS omni_ap2_reconciliation_jobs (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  request_payload JSONB NOT NULL,
  result_payload JSONB,
  lease_token_sha256 TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, owner_actor_id, job_id),
  UNIQUE (tenant_id, owner_actor_id, idempotency_key_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, transaction_id)
    REFERENCES omni_ap2_payment_transactions (tenant_id, owner_actor_id, transaction_id),
  CHECK (job_id ~ '^ap2_reconciliation_job:[0-9a-f-]{36}$'),
  CHECK (reason IN ('receipt_recorded', 'provider_event', 'scheduled', 'discrepancy', 'operator_requested')),
  CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state IN ('queued', 'running', 'completed', 'discrepancy', 'failed')),
  CHECK (attempt BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10),
  CHECK (lifecycle_revision >= 1),
  CHECK (lease_token_sha256 IS NULL OR lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (request_payload ->> 'jobId' = job_id),
  CHECK (request_payload ->> 'transactionId' = transaction_id),
  CHECK (request_payload ->> 'reason' = reason),
  CHECK (request_payload ->> 'idempotencyKeySha256' = idempotency_key_sha256),
  CHECK (request_payload ->> 'requestSha256' = request_sha256),
  CHECK (
    (state = 'queued' AND lease_token_sha256 IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL) OR
    (state = 'running' AND lease_token_sha256 IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL) OR
    (state IN ('completed', 'discrepancy', 'failed') AND lease_token_sha256 IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS omni_ap2_payment_transactions_owner_updated_idx
  ON omni_ap2_payment_transactions (tenant_id, owner_actor_id, updated_at DESC, transaction_id);
CREATE INDEX IF NOT EXISTS omni_ap2_payment_transactions_discrepancy_idx
  ON omni_ap2_payment_transactions (tenant_id, owner_actor_id, discrepancy, updated_at DESC);
CREATE INDEX IF NOT EXISTS omni_ap2_reconciliation_observations_latest_idx
  ON omni_ap2_reconciliation_observations
  (tenant_id, owner_actor_id, transaction_id, authority_role, sequence DESC);
CREATE INDEX IF NOT EXISTS omni_ap2_reconciliation_jobs_claim_idx
  ON omni_ap2_reconciliation_jobs (state, updated_at, job_id)
  WHERE state = 'queued';

CREATE OR REPLACE FUNCTION omni_protect_ap2_receipt_reconciliation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'AP2 receipt reconciliation records cannot be deleted or truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME IN ('omni_ap2_payment_receipts', 'omni_ap2_reconciliation_observations') THEN
      RAISE EXCEPTION 'AP2 receipts and reconciliation observations are append-only'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_ap2_payment_transactions' AND (
      NEW.tenant_id <> OLD.tenant_id OR NEW.owner_actor_id <> OLD.owner_actor_id OR
      NEW.transaction_id <> OLD.transaction_id OR NEW.review_id <> OLD.review_id OR
      NEW.grant_id <> OLD.grant_id OR NEW.amount_minor <> OLD.amount_minor OR
      NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR NEW.updated_at <= OLD.updated_at
    ) THEN
      RAISE EXCEPTION 'AP2 payment projection update is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_ap2_reconciliation_jobs' AND (
      NEW.tenant_id <> OLD.tenant_id OR NEW.owner_actor_id <> OLD.owner_actor_id OR
      NEW.job_id <> OLD.job_id OR NEW.transaction_id <> OLD.transaction_id OR
      NEW.reason <> OLD.reason OR NEW.idempotency_key_sha256 <> OLD.idempotency_key_sha256 OR
      NEW.request_sha256 <> OLD.request_sha256 OR NEW.request_payload <> OLD.request_payload OR
      NEW.max_attempts <> OLD.max_attempts OR NEW.created_at <> OLD.created_at OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR NEW.updated_at <= OLD.updated_at OR
      NOT (
        (OLD.state = 'queued' AND NEW.state = 'running' AND NEW.attempt = OLD.attempt + 1) OR
        (OLD.state = 'running' AND NEW.state = 'queued' AND NEW.attempt = OLD.attempt) OR
        (OLD.state = 'running' AND NEW.state IN ('completed', 'discrepancy', 'failed') AND NEW.attempt = OLD.attempt)
      )
    ) THEN
      RAISE EXCEPTION 'AP2 reconciliation job transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE table_name TEXT;
DECLARE policy_name TEXT;
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
  'omni_ap2_payment_transactions',
  'omni_ap2_payment_receipts',
  'omni_ap2_reconciliation_observations',
  'omni_ap2_reconciliation_jobs'
];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_ap2_receipt_reconciliation_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_ap2_receipt_reconciliation_v1()',
      table_name || '_no_truncate', table_name
    );
    FOR policy_name IN
      SELECT policy.polname FROM pg_policy policy
      WHERE policy.polrelid = to_regclass(table_name)
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, table_name);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE omni_ap2_payment_transactions FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_payment_receipts FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_reconciliation_observations FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_reconciliation_jobs FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_ap2_receipt_reconciliation_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_ap2_payment_transactions, omni_ap2_payment_receipts,
      omni_ap2_reconciliation_observations, omni_ap2_reconciliation_jobs FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_ap2_payment_transactions TO omni_runtime;
    GRANT SELECT, INSERT ON omni_ap2_payment_receipts,
      omni_ap2_reconciliation_observations TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_ap2_reconciliation_jobs TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE omni_ap2_payment_transactions, omni_ap2_payment_receipts,
      omni_ap2_reconciliation_observations, omni_ap2_reconciliation_jobs FROM omni_maintenance;
    GRANT SELECT ON TABLE omni_ap2_payment_transactions, omni_ap2_payment_receipts,
      omni_ap2_reconciliation_observations, omni_ap2_reconciliation_jobs TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
  'omni_ap2_payment_transactions',
  'omni_ap2_payment_receipts',
  'omni_ap2_reconciliation_observations',
  'omni_ap2_reconciliation_jobs'
];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relname = ANY(expected_tables)
      AND policy.polpermissive AND policy.polcmd = '*'
  ) <> cardinality(expected_tables) OR (
    SELECT count(*) FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relname = ANY(expected_tables)
  ) <> cardinality(expected_tables) THEN
    RAISE EXCEPTION 'AP2 receipt reconciliation actor policy boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  127,
  'ap2_receipt_reconciliation_v1',
  'b85bf6d553f897caa31d67ec907d5abf308572652dd45524da150e4ec4a60acb',
  clock_timestamp()
);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 127
      AND name = 'ap2_receipt_reconciliation_v1'
      AND checksum = 'b85bf6d553f897caa31d67ec907d5abf308572652dd45524da150e4ec4a60acb'
  ) <> 1 THEN
    RAISE EXCEPTION 'AP2 receipt reconciliation migration integrity check failed'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

COMMIT;
