BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 124
      AND name = 'governed_communications_v1'
      AND checksum = 'b0199382bc9ed5a5fe99357b3deec7b0b3ed9de8921e89ed6705062b8e2b862f'
  ) <> 1 THEN
    RAISE EXCEPTION 'AP2 human-present mandate predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_ap2_signing_credentials (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL,
  trust_policy_sha256 TEXT NOT NULL,
  aaguid TEXT NOT NULL,
  state TEXT NOT NULL,
  counter BIGINT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  credential JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, owner_actor_id, credential_id),
  CHECK (char_length(credential_id) BETWEEN 1 AND 16384),
  CHECK (credential_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (trust_policy_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (aaguid ~ '^[a-f0-9-]{36}$'),
  CHECK (state IN ('active', 'revoked')),
  CHECK (counter >= 0),
  CHECK (lifecycle_revision >= 1),
  CHECK (credential ->> 'credentialId' = credential_id),
  CHECK (credential ->> 'tenantId' = tenant_id),
  CHECK (credential ->> 'ownerActorId' = owner_actor_id),
  CHECK (credential ->> 'credentialSha256' = credential_sha256),
  CHECK (credential ->> 'trustPolicySha256' = trust_policy_sha256),
  CHECK (credential ->> 'aaguid' = aaguid),
  CHECK (credential ->> 'state' = state),
  CHECK ((credential ->> 'counter')::BIGINT = counter),
  CHECK ((credential ->> 'lifecycleRevision')::INTEGER = lifecycle_revision)
);

CREATE TABLE IF NOT EXISTS omni_ap2_mandate_reviews (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  authorization_digest TEXT NOT NULL,
  exact_terms_sha256 TEXT NOT NULL,
  review_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  review JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  authorized_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, owner_actor_id, review_id),
  CHECK (review_id ~ '^ap2_review:[0-9a-f-]{36}$'),
  CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  CHECK (exact_terms_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state IN ('pending', 'authorized', 'expired', 'superseded')),
  CHECK (lifecycle_revision >= 1),
  CHECK (review ->> 'reviewId' = review_id),
  CHECK (review ->> 'tenantId' = tenant_id),
  CHECK (review ->> 'ownerActorId' = owner_actor_id),
  CHECK (review ->> 'intentSha256' = intent_sha256),
  CHECK (review ->> 'authorizationDigest' = authorization_digest),
  CHECK (review ->> 'exactTermsSha256' = exact_terms_sha256),
  CHECK (review ->> 'reviewSha256' = review_sha256),
  CHECK (review ->> 'state' = state),
  CHECK ((review ->> 'lifecycleRevision')::INTEGER = lifecycle_revision)
);

CREATE TABLE IF NOT EXISTS omni_ap2_mandate_authorizations (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL,
  authorization_payload JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, authorization_id),
  UNIQUE (tenant_id, owner_actor_id, review_id),
  FOREIGN KEY (tenant_id, owner_actor_id, review_id)
    REFERENCES omni_ap2_mandate_reviews (tenant_id, owner_actor_id, review_id),
  FOREIGN KEY (tenant_id, owner_actor_id, credential_id)
    REFERENCES omni_ap2_signing_credentials (tenant_id, owner_actor_id, credential_id),
  CHECK (authorization_id ~ '^ap2_authorization:[0-9a-f-]{36}$'),
  CHECK (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (authorization_payload ->> 'authorizationId' = authorization_id),
  CHECK (authorization_payload ->> 'tenantId' = tenant_id),
  CHECK (authorization_payload ->> 'ownerActorId' = owner_actor_id),
  CHECK (authorization_payload ->> 'reviewId' = review_id),
  CHECK (authorization_payload ->> 'credentialId' = credential_id),
  CHECK (authorization_payload ->> 'authorizationSha256' = authorization_sha256)
);

CREATE INDEX IF NOT EXISTS omni_ap2_credentials_owner_state_idx
  ON omni_ap2_signing_credentials (tenant_id, owner_actor_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS omni_ap2_reviews_owner_state_idx
  ON omni_ap2_mandate_reviews (tenant_id, owner_actor_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS omni_ap2_reviews_intent_idx
  ON omni_ap2_mandate_reviews (tenant_id, owner_actor_id, intent_sha256, created_at DESC);

CREATE OR REPLACE FUNCTION omni_protect_ap2_human_present_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'AP2 human-present records cannot be deleted or truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'omni_ap2_mandate_authorizations' THEN
      RAISE EXCEPTION 'AP2 mandate authorizations are append-only'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.owner_actor_id <> OLD.owner_actor_id THEN
      RAISE EXCEPTION 'AP2 owner scope is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_ap2_signing_credentials' AND (
      NEW.credential_id <> OLD.credential_id OR
      NEW.trust_policy_sha256 <> OLD.trust_policy_sha256 OR
      NEW.aaguid <> OLD.aaguid OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR
      NEW.counter < OLD.counter OR
      NOT (
        (OLD.state = 'active' AND NEW.state = 'active' AND NEW.revoked_at IS NULL AND NEW.last_used_at IS NOT NULL) OR
        (OLD.state = 'active' AND NEW.state = 'revoked' AND NEW.revoked_at IS NOT NULL)
      )
    ) THEN
      RAISE EXCEPTION 'AP2 signing credential lifecycle update is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_ap2_mandate_reviews' AND (
      NEW.review_id <> OLD.review_id OR
      NEW.intent_sha256 <> OLD.intent_sha256 OR
      NEW.authorization_digest <> OLD.authorization_digest OR
      NEW.exact_terms_sha256 <> OLD.exact_terms_sha256 OR
      NEW.expires_at <> OLD.expires_at OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR
      OLD.state <> 'pending' OR NEW.state NOT IN ('authorized', 'expired', 'superseded') OR
      (NEW.state = 'authorized' AND NEW.authorized_at IS NULL) OR
      (NEW.state = 'superseded' AND NEW.superseded_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'AP2 mandate review lifecycle update is invalid'
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
  'omni_ap2_signing_credentials',
  'omni_ap2_mandate_reviews',
  'omni_ap2_mandate_authorizations'
];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_ap2_human_present_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_ap2_human_present_v1()',
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

REVOKE ALL ON TABLE omni_ap2_signing_credentials FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_mandate_reviews FROM PUBLIC;
REVOKE ALL ON TABLE omni_ap2_mandate_authorizations FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_ap2_human_present_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_ap2_signing_credentials,
      omni_ap2_mandate_reviews, omni_ap2_mandate_authorizations FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_ap2_signing_credentials,
      omni_ap2_mandate_reviews TO omni_runtime;
    GRANT SELECT, INSERT ON omni_ap2_mandate_authorizations TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE omni_ap2_signing_credentials,
      omni_ap2_mandate_reviews, omni_ap2_mandate_authorizations FROM omni_maintenance;
    GRANT SELECT ON TABLE omni_ap2_signing_credentials,
      omni_ap2_mandate_reviews, omni_ap2_mandate_authorizations TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
  'omni_ap2_signing_credentials',
  'omni_ap2_mandate_reviews',
  'omni_ap2_mandate_authorizations'
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
    RAISE EXCEPTION 'AP2 actor policy boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  125,
  'ap2_human_present_mandates_v1',
  'f8b75e5d61a3a347649d82909e8e18e6f174079d37a5609643df768c0c9031a5',
  NOW()
);

COMMIT;
