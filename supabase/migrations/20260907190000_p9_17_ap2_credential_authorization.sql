BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 125
      AND name = 'ap2_human_present_mandates_v1'
      AND checksum = 'f8b75e5d61a3a347649d82909e8e18e6f174079d37a5609643df768c0c9031a5'
  ) <> 1 THEN
    RAISE EXCEPTION 'AP2 credential authorization predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_ap2_credential_grants (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  processor_id TEXT NOT NULL,
  provider_configuration_sha256 TEXT NOT NULL,
  provider_authorization_sha256 TEXT NOT NULL,
  scoped_token_sha256 TEXT NOT NULL,
  scope_sha256 TEXT NOT NULL,
  grant_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  grant_payload JSONB NOT NULL,
  provider_proof JSONB NOT NULL,
  sealed_authorization JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, owner_actor_id, grant_id),
  UNIQUE (tenant_id, owner_actor_id, review_id),
  UNIQUE (tenant_id, owner_actor_id, request_id),
  FOREIGN KEY (tenant_id, owner_actor_id, review_id)
    REFERENCES omni_ap2_mandate_reviews (tenant_id, owner_actor_id, review_id),
  FOREIGN KEY (tenant_id, owner_actor_id, authorization_id)
    REFERENCES omni_ap2_mandate_authorizations (tenant_id, owner_actor_id, authorization_id),
  CHECK (grant_id ~ '^ap2_credential_grant:[0-9a-f-]{36}$'),
  CHECK (request_id ~ '^ap2_credential_request:[0-9a-f-]{36}$'),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (provider_configuration_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (provider_authorization_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (scoped_token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (grant_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  CHECK (lifecycle_revision >= 1),
  CHECK (grant_payload ->> 'grantId' = grant_id),
  CHECK (grant_payload ->> 'tenantId' = tenant_id),
  CHECK (grant_payload ->> 'ownerActorId' = owner_actor_id),
  CHECK (grant_payload ->> 'reviewId' = review_id),
  CHECK (grant_payload ->> 'authorizationId' = authorization_id),
  CHECK (grant_payload ->> 'requestId' = request_id),
  CHECK (grant_payload ->> 'requestSha256' = request_sha256),
  CHECK (grant_payload ->> 'providerId' = provider_id),
  CHECK (grant_payload ->> 'providerConfigurationSha256' = provider_configuration_sha256),
  CHECK (grant_payload ->> 'providerAuthorizationSha256' = provider_authorization_sha256),
  CHECK (grant_payload ->> 'scopedTokenSha256' = scoped_token_sha256),
  CHECK (grant_payload ->> 'scopeSha256' = scope_sha256),
  CHECK (grant_payload ->> 'grantSha256' = grant_sha256),
  CHECK (grant_payload ->> 'state' = state),
  CHECK ((grant_payload ->> 'lifecycleRevision')::INTEGER = lifecycle_revision),
  CHECK (provider_proof ? 'signature' AND NOT (provider_proof ? 'scopedToken')),
  CHECK (
    (state = 'active' AND sealed_authorization IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL) OR
    (state = 'consumed' AND sealed_authorization IS NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL AND expired_at IS NULL) OR
    (state = 'revoked' AND sealed_authorization IS NULL AND consumed_at IS NULL AND revoked_at IS NOT NULL AND expired_at IS NULL) OR
    (state = 'expired' AND sealed_authorization IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS omni_ap2_credential_claims (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  processor_id TEXT NOT NULL,
  scope_sha256 TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  claim_sha256 TEXT NOT NULL,
  claim_payload JSONB NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, claim_id),
  UNIQUE (tenant_id, owner_actor_id, grant_id),
  UNIQUE (tenant_id, owner_actor_id, idempotency_key_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, grant_id)
    REFERENCES omni_ap2_credential_grants (tenant_id, owner_actor_id, grant_id),
  CHECK (claim_id ~ '^ap2_credential_claim:[0-9a-f-]{36}$'),
  CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (claim_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (claim_payload ->> 'claimId' = claim_id),
  CHECK (claim_payload ->> 'tenantId' = tenant_id),
  CHECK (claim_payload ->> 'ownerActorId' = owner_actor_id),
  CHECK (claim_payload ->> 'grantId' = grant_id),
  CHECK (claim_payload ->> 'merchantPaymentProcessorId' = processor_id),
  CHECK (claim_payload ->> 'scopeSha256' = scope_sha256),
  CHECK (claim_payload ->> 'idempotencyKeySha256' = idempotency_key_sha256),
  CHECK (claim_payload ->> 'claimSha256' = claim_sha256)
);

CREATE INDEX IF NOT EXISTS omni_ap2_credential_grants_owner_state_idx
  ON omni_ap2_credential_grants (tenant_id, owner_actor_id, state, expires_at);
CREATE INDEX IF NOT EXISTS omni_ap2_credential_grants_review_idx
  ON omni_ap2_credential_grants (tenant_id, owner_actor_id, review_id);

CREATE OR REPLACE FUNCTION omni_protect_ap2_credential_authorization_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'AP2 credential authorization records cannot be deleted or truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'omni_ap2_credential_claims' THEN
      RAISE EXCEPTION 'AP2 credential claims are append-only'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.owner_actor_id <> OLD.owner_actor_id OR
       NEW.grant_id <> OLD.grant_id OR NEW.review_id <> OLD.review_id OR
       NEW.authorization_id <> OLD.authorization_id OR NEW.request_id <> OLD.request_id OR
       NEW.request_sha256 <> OLD.request_sha256 OR NEW.provider_id <> OLD.provider_id OR
       NEW.processor_id <> OLD.processor_id OR
       NEW.provider_configuration_sha256 <> OLD.provider_configuration_sha256 OR
       NEW.provider_authorization_sha256 <> OLD.provider_authorization_sha256 OR
       NEW.scoped_token_sha256 <> OLD.scoped_token_sha256 OR
       NEW.scope_sha256 <> OLD.scope_sha256 OR NEW.provider_proof <> OLD.provider_proof OR
       NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at OR
       OLD.state <> 'active' OR NEW.state NOT IN ('consumed', 'revoked', 'expired') OR
       NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR
       OLD.sealed_authorization IS NULL OR NEW.sealed_authorization IS NOT NULL
    THEN
      RAISE EXCEPTION 'AP2 credential grant lifecycle update is invalid'
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
  'omni_ap2_credential_grants',
  'omni_ap2_credential_claims'
];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_ap2_credential_authorization_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_ap2_credential_authorization_v1()',
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

REVOKE ALL ON TABLE omni_ap2_credential_grants FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_credential_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_ap2_credential_authorization_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_ap2_credential_grants,
      omni_ap2_credential_claims FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_ap2_credential_grants TO omni_runtime;
    GRANT SELECT, INSERT ON omni_ap2_credential_claims TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE omni_ap2_credential_grants,
      omni_ap2_credential_claims FROM omni_maintenance;
    GRANT SELECT ON TABLE omni_ap2_credential_grants,
      omni_ap2_credential_claims TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
  'omni_ap2_credential_grants',
  'omni_ap2_credential_claims'
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
    RAISE EXCEPTION 'AP2 credential actor policy boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  126,
  'ap2_credential_authorization_v1',
  '58e206e5cf85d52958965d7ae06d89a1f61059ee41532970c3645b1dfff60708',
  clock_timestamp()
);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 126
      AND name = 'ap2_credential_authorization_v1'
      AND checksum = '58e206e5cf85d52958965d7ae06d89a1f61059ee41532970c3645b1dfff60708'
  ) <> 1 THEN
    RAISE EXCEPTION 'AP2 credential authorization migration integrity check failed'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

COMMIT;
