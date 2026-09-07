BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 139
      AND name = 'salesforce_guarded_writes_v1'
      AND checksum = '1abb9529ce56ff31484da98bc52de725d7c6402792dbff1b0b1706abc7c9f1e1'
  ) <> 1 THEN
    RAISE EXCEPTION 'Customer health scoring predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_customer_health_policies (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  policy_sha256 TEXT NOT NULL,
  policy_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, account_id, policy_id),
  FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (workspace_id ~ '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'),
  CHECK (policy_id ~ '^customer-health-policy:[a-f0-9]{64}$'),
  CHECK (policy_version = 'asael-customer-health:1'),
  CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read']::TEXT[]),
  CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (policy_snapshot ->> 'policyId' = policy_id),
  CHECK (policy_snapshot ->> 'policyVersion' = policy_version),
  CHECK (policy_snapshot ->> 'policySha256' = policy_sha256)
);

CREATE TABLE omni_customer_health_score_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  score_id TEXT NOT NULL,
  score_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  evaluation_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  account_sha256 TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  score_basis_points INTEGER,
  health_status TEXT NOT NULL,
  confidence_basis_points INTEGER NOT NULL,
  coverage_basis_points INTEGER NOT NULL,
  score_sha256 TEXT NOT NULL,
  score_snapshot JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, account_id, score_revision_id),
  UNIQUE (tenant_id, workspace_id, account_id, revision),
  UNIQUE (tenant_id, workspace_id, account_id, evaluation_id),
  FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, account_id, policy_id)
    REFERENCES omni_customer_health_policies (
      tenant_id, workspace_id, account_id, policy_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (score_id ~ '^customer-health-score:[a-f0-9]{64}$'),
  CHECK (score_revision_id = score_id || ':v' || revision::TEXT),
  CHECK (revision >= 1),
  CHECK (evaluation_id ~ '^customer-health-evaluation:[a-f0-9]{64}$'),
  CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read']::TEXT[]),
  CHECK (account_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (score_basis_points BETWEEN 0 AND 10000 OR score_basis_points IS NULL),
  CHECK (health_status IN ('healthy', 'watch', 'at_risk', 'unknown')),
  CHECK ((score_basis_points IS NULL) = (health_status = 'unknown')),
  CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  CHECK (coverage_basis_points BETWEEN 0 AND 10000),
  CHECK (score_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (score_snapshot ->> 'accountId' = account_id),
  CHECK (score_snapshot ->> 'scoreId' = score_id),
  CHECK (score_snapshot ->> 'scoreRevisionId' = score_revision_id),
  CHECK ((score_snapshot ->> 'revision')::INTEGER = revision),
  CHECK (score_snapshot ->> 'evaluationId' = evaluation_id),
  CHECK (score_snapshot -> 'policy' ->> 'policyId' = policy_id),
  CHECK (score_snapshot ->> 'accountSha256' = account_sha256),
  CHECK (score_snapshot ->> 'inputSha256' = input_sha256),
  CHECK (score_snapshot ->> 'status' = health_status),
  CHECK ((score_snapshot ->> 'confidenceBasisPoints')::INTEGER = confidence_basis_points),
  CHECK ((score_snapshot ->> 'coverageBasisPoints')::INTEGER = coverage_basis_points),
  CHECK (score_snapshot ->> 'scoreSha256' = score_sha256)
);

CREATE TABLE omni_customer_health_scores (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  score_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  evaluation_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  account_sha256 TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  score_basis_points INTEGER,
  health_status TEXT NOT NULL,
  confidence_basis_points INTEGER NOT NULL,
  coverage_basis_points INTEGER NOT NULL,
  score_sha256 TEXT NOT NULL,
  score_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, account_id),
  UNIQUE (tenant_id, workspace_id, score_id),
  FOREIGN KEY (tenant_id, workspace_id, account_id, current_revision_id)
    REFERENCES omni_customer_health_score_revisions (
      tenant_id, workspace_id, account_id, score_revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (score_id ~ '^customer-health-score:[a-f0-9]{64}$'),
  CHECK (current_revision_id = score_id || ':v' || current_revision::TEXT),
  CHECK (current_revision >= 1),
  CHECK (evaluation_id ~ '^customer-health-evaluation:[a-f0-9]{64}$'),
  CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read']::TEXT[]),
  CHECK (account_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (score_basis_points BETWEEN 0 AND 10000 OR score_basis_points IS NULL),
  CHECK (health_status IN ('healthy', 'watch', 'at_risk', 'unknown')),
  CHECK ((score_basis_points IS NULL) = (health_status = 'unknown')),
  CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  CHECK (coverage_basis_points BETWEEN 0 AND 10000),
  CHECK (score_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (score_snapshot ->> 'accountId' = account_id),
  CHECK (score_snapshot ->> 'scoreId' = score_id),
  CHECK (score_snapshot ->> 'scoreRevisionId' = current_revision_id),
  CHECK ((score_snapshot ->> 'revision')::INTEGER = current_revision),
  CHECK (score_snapshot ->> 'evaluationId' = evaluation_id),
  CHECK (score_snapshot -> 'policy' ->> 'policyId' = policy_id),
  CHECK (score_snapshot ->> 'accountSha256' = account_sha256),
  CHECK (score_snapshot ->> 'inputSha256' = input_sha256),
  CHECK (score_snapshot ->> 'status' = health_status),
  CHECK ((score_snapshot ->> 'confidenceBasisPoints')::INTEGER = confidence_basis_points),
  CHECK ((score_snapshot ->> 'coverageBasisPoints')::INTEGER = coverage_basis_points),
  CHECK (score_snapshot ->> 'scoreSha256' = score_sha256),
  CHECK (evaluated_at >= created_at)
);

CREATE INDEX omni_customer_health_portfolio_idx
  ON omni_customer_health_scores (
    tenant_id, workspace_id, health_status, score_basis_points, evaluated_at DESC
  );
CREATE INDEX omni_customer_health_history_idx
  ON omni_customer_health_score_revisions (
    tenant_id, workspace_id, account_id, revision DESC
  );

CREATE FUNCTION omni_protect_customer_health_projection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Customer health projections cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision <> 1 OR NEW.created_at <> NEW.evaluated_at THEN
      RAISE EXCEPTION 'Initial customer health projection is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.account_id <> NEW.account_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.score_id <> NEW.score_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.current_revision <> OLD.current_revision + 1
    OR NEW.evaluated_at <= OLD.evaluated_at
  THEN
    RAISE EXCEPTION 'Customer health projection transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_customer_health_policies_immutable
  BEFORE UPDATE OR DELETE ON omni_customer_health_policies
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_health_policies_no_truncate
  BEFORE TRUNCATE ON omni_customer_health_policies
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_health_score_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_customer_health_score_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_health_score_revisions_no_truncate
  BEFORE TRUNCATE ON omni_customer_health_score_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_health_scores_protected
  BEFORE INSERT OR UPDATE OR DELETE ON omni_customer_health_scores
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_health_projection_v1();
CREATE TRIGGER omni_customer_health_scores_no_truncate
  BEFORE TRUNCATE ON omni_customer_health_scores
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_health_projection_v1();

ALTER TABLE omni_customer_health_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_health_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_health_score_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_health_score_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_health_scores FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_customer_health_policies
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_customer_health_score_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_customer_health_scores
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_customer_health_policies_read_scope
  ON omni_customer_health_policies AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, FALSE
    )
  );
CREATE POLICY omni_customer_health_policies_insert_scope
  ON omni_customer_health_policies AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

CREATE POLICY omni_customer_health_score_revisions_read_scope
  ON omni_customer_health_score_revisions AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, FALSE
    )
  );
CREATE POLICY omni_customer_health_score_revisions_insert_scope
  ON omni_customer_health_score_revisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

CREATE POLICY omni_customer_health_scores_read_scope
  ON omni_customer_health_scores AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, FALSE
    )
  );
CREATE POLICY omni_customer_health_scores_insert_scope
  ON omni_customer_health_scores AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_customer_health_scores_update_scope
  ON omni_customer_health_scores AS RESTRICTIVE FOR UPDATE
  USING (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ))
  WITH CHECK (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

REVOKE ALL ON FUNCTION omni_protect_customer_health_projection_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_customer_health_policies,
      omni_customer_health_score_revisions, omni_customer_health_scores
      FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_customer_health_policies,
      omni_customer_health_score_revisions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_customer_health_scores TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_customer_health_policies,
      omni_customer_health_score_revisions TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_customer_health_scores TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_customer_health_policies,
      omni_customer_health_score_revisions, omni_customer_health_scores
      TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_customer_health_score_revisions'::regclass
      AND tgname = 'omni_customer_health_score_revisions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_customer_health_scores'::regclass
      AND polname = 'omni_customer_health_scores_update_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'omni_customer_health_scores'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Customer health scoring schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  140,
  'customer_health_scoring_v1',
  '91f12ad0fdae25496f14bf21751491470f4572bcb58c587360373dc038b063e2',
  clock_timestamp()
);

COMMIT;
