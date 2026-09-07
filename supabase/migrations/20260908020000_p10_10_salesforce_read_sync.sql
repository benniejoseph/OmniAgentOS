BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 137
      AND name = 'customer_account_360_v1'
      AND checksum = 'b9612ed4eb81a1a34496d22cead72ba782facc9594085eef551584ebb97a0c07'
  ) <> 1 THEN
    RAISE EXCEPTION 'Salesforce read sync predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_salesforce_connections (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  oauth_grant_id TEXT NOT NULL,
  authorization_generation INTEGER NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  instance_origin TEXT NOT NULL,
  connection_state TEXT NOT NULL DEFAULT 'active',
  access_mode TEXT NOT NULL DEFAULT 'read_only',
  object_scope TEXT[] NOT NULL,
  allowed_purpose_ids TEXT[] NOT NULL,
  sync_cursor JSONB NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  sync_error JSONB,
  sync_lease_owner_id TEXT,
  sync_lease_generation INTEGER NOT NULL DEFAULT 0,
  sync_lease_expires_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  last_replay_id_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id),
  UNIQUE (tenant_id, workspace_id),
  UNIQUE (oauth_grant_id),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (oauth_grant_id) REFERENCES omni_oauth_grants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (connection_id ~ '^salesforce-connection:[a-f0-9]{64}$'),
  CHECK (authorization_generation >= 1),
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (instance_origin ~ '^https://[A-Za-z0-9.-]+\.(salesforce\.com|salesforce\.mil|cloudforce\.com)$'),
  CHECK (connection_state IN ('active', 'revoked', 'error')),
  CHECK (access_mode = 'read_only'),
  CHECK (object_scope <@ ARRAY['Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract']::TEXT[]),
  CHECK (object_scope @> ARRAY['Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract']::TEXT[]),
  CHECK (cardinality(object_scope) = 8),
  CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read', 'customer_success.crm_sync']::TEXT[]),
  CHECK (sync_cursor ->> 'version' = '1'),
  CHECK (jsonb_typeof(sync_cursor -> 'objects') = 'object'),
  CHECK (sync_status IN ('idle', 'backfilling', 'syncing', 'healthy', 'degraded', 'error')),
  CHECK (sync_error IS NULL OR (
    jsonb_typeof(sync_error) = 'object'
    AND sync_error ? 'code'
    AND sync_error ? 'message'
    AND sync_error ? 'action'
    AND sync_error ? 'occurredAt'
  )),
  CHECK ((sync_lease_owner_id IS NULL) = (sync_lease_expires_at IS NULL)),
  CHECK (sync_lease_owner_id IS NULL OR char_length(sync_lease_owner_id) BETWEEN 1 AND 240),
  CHECK (sync_lease_generation >= 0),
  CHECK (last_replay_id_sha256 IS NULL OR last_replay_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (updated_at >= created_at),
  CHECK (last_successful_sync_at IS NULL OR last_successful_sync_at >= created_at),
  CHECK (last_webhook_at IS NULL OR last_webhook_at >= created_at)
);

CREATE TABLE omni_salesforce_account_links (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  salesforce_account_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  provider_object_id_sha256 TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id, salesforce_account_id),
  UNIQUE (organization_id_sha256, salesforce_account_id),
  UNIQUE (tenant_id, workspace_id, customer_account_id),
  FOREIGN KEY (tenant_id, workspace_id, connection_id)
    REFERENCES omni_salesforce_connections (tenant_id, workspace_id, connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, customer_account_id)
    REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (salesforce_account_id ~ '^[A-Za-z0-9]{15,18}$'),
  CHECK (customer_account_id ~ '^customer-account:[a-f0-9]{64}$'),
  CHECK (provider_object_id_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE omni_salesforce_record_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  account_external_id TEXT,
  revision_id TEXT NOT NULL,
  provider_modified_at TIMESTAMPTZ NOT NULL,
  deleted BOOLEAN NOT NULL,
  fields_sha256 TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  record_snapshot JSONB NOT NULL,
  source_kind TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  replay_id_sha256 TEXT,
  PRIMARY KEY (
    tenant_id, workspace_id, connection_id, object_type, external_id, revision_id
  ),
  UNIQUE (record_sha256),
  FOREIGN KEY (tenant_id, workspace_id, connection_id)
    REFERENCES omni_salesforce_connections (tenant_id, workspace_id, connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (object_type IN ('Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract')),
  CHECK (external_id ~ '^[A-Za-z0-9]{15,18}$'),
  CHECK (account_external_id IS NULL OR account_external_id ~ '^[A-Za-z0-9]{15,18}$'),
  CHECK (revision_id ~ '^salesforce-revision:[a-f0-9]{64}$'),
  CHECK (fields_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (record_snapshot ->> 'recordSha256' = record_sha256),
  CHECK (record_snapshot ->> 'revisionId' = revision_id),
  CHECK (record_snapshot ->> 'objectType' = object_type),
  CHECK (record_snapshot ->> 'externalId' = external_id),
  CHECK (source_kind IN ('backfill', 'delta', 'webhook', 'reconciliation')),
  CHECK (received_at >= observed_at),
  CHECK (replay_id_sha256 IS NULL OR replay_id_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE omni_salesforce_record_heads (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  account_external_id TEXT,
  current_revision_id TEXT NOT NULL,
  provider_modified_at TIMESTAMPTZ NOT NULL,
  deleted BOOLEAN NOT NULL,
  record_sha256 TEXT NOT NULL,
  record_snapshot JSONB NOT NULL,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  projection_status TEXT NOT NULL DEFAULT 'pending',
  projection_error_code TEXT,
  projected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id, object_type, external_id),
  UNIQUE (organization_id_sha256, object_type, external_id),
  FOREIGN KEY (
    tenant_id, workspace_id, connection_id, object_type, external_id,
    current_revision_id
  ) REFERENCES omni_salesforce_record_revisions (
    tenant_id, workspace_id, connection_id, object_type, external_id, revision_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (object_type IN ('Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract')),
  CHECK (external_id ~ '^[A-Za-z0-9]{15,18}$'),
  CHECK (account_external_id IS NULL OR account_external_id ~ '^[A-Za-z0-9]{15,18}$'),
  CHECK (current_revision_id ~ '^salesforce-revision:[a-f0-9]{64}$'),
  CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (record_snapshot ->> 'recordSha256' = record_sha256),
  CHECK (record_snapshot ->> 'revisionId' = current_revision_id),
  CHECK (conflict_count >= 0),
  CHECK (projection_status IN ('pending', 'projected', 'held', 'error')),
  CHECK ((projection_status = 'error') = (projection_error_code IS NOT NULL)),
  CHECK (projection_error_code IS NULL OR projection_error_code IN (
    'account_missing', 'account_conflict', 'permission_denied', 'invalid_record',
    'internal_error'
  )),
  CHECK (projected_at IS NULL OR projected_at <= updated_at)
);

CREATE TABLE omni_salesforce_webhook_events (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  event_key_sha256 TEXT NOT NULL,
  replay_id_sha256 TEXT NOT NULL,
  event_sha256 TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id, event_key_sha256),
  UNIQUE (organization_id_sha256, event_key_sha256),
  FOREIGN KEY (tenant_id, workspace_id, connection_id)
    REFERENCES omni_salesforce_connections (tenant_id, workspace_id, connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (event_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (replay_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (event_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (object_type IN ('Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract')),
  CHECK (external_id ~ '^[A-Za-z0-9]{15,18}$')
);

CREATE TABLE omni_salesforce_reconciliation_findings (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id_sha256 TEXT NOT NULL,
  local_revision_id TEXT,
  remote_revision_id TEXT,
  finding_kind TEXT NOT NULL,
  finding_sha256 TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id, finding_id),
  UNIQUE (finding_sha256),
  FOREIGN KEY (tenant_id, workspace_id, connection_id)
    REFERENCES omni_salesforce_connections (tenant_id, workspace_id, connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (finding_id ~ '^salesforce-finding:[a-f0-9]{64}$'),
  CHECK (object_type IN ('Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Asset', 'Contract')),
  CHECK (external_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (local_revision_id IS NULL OR local_revision_id ~ '^salesforce-revision:[a-f0-9]{64}$'),
  CHECK (remote_revision_id IS NULL OR remote_revision_id ~ '^salesforce-revision:[a-f0-9]{64}$'),
  CHECK (finding_kind IN ('missing_local', 'missing_remote', 'revision_mismatch', 'concurrent_revision')),
  CHECK (finding_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX omni_salesforce_record_projection_idx
  ON omni_salesforce_record_heads (
    tenant_id, workspace_id, connection_id, projection_status,
    provider_modified_at, object_type, external_id
  );
CREATE INDEX omni_salesforce_record_account_idx
  ON omni_salesforce_record_heads (
    tenant_id, workspace_id, connection_id, account_external_id,
    object_type, provider_modified_at DESC
  );
CREATE INDEX omni_salesforce_revision_history_idx
  ON omni_salesforce_record_revisions (
    tenant_id, workspace_id, connection_id, object_type, external_id,
    provider_modified_at DESC
  );
CREATE INDEX omni_salesforce_reconciliation_recent_idx
  ON omni_salesforce_reconciliation_findings (
    tenant_id, workspace_id, connection_id, observed_at DESC
  );

CREATE FUNCTION omni_protect_salesforce_evidence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Salesforce synchronization evidence is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_protect_salesforce_connection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Salesforce connection history cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.connection_id <> NEW.connection_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.organization_id_sha256 <> NEW.organization_id_sha256
    OR OLD.access_mode <> NEW.access_mode
    OR OLD.object_scope <> NEW.object_scope
    OR OLD.allowed_purpose_ids <> NEW.allowed_purpose_ids
    OR OLD.created_at <> NEW.created_at
    OR NEW.authorization_generation < OLD.authorization_generation
    OR NEW.sync_lease_generation < OLD.sync_lease_generation
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Salesforce connection transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_protect_salesforce_head_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Salesforce record heads cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.connection_id <> NEW.connection_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.organization_id_sha256 <> NEW.organization_id_sha256
    OR OLD.object_type <> NEW.object_type
    OR OLD.external_id <> NEW.external_id
    OR NEW.provider_modified_at < OLD.provider_modified_at
    OR (
      NEW.provider_modified_at = OLD.provider_modified_at
      AND NEW.current_revision_id < OLD.current_revision_id
    )
    OR NEW.conflict_count < OLD.conflict_count
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'Salesforce record-head transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_salesforce_connections_protected
  BEFORE UPDATE OR DELETE ON omni_salesforce_connections
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_connection_v1();
CREATE TRIGGER omni_salesforce_connections_no_truncate
  BEFORE TRUNCATE ON omni_salesforce_connections
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_salesforce_connection_v1();
CREATE TRIGGER omni_salesforce_account_links_immutable
  BEFORE UPDATE OR DELETE ON omni_salesforce_account_links
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_evidence_v1();
CREATE TRIGGER omni_salesforce_record_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_salesforce_record_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_evidence_v1();
CREATE TRIGGER omni_salesforce_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON omni_salesforce_webhook_events
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_evidence_v1();
CREATE TRIGGER omni_salesforce_reconciliation_findings_immutable
  BEFORE UPDATE OR DELETE ON omni_salesforce_reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_evidence_v1();
CREATE TRIGGER omni_salesforce_record_heads_protected
  BEFORE UPDATE OR DELETE ON omni_salesforce_record_heads
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_head_v1();
CREATE TRIGGER omni_salesforce_record_heads_no_truncate
  BEFORE TRUNCATE ON omni_salesforce_record_heads
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_salesforce_head_v1();

ALTER TABLE omni_salesforce_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_account_links FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_record_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_record_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_record_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_record_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_reconciliation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_reconciliation_findings FORCE ROW LEVEL SECURITY;

CREATE FUNCTION omni_salesforce_workspace_access_v1_allows(
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
  SELECT public.omni_customer_workspace_access_v1_allows(
    row_tenant_id, row_workspace_id, row_owner_actor_id, require_write
  )
$function$;

CREATE POLICY omni_tenant_isolation ON omni_salesforce_connections
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_salesforce_account_links
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_salesforce_record_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_salesforce_record_heads
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_salesforce_webhook_events
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_salesforce_reconciliation_findings
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_salesforce_connections_read_scope
  ON omni_salesforce_connections AS RESTRICTIVE FOR SELECT
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ));
CREATE POLICY omni_salesforce_connections_write_scope
  ON omni_salesforce_connections AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_connections_update_scope
  ON omni_salesforce_connections AS RESTRICTIVE FOR UPDATE
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

CREATE POLICY omni_salesforce_account_links_scope
  ON omni_salesforce_account_links AS RESTRICTIVE FOR ALL
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_record_revisions_scope
  ON omni_salesforce_record_revisions AS RESTRICTIVE FOR ALL
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_record_heads_scope
  ON omni_salesforce_record_heads AS RESTRICTIVE FOR ALL
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_webhook_events_scope
  ON omni_salesforce_webhook_events AS RESTRICTIVE FOR ALL
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_reconciliation_findings_scope
  ON omni_salesforce_reconciliation_findings AS RESTRICTIVE FOR ALL
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

REVOKE ALL ON FUNCTION omni_protect_salesforce_evidence_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_salesforce_connection_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_salesforce_head_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_salesforce_workspace_access_v1_allows(
  TEXT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_salesforce_workspace_access_v1_allows(
      TEXT, TEXT, TEXT, BOOLEAN
    ) TO omni_runtime;
    REVOKE ALL ON TABLE omni_salesforce_connections,
      omni_salesforce_account_links, omni_salesforce_record_revisions,
      omni_salesforce_record_heads, omni_salesforce_webhook_events,
      omni_salesforce_reconciliation_findings FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_connections TO omni_runtime;
    GRANT SELECT, INSERT ON omni_salesforce_account_links TO omni_runtime;
    GRANT SELECT, INSERT ON omni_salesforce_record_revisions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_record_heads TO omni_runtime;
    GRANT SELECT, INSERT ON omni_salesforce_webhook_events TO omni_runtime;
    GRANT SELECT, INSERT ON omni_salesforce_reconciliation_findings TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_connections TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_salesforce_account_links,
      omni_salesforce_record_revisions, omni_salesforce_webhook_events,
      omni_salesforce_reconciliation_findings TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_record_heads TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_salesforce_connections, omni_salesforce_account_links,
      omni_salesforce_record_revisions, omni_salesforce_record_heads,
      omni_salesforce_webhook_events,
      omni_salesforce_reconciliation_findings TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_salesforce_record_revisions'::regclass
      AND tgname = 'omni_salesforce_record_revisions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_salesforce_connections'::regclass
      AND polname = 'omni_salesforce_connections_read_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_salesforce_record_heads'::regclass
      AND polname = 'omni_salesforce_record_heads_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_salesforce_account_links'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%organization_id_sha256, salesforce_account_id%'
  ) THEN
    RAISE EXCEPTION 'Salesforce read synchronization schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  138,
  'salesforce_read_sync_v1',
  '3a17a929b9db8ab125f74b34cc3937298944959836a7e893f0c35c83fabea103',
  clock_timestamp()
);

COMMIT;
