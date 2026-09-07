BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 120
      AND name = 'trash_lifecycle_v1'
      AND checksum = '49c6af6f71d05afa4f10aa2d966381f2614fe8e9037347cd247d7b56a332049c'
  ) <> 1 THEN
    RAISE EXCEPTION 'Approval grant predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_approval_grants (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_approval_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  domain TEXT NOT NULL,
  action_class TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_contract_sha256 TEXT NOT NULL,
  target_sha256 TEXT NOT NULL,
  executing_principal_type TEXT NOT NULL,
  executing_principal_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  used_uses SMALLINT NOT NULL DEFAULT 0,
  max_uses SMALLINT NOT NULL,
  lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  grant JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, grant_id),
  UNIQUE (tenant_id, owner_actor_id, grant_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (grant_id ~ '^grant:[0-9a-f-]{36}$'),
  CHECK (char_length(source_approval_id) BETWEEN 1 AND 500),
  CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(plan_id) BETWEEN 1 AND 500),
  CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(domain) BETWEEN 1 AND 500),
  CHECK (char_length(action_class) BETWEEN 1 AND 500),
  CHECK (char_length(tool_id) BETWEEN 1 AND 500),
  CHECK (tool_contract_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (executing_principal_type IN ('user', 'agent', 'system')),
  CHECK (char_length(executing_principal_id) BETWEEN 1 AND 500),
  CHECK (state IN ('active', 'exhausted', 'revoked', 'expired')),
  CHECK (used_uses BETWEEN 0 AND 100),
  CHECK (max_uses BETWEEN 1 AND 100),
  CHECK (used_uses <= max_uses),
  CHECK ((state = 'exhausted') = (used_uses = max_uses)),
  CHECK (state <> 'active' OR used_uses < max_uses),
  CHECK (lifecycle_revision BETWEEN 1 AND 9007199254740991),
  CHECK (issued_at < expires_at),
  CHECK (expires_at <= issued_at + INTERVAL '24 hours'),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (jsonb_typeof(grant) = 'object'),
  CHECK (grant->>'version' = 'p9.4-approval-grant:1'),
  CHECK (grant->>'grantId' = grant_id),
  CHECK (grant->>'tenantId' = tenant_id),
  CHECK (grant->>'ownerActorId' = owner_actor_id),
  CHECK (grant->>'sourceApprovalId' = source_approval_id),
  CHECK (grant->>'bindingSha256' = binding_sha256),
  CHECK (grant->>'planId' = plan_id),
  CHECK (grant->>'planSha256' = plan_sha256),
  CHECK (grant->>'domain' = domain),
  CHECK (grant->>'actionClass' = action_class),
  CHECK (grant->>'toolId' = tool_id),
  CHECK (grant->>'toolContractSha256' = tool_contract_sha256),
  CHECK (grant->>'targetSha256' = target_sha256),
  CHECK (grant->>'executingPrincipalType' = executing_principal_type),
  CHECK (grant->>'executingPrincipalId' = executing_principal_id),
  CHECK (grant->>'state' = state),
  CHECK ((grant->>'usedUses')::SMALLINT = used_uses),
  CHECK ((grant->>'maxUses')::SMALLINT = max_uses),
  CHECK ((grant->>'lifecycleRevision')::BIGINT = lifecycle_revision),
  CHECK ((grant->>'issuedAt')::TIMESTAMPTZ = issued_at),
  CHECK ((grant->>'expiresAt')::TIMESTAMPTZ = expires_at),
  CHECK (
    (last_used_at IS NULL AND grant->'lastUsedAt' = 'null'::JSONB)
    OR (grant->>'lastUsedAt')::TIMESTAMPTZ = last_used_at
  ),
  CHECK (
    (revoked_at IS NULL AND grant->'revokedAt' = 'null'::JSONB)
    OR (grant->>'revokedAt')::TIMESTAMPTZ = revoked_at
  )
);

CREATE INDEX IF NOT EXISTS omni_approval_grants_plan_idx
ON omni_approval_grants (
  tenant_id, owner_actor_id, plan_id, plan_sha256, state, expires_at
);

CREATE INDEX IF NOT EXISTS omni_approval_grants_match_idx
ON omni_approval_grants (
  tenant_id, owner_actor_id, executing_principal_id, action_class,
  tool_contract_sha256, target_sha256, state
);

CREATE TABLE IF NOT EXISTS omni_approval_grant_claims (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_binding_sha256 TEXT NOT NULL,
  execution_key_sha256 TEXT NOT NULL,
  use_ordinal SMALLINT NOT NULL,
  claim JSONB NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, claim_id),
  UNIQUE (tenant_id, owner_actor_id, grant_id, execution_key_sha256),
  UNIQUE (tenant_id, owner_actor_id, grant_id, use_ordinal),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (claim_id ~ '^claim:[0-9a-f-]{36}$'),
  CHECK (grant_id ~ '^grant:[0-9a-f-]{36}$'),
  CHECK (grant_binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (execution_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (use_ordinal BETWEEN 1 AND 100),
  CHECK (jsonb_typeof(claim) = 'object'),
  CHECK (claim->>'version' = 'p9.4-approval-grant-claim:1'),
  CHECK (claim->>'claimId' = claim_id),
  CHECK (claim->>'grantId' = grant_id),
  CHECK (claim->>'grantBindingSha256' = grant_binding_sha256),
  CHECK (claim->>'tenantId' = tenant_id),
  CHECK (claim->>'ownerActorId' = owner_actor_id),
  CHECK (claim->>'executionKeySha256' = execution_key_sha256),
  CHECK ((claim->>'useOrdinal')::SMALLINT = use_ordinal),
  CHECK ((claim->>'claimedAt')::TIMESTAMPTZ = claimed_at),
  FOREIGN KEY (tenant_id, owner_actor_id, grant_id)
    REFERENCES omni_approval_grants (tenant_id, owner_actor_id, grant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS omni_approval_grant_claims_grant_idx
ON omni_approval_grant_claims (
  tenant_id, owner_actor_id, grant_id, use_ordinal
);

CREATE OR REPLACE FUNCTION omni_protect_approval_grants_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Approval grant audit records cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'omni_approval_grant_claims' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Approval grant claims are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.used_uses <> 0
      OR NEW.lifecycle_revision <> 1 OR NEW.last_used_at IS NOT NULL
      OR NEW.revoked_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Initial approval grant is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'active'
    OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
    OR ROW(
      NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.grant_id,
      NEW.source_approval_id, NEW.binding_sha256, NEW.plan_id,
      NEW.plan_sha256, NEW.domain, NEW.action_class, NEW.tool_id,
      NEW.tool_contract_sha256, NEW.target_sha256,
      NEW.executing_principal_type, NEW.executing_principal_id,
      NEW.max_uses, NEW.issued_at, NEW.expires_at
    ) IS DISTINCT FROM ROW(
      OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.grant_id,
      OLD.source_approval_id, OLD.binding_sha256, OLD.plan_id,
      OLD.plan_sha256, OLD.domain, OLD.action_class, OLD.tool_id,
      OLD.tool_contract_sha256, OLD.target_sha256,
      OLD.executing_principal_type, OLD.executing_principal_id,
      OLD.max_uses, OLD.issued_at, OLD.expires_at
    )
    OR NOT (
      (NEW.used_uses = OLD.used_uses + 1
        AND NEW.last_used_at IS NOT NULL
        AND NEW.revoked_at IS NULL
        AND NEW.state IN ('active', 'exhausted'))
      OR (NEW.used_uses = OLD.used_uses
        AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
        AND NEW.state = 'revoked'
        AND NEW.revoked_at IS NOT NULL)
      OR (NEW.used_uses = OLD.used_uses
        AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
        AND NEW.state = 'expired'
        AND NEW.revoked_at IS NULL)
    )
  THEN
    RAISE EXCEPTION 'Approval grant lifecycle mutation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_approval_grants', 'omni_approval_grant_claims'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_approval_grants_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_approval_grants_v1()',
      table_name || '_no_truncate', table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_actor', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE omni_approval_grants FROM PUBLIC;
REVOKE ALL ON TABLE omni_approval_grant_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_approval_grants_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_approval_grants FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE omni_approval_grant_claims FROM omni_runtime';
    GRANT SELECT, INSERT ON omni_approval_grants TO omni_runtime;
    GRANT UPDATE (
      state, used_uses, lifecycle_revision, grant, last_used_at, revoked_at
    ) ON omni_approval_grants TO omni_runtime;
    GRANT SELECT, INSERT ON omni_approval_grant_claims TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_approval_grants FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE omni_approval_grant_claims FROM omni_maintenance';
    GRANT SELECT, INSERT ON omni_approval_grants TO omni_maintenance;
    GRANT UPDATE (
      state, used_uses, lifecycle_revision, grant, last_used_at, revoked_at
    ) ON omni_approval_grants TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_approval_grant_claims TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name IN ('omni_approval_grants', 'omni_approval_grant_claims')
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema = current_schema()
      AND table_name = 'omni_approval_grants'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
      AND column_name NOT IN (
        'state', 'used_uses', 'lifecycle_revision', 'grant',
        'last_used_at', 'revoked_at'
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN ('omni_approval_grants', 'omni_approval_grant_claims')
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'omni_approval_grants'::regclass,
      'omni_approval_grant_claims'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 2 THEN
    RAISE EXCEPTION 'Approval grant boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  121,
  'approval_grants_v1',
  '870ddeb8b46148b6c19c0d27703b0d7d49454f8daf4752bf155cb9d9f5b20338',
  NOW()
);

COMMIT;
