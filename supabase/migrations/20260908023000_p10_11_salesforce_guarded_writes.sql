BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 138
      AND name = 'salesforce_read_sync_v1'
      AND checksum = '3a17a929b9db8ab125f74b34cc3937298944959836a7e893f0c35c83fabea103'
  ) <> 1 THEN
    RAISE EXCEPTION 'Salesforce guarded-write predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT relation.relname AS table_name, constraint_record.conname
    FROM pg_constraint constraint_record
    JOIN pg_class relation ON relation.oid = constraint_record.conrelid
    WHERE relation.relname IN (
      'omni_customer_account_revisions', 'omni_customer_accounts'
    )
      AND constraint_record.contype = 'c'
      AND pg_get_constraintdef(constraint_record.oid) LIKE '%externalWriteState%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT %I',
      constraint_row.table_name,
      constraint_row.conname
    );
  END LOOP;
END
$migration$;

ALTER TABLE omni_customer_account_revisions
  ADD CONSTRAINT omni_customer_account_revisions_external_write_state
  CHECK (
    account_snapshot -> 'crmPermissions' ->> 'externalWriteState'
      IN ('disabled', 'approval_required')
  );

ALTER TABLE omni_customer_accounts
  ADD CONSTRAINT omni_customer_accounts_external_write_state
  CHECK (
    account_snapshot -> 'crmPermissions' ->> 'externalWriteState'
      IN ('disabled', 'approval_required')
  );

CREATE TABLE omni_salesforce_write_operations (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  organization_id_sha256 TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  tool_execution_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  provider_record_id_sha256 TEXT,
  provider_idempotency_key_sha256 TEXT,
  request_sha256 TEXT NOT NULL,
  expected_target_state_sha256 TEXT NOT NULL,
  operation_state TEXT NOT NULL DEFAULT 'prepared',
  provider_acknowledgement_sha256 TEXT,
  observed_target_state_sha256 TEXT,
  verification_reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id, operation_id),
  UNIQUE (organization_id_sha256, operation_id),
  UNIQUE (tenant_id, tool_execution_id),
  FOREIGN KEY (tenant_id, workspace_id, connection_id)
    REFERENCES omni_salesforce_connections (tenant_id, workspace_id, connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, customer_account_id)
    REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (customer_account_id ~ '^customer-account:[a-f0-9]{64}$'),
  CHECK (organization_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (operation_id ~ '^salesforce-write:[a-f0-9]{64}$'),
  CHECK (char_length(tool_execution_id) BETWEEN 1 AND 240),
  CHECK (tool_id ~ '^app[.]customer_accounts[.]salesforce[.](contact|task|note|case|opportunity|account)[.](create|update)$'),
  CHECK (object_type IN ('Account', 'Contact', 'Task', 'Note', 'Case', 'Opportunity')),
  CHECK (operation_kind IN ('create', 'update')),
  CHECK ((operation_kind = 'create') = (provider_idempotency_key_sha256 IS NOT NULL)),
  CHECK (provider_record_id_sha256 IS NULL OR provider_record_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (provider_idempotency_key_sha256 IS NULL OR provider_idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (expected_target_state_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (operation_state IN ('prepared', 'verified', 'failed')),
  CHECK (provider_acknowledgement_sha256 IS NULL OR provider_acknowledgement_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (observed_target_state_sha256 IS NULL OR observed_target_state_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (verification_reason_code IS NULL OR verification_reason_code IN ('state_matched', 'target_missing', 'state_mismatch')),
  CHECK (attempt_count >= 0),
  CHECK (
    (operation_state = 'prepared'
      AND provider_acknowledgement_sha256 IS NULL
      AND observed_target_state_sha256 IS NULL
      AND verification_reason_code IS NULL
      AND completed_at IS NULL)
    OR
    (operation_state IN ('verified', 'failed')
      AND provider_acknowledgement_sha256 IS NOT NULL
      AND verification_reason_code IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CHECK ((operation_state = 'verified') = (
    verification_reason_code = 'state_matched'
    AND observed_target_state_sha256 = expected_target_state_sha256
  )),
  CHECK ((attempt_count = 0) = (last_attempt_at IS NULL)),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX omni_salesforce_write_account_recent_idx
  ON omni_salesforce_write_operations (
    tenant_id, workspace_id, customer_account_id, created_at DESC
  );

CREATE FUNCTION omni_protect_salesforce_write_operation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Salesforce write-operation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.connection_id, OLD.owner_actor_id,
    OLD.customer_account_id, OLD.organization_id_sha256, OLD.operation_id,
    OLD.tool_execution_id, OLD.tool_id, OLD.object_type, OLD.operation_kind,
    OLD.provider_idempotency_key_sha256, OLD.request_sha256,
    OLD.expected_target_state_sha256, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.connection_id, NEW.owner_actor_id,
    NEW.customer_account_id, NEW.organization_id_sha256, NEW.operation_id,
    NEW.tool_execution_id, NEW.tool_id, NEW.object_type, NEW.operation_kind,
    NEW.provider_idempotency_key_sha256, NEW.request_sha256,
    NEW.expected_target_state_sha256, NEW.created_at
  ) OR NEW.attempt_count < OLD.attempt_count
    OR NEW.updated_at < OLD.updated_at
    OR OLD.operation_state <> 'prepared'
    OR NEW.operation_state NOT IN ('prepared', 'verified', 'failed')
  THEN
    RAISE EXCEPTION 'Salesforce write-operation transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_salesforce_write_operations_protected
  BEFORE UPDATE OR DELETE ON omni_salesforce_write_operations
  FOR EACH ROW EXECUTE FUNCTION omni_protect_salesforce_write_operation_v1();
CREATE TRIGGER omni_salesforce_write_operations_no_truncate
  BEFORE TRUNCATE ON omni_salesforce_write_operations
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_salesforce_write_operation_v1();

ALTER TABLE omni_salesforce_write_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_salesforce_write_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_salesforce_write_operations
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_salesforce_write_operations_read_scope
  ON omni_salesforce_write_operations AS RESTRICTIVE FOR SELECT
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, FALSE
  ));
CREATE POLICY omni_salesforce_write_operations_insert_scope
  ON omni_salesforce_write_operations AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));
CREATE POLICY omni_salesforce_write_operations_update_scope
  ON omni_salesforce_write_operations AS RESTRICTIVE FOR UPDATE
  USING (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ))
  WITH CHECK (omni_salesforce_workspace_access_v1_allows(
    tenant_id, workspace_id, owner_actor_id, TRUE
  ));

REVOKE ALL ON FUNCTION omni_protect_salesforce_write_operation_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_salesforce_write_operations FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_write_operations TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT, UPDATE ON omni_salesforce_write_operations TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_salesforce_write_operations TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_salesforce_write_operations'::regclass
      AND tgname = 'omni_salesforce_write_operations_protected'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_salesforce_write_operations'::regclass
      AND polname = 'omni_salesforce_write_operations_update_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_customer_accounts'::regclass
      AND conname = 'omni_customer_accounts_external_write_state'
      AND pg_get_constraintdef(oid) LIKE '%approval_required%'
  ) THEN
    RAISE EXCEPTION 'Salesforce guarded-write schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  139,
  'salesforce_guarded_writes_v1',
  '0685f82f1c7cd09120b6cff93923d3f6bf821326e029dc92932b4775778dd196',
  clock_timestamp()
);

COMMIT;
