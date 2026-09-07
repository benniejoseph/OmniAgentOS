BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 136
      AND name = 'meeting_commitment_conversion_v1'
      AND checksum = 'ab838fcbc59a03d497e77b256e2d7f0e85bd5576ac4fa9980434b764fb9765be'
  ) <> 1 THEN
    RAISE EXCEPTION 'Customer Account 360 predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_customer_account_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  account_sha256 TEXT NOT NULL,
  account_snapshot JSONB NOT NULL,
  revised_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, revision_id),
  UNIQUE (tenant_id, workspace_id, account_id, revision),
  UNIQUE (tenant_id, workspace_id, account_id, mutation_id),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (account_id ~ '^customer-account:[a-f0-9]{64}$'),
  CHECK (revision >= 1),
  CHECK (revision_id = account_id || ':v' || revision::TEXT),
  CHECK (mutation_id ~ '^customer-mutation:[a-f0-9]{64}$'),
  CHECK (array_ndims(allowed_purpose_ids) = 1),
  CHECK (array_lower(allowed_purpose_ids, 1) = 1),
  CHECK (cardinality(allowed_purpose_ids) BETWEEN 2 AND 5),
  CHECK (omni_source_id_array_is_canonical(allowed_purpose_ids, 5)),
  CHECK ('customer_success.account.read' = ANY(allowed_purpose_ids)),
  CHECK ('customer_success.account.manage' = ANY(allowed_purpose_ids)),
  CHECK (allowed_purpose_ids <@ ARRAY[
    'customer_success.account.read',
    'customer_success.account.manage',
    'customer_success.meeting_follow_up',
    'customer_success.analytics',
    'customer_success.crm_sync'
  ]::TEXT[]),
  CHECK (account_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((account_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (account_snapshot ->> 'contractVersion' = 'p10.9-customer-account-360:1'),
  CHECK (account_snapshot ->> 'tenantId' = tenant_id),
  CHECK (account_snapshot ->> 'workspaceId' = workspace_id),
  CHECK (account_snapshot ->> 'accountId' = account_id),
  CHECK (account_snapshot ->> 'revisionId' = revision_id),
  CHECK ((account_snapshot ->> 'revision')::INTEGER = revision),
  CHECK (account_snapshot ->> 'mutationId' = mutation_id),
  CHECK (account_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (account_snapshot -> 'crmPermissions' ->> 'writeScope' = 'account_owner'),
  CHECK (account_snapshot -> 'crmPermissions' ->> 'externalWriteState' = 'disabled'),
  CHECK (account_snapshot ->> 'accountSha256' = account_sha256)
);

CREATE TABLE omni_customer_accounts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  current_revision_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  account_sha256 TEXT NOT NULL,
  account_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revised_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, account_id),
  FOREIGN KEY (tenant_id, workspace_id, current_revision_id)
    REFERENCES omni_customer_account_revisions (
      tenant_id, workspace_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (account_id ~ '^customer-account:[a-f0-9]{64}$'),
  CHECK (current_revision >= 1),
  CHECK (current_revision_id = account_id || ':v' || current_revision::TEXT),
  CHECK (char_length(name) BETWEEN 1 AND 240),
  CHECK (lifecycle IN ('prospect', 'onboarding', 'active', 'at_risk', 'churned', 'archived')),
  CHECK (revised_at >= created_at),
  CHECK (array_ndims(allowed_purpose_ids) = 1),
  CHECK (array_lower(allowed_purpose_ids, 1) = 1),
  CHECK (cardinality(allowed_purpose_ids) BETWEEN 2 AND 5),
  CHECK (omni_source_id_array_is_canonical(allowed_purpose_ids, 5)),
  CHECK ('customer_success.account.read' = ANY(allowed_purpose_ids)),
  CHECK ('customer_success.account.manage' = ANY(allowed_purpose_ids)),
  CHECK (account_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((account_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (account_snapshot ->> 'accountId' = account_id),
  CHECK (account_snapshot ->> 'revisionId' = current_revision_id),
  CHECK ((account_snapshot ->> 'revision')::INTEGER = current_revision),
  CHECK (account_snapshot ->> 'name' = name),
  CHECK (account_snapshot ->> 'lifecycle' = lifecycle),
  CHECK (account_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (account_snapshot -> 'crmPermissions' ->> 'writeScope' = 'account_owner'),
  CHECK (account_snapshot -> 'crmPermissions' ->> 'externalWriteState' = 'disabled'),
  CHECK (account_snapshot ->> 'accountSha256' = account_sha256)
);

CREATE TABLE omni_customer_fact_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fact_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_kind TEXT NOT NULL,
  fact_state TEXT NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  value_sha256 TEXT NOT NULL,
  source_revision_sha256 TEXT NOT NULL,
  fact_sha256 TEXT NOT NULL,
  fact_snapshot JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, fact_revision_id),
  UNIQUE (tenant_id, workspace_id, account_id, fact_id, revision),
  UNIQUE (tenant_id, workspace_id, account_id, mutation_id),
  FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (account_id ~ '^customer-account:[a-f0-9]{64}$'),
  CHECK (fact_id ~ '^customer-fact:[a-f0-9]{64}$'),
  CHECK (fact_revision_id = fact_id || ':v' || revision::TEXT),
  CHECK (revision >= 1),
  CHECK (mutation_id ~ '^customer-mutation:[a-f0-9]{64}$'),
  CHECK (fact_key ~ '^[a-z0-9][a-z0-9._:-]{0,159}$'),
  CHECK (fact_kind IN (
    'organization', 'contact', 'stakeholder', 'product', 'opportunity',
    'case', 'usage', 'project', 'interaction', 'health', 'risk', 'renewal'
  )),
  CHECK (fact_state IN ('active', 'retracted')),
  CHECK (array_ndims(allowed_purpose_ids) = 1),
  CHECK (array_lower(allowed_purpose_ids, 1) = 1),
  CHECK (cardinality(allowed_purpose_ids) BETWEEN 1 AND 5),
  CHECK (omni_source_id_array_is_canonical(allowed_purpose_ids, 5)),
  CHECK ('customer_success.account.read' = ANY(allowed_purpose_ids)),
  CHECK (value_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (fact_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((fact_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (fact_snapshot ->> 'contractVersion' = 'p10.9-customer-account-360:1'),
  CHECK (fact_snapshot ->> 'accountId' = account_id),
  CHECK (fact_snapshot ->> 'factId' = fact_id),
  CHECK (fact_snapshot ->> 'factRevisionId' = fact_revision_id),
  CHECK ((fact_snapshot ->> 'revision')::INTEGER = revision),
  CHECK (fact_snapshot ->> 'mutationId' = mutation_id),
  CHECK (fact_snapshot ->> 'factKey' = fact_key),
  CHECK (fact_snapshot ->> 'kind' = fact_kind),
  CHECK (fact_snapshot ->> 'state' = fact_state),
  CHECK (fact_snapshot ->> 'valueSha256' = value_sha256),
  CHECK (fact_snapshot -> 'source' ->> 'sourceRevisionSha256' = source_revision_sha256),
  CHECK (fact_snapshot ->> 'factSha256' = fact_sha256),
  CHECK (fact_snapshot ->> 'recordedByActorId' = owner_actor_id)
);

CREATE INDEX omni_customer_accounts_lifecycle_idx
  ON omni_customer_accounts (
    tenant_id, workspace_id, lifecycle, revised_at DESC, account_id
  );
CREATE INDEX omni_customer_account_history_idx
  ON omni_customer_account_revisions (
    tenant_id, workspace_id, account_id, revision DESC
  );
CREATE INDEX omni_customer_fact_current_idx
  ON omni_customer_fact_revisions (
    tenant_id, workspace_id, account_id, fact_id, revision DESC
  );
CREATE INDEX omni_customer_fact_rollup_idx
  ON omni_customer_fact_revisions (
    tenant_id, workspace_id, account_id, fact_kind, fact_key, recorded_at DESC
  ) WHERE fact_state = 'active';

CREATE FUNCTION omni_customer_workspace_access_v1_allows(
  row_tenant_id TEXT,
  row_workspace_id TEXT,
  row_owner_actor_id TEXT,
  require_write BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    public.omni_system_scope_enabled()
    OR EXISTS (
      SELECT 1
      FROM public.omni_tenant_workspace_memberships membership
      WHERE membership.tenant_id = row_tenant_id
        AND membership.workspace_id = row_workspace_id
        AND membership.subject_kind = 'user'
        AND membership.state = 'active'
        AND (NOT require_write OR membership.access_level IN ('contributor', 'manager'))
        AND (NOT require_write OR membership.subject_actor_id = row_owner_actor_id)
        AND public.omni_actor_scope_v1_allows_canonical(
          membership.tenant_id, membership.subject_actor_id
        )
    ),
    FALSE
  )
$function$;

CREATE FUNCTION omni_protect_customer_evidence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Customer Account 360 evidence is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_protect_customer_account_projection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Customer account projections cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision <> 1 OR NEW.created_at <> NEW.revised_at THEN
      RAISE EXCEPTION 'Initial customer account projection is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.account_id <> NEW.account_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.current_revision <> OLD.current_revision + 1
    OR NEW.revised_at <= OLD.revised_at
  THEN
    RAISE EXCEPTION 'Customer account projection transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_customer_account_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_customer_account_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_account_revisions_no_truncate
  BEFORE TRUNCATE ON omni_customer_account_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_fact_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_customer_fact_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_fact_revisions_no_truncate
  BEFORE TRUNCATE ON omni_customer_fact_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_evidence_v1();
CREATE TRIGGER omni_customer_accounts_protected
  BEFORE INSERT OR UPDATE OR DELETE ON omni_customer_accounts
  FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_account_projection_v1();
CREATE TRIGGER omni_customer_accounts_no_truncate
  BEFORE TRUNCATE ON omni_customer_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_account_projection_v1();

ALTER TABLE omni_customer_account_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_account_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_fact_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_customer_fact_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_customer_account_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_customer_accounts
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_customer_fact_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_customer_accounts_read_scope ON omni_customer_accounts
  AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, FALSE
    )
  );
CREATE POLICY omni_customer_accounts_insert_scope ON omni_customer_accounts
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    'customer_success.account.manage' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    )
  );
CREATE POLICY omni_customer_accounts_update_scope ON omni_customer_accounts
  AS RESTRICTIVE FOR UPDATE
  USING (omni_customer_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ))
  WITH CHECK (
    'customer_success.account.manage' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    )
  );

CREATE POLICY omni_customer_account_revisions_read_scope
  ON omni_customer_account_revisions AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, FALSE
    )
  );
CREATE POLICY omni_customer_account_revisions_insert_scope
  ON omni_customer_account_revisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    'customer_success.account.manage' = ANY(allowed_purpose_ids)
    AND omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    )
  );

CREATE POLICY omni_customer_fact_revisions_read_scope
  ON omni_customer_fact_revisions AS RESTRICTIVE FOR SELECT
  USING (
    'customer_success.account.read' = ANY(allowed_purpose_ids)
    AND EXISTS (
      SELECT 1 FROM omni_customer_accounts account
      WHERE account.tenant_id = omni_customer_fact_revisions.tenant_id
        AND account.workspace_id = omni_customer_fact_revisions.workspace_id
        AND account.account_id = omni_customer_fact_revisions.account_id
        AND omni_customer_workspace_access_v1_allows(
          account.tenant_id, account.workspace_id, account.owner_actor_id, FALSE
        )
    )
  );
CREATE POLICY omni_customer_fact_revisions_insert_scope
  ON omni_customer_fact_revisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM omni_customer_accounts account
    WHERE account.tenant_id = omni_customer_fact_revisions.tenant_id
      AND account.workspace_id = omni_customer_fact_revisions.workspace_id
      AND account.account_id = omni_customer_fact_revisions.account_id
      AND omni_customer_fact_revisions.allowed_purpose_ids <@ account.allowed_purpose_ids
      AND omni_customer_workspace_access_v1_allows(
        account.tenant_id, account.workspace_id, account.owner_actor_id, TRUE
      )
  ));

REVOKE ALL ON FUNCTION omni_customer_workspace_access_v1_allows(
  TEXT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_customer_evidence_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_customer_account_projection_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_customer_workspace_access_v1_allows(
      TEXT, TEXT, TEXT, BOOLEAN
    ) TO omni_runtime;
    REVOKE ALL ON TABLE omni_customer_account_revisions,
      omni_customer_accounts, omni_customer_fact_revisions FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_customer_account_revisions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_customer_accounts TO omni_runtime;
    GRANT SELECT, INSERT ON omni_customer_fact_revisions TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_customer_account_revisions TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_customer_accounts TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_customer_fact_revisions TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_customer_account_revisions,
      omni_customer_accounts, omni_customer_fact_revisions TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_customer_account_revisions'::regclass
      AND tgname = 'omni_customer_account_revisions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_customer_accounts'::regclass
      AND polname = 'omni_customer_accounts_read_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_customer_fact_revisions'::regclass
      AND polname = 'omni_customer_fact_revisions_insert_scope'
      AND NOT polpermissive
  ) THEN
    RAISE EXCEPTION 'Customer Account 360 schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  137,
  'customer_account_360_v1',
  'b9612ed4eb81a1a34496d22cead72ba782facc9594085eef551584ebb97a0c07',
  clock_timestamp()
);

COMMIT;
