BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 145
      AND name = 'mobile_device_lifecycle_v1'
      AND checksum = '18fbfb5fdf45b3e83f49c07d5d2d7c698ebb62be16d3eb160bf7fd806871fb8f'
  ) <> 1 THEN
    RAISE EXCEPTION 'Mobile push delivery predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_mobile_push_registrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE RESTRICT,
  mobile_session_id TEXT NOT NULL REFERENCES omni_mobile_sessions(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  credential_version SMALLINT NOT NULL DEFAULT 1,
  token_bundle JSONB NOT NULL,
  preview_policy TEXT NOT NULL DEFAULT 'hidden',
  state TEXT NOT NULL DEFAULT 'active',
  lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  last_registered_at TIMESTAMPTZ NOT NULL,
  last_delivered_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, owner_actor_id, device_id, provider),
  UNIQUE (tenant_id, owner_actor_id, id),
  CHECK (char_length(id) BETWEEN 16 AND 200),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (char_length(device_id) BETWEEN 8 AND 200),
  CHECK (platform IN ('android', 'ios')),
  CHECK (provider IN ('apns', 'fcm')),
  CHECK (environment IN ('sandbox', 'production')),
  CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (credential_version BETWEEN 1 AND 32767),
  CHECK (jsonb_typeof(token_bundle) = 'object'),
  CHECK (preview_policy IN ('hidden', 'generic', 'title')),
  CHECK (state IN ('active', 'revoked')),
  CHECK (lifecycle_revision BETWEEN 1 AND 9007199254740991),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (provider <> 'apns' OR platform = 'ios')
);

CREATE UNIQUE INDEX IF NOT EXISTS omni_mobile_push_active_token_idx
  ON omni_mobile_push_registrations (provider, token_sha256)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS omni_mobile_push_registration_owner_idx
  ON omni_mobile_push_registrations (
    tenant_id, owner_actor_id, device_id, state, updated_at DESC
  );
CREATE INDEX IF NOT EXISTS omni_mobile_push_registration_session_idx
  ON omni_mobile_push_registrations (tenant_id, mobile_session_id, state);

CREATE TABLE IF NOT EXISTS omni_mobile_push_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  notification_id TEXT,
  cause_kind TEXT NOT NULL,
  cause_id TEXT NOT NULL,
  parent_id TEXT,
  deep_link TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  provider_message_id_sha256 TEXT,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, owner_actor_id, registration_id)
    REFERENCES omni_mobile_push_registrations (tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (char_length(id) BETWEEN 16 AND 200),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (notification_id IS NULL OR char_length(notification_id) BETWEEN 1 AND 240),
  CHECK (cause_kind IN ('approval', 'work_item', 'meeting', 'customer', 'run')),
  CHECK (char_length(cause_id) BETWEEN 1 AND 240),
  CHECK (parent_id IS NULL OR char_length(parent_id) BETWEEN 1 AND 240),
  CHECK (char_length(deep_link) BETWEEN 2 AND 1000 AND left(deep_link, 1) = '/'),
  CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (status IN ('queued', 'running', 'delivered', 'acknowledged', 'failed')),
  CHECK (attempt BETWEEN 0 AND 20),
  CHECK (max_attempts BETWEEN 1 AND 20),
  CHECK (attempt <= max_attempts),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL)),
  CHECK (provider_message_id_sha256 IS NULL OR provider_message_id_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (delivered_at IS NULL OR status IN ('delivered', 'acknowledged')),
  CHECK ((acknowledged_at IS NOT NULL) = (status = 'acknowledged')),
  CHECK (cause_kind = 'work_item' OR parent_id IS NULL)
);

CREATE INDEX IF NOT EXISTS omni_mobile_push_delivery_queue_idx
  ON omni_mobile_push_deliveries (
    tenant_id, status, run_at, created_at
  );
CREATE INDEX IF NOT EXISTS omni_mobile_push_delivery_owner_idx
  ON omni_mobile_push_deliveries (
    tenant_id, owner_actor_id, status, updated_at DESC
  );
CREATE INDEX IF NOT EXISTS omni_mobile_push_delivery_registration_idx
  ON omni_mobile_push_deliveries (
    tenant_id, registration_id, status, created_at DESC
  );

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_mobile_push_registrations', 'omni_mobile_push_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_actor', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE omni_mobile_push_registrations FROM PUBLIC;
REVOKE ALL ON TABLE omni_mobile_push_deliveries FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON omni_mobile_push_registrations TO omni_runtime;
    GRANT UPDATE (
      user_id, mobile_session_id, platform, environment, token_sha256,
      credential_version, token_bundle, preview_policy, state,
      lifecycle_revision, last_registered_at, last_delivered_at, revoked_at,
      updated_at
    ) ON omni_mobile_push_registrations TO omni_runtime;
    GRANT SELECT, INSERT ON omni_mobile_push_deliveries TO omni_runtime;
    GRANT UPDATE (
      status, attempt, run_at, lease_owner, lease_expires_at, last_error,
      provider_message_id_sha256, delivered_at, acknowledged_at, updated_at
    ) ON omni_mobile_push_deliveries TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_mobile_push_registrations TO omni_maintenance;
    GRANT UPDATE (
      user_id, mobile_session_id, platform, environment, token_sha256,
      credential_version, token_bundle, preview_policy, state,
      lifecycle_revision, last_registered_at, last_delivered_at, revoked_at,
      updated_at
    ) ON omni_mobile_push_registrations TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_mobile_push_deliveries TO omni_maintenance;
    GRANT UPDATE (
      status, attempt, run_at, lease_owner, lease_expires_at, last_error,
      provider_message_id_sha256, delivered_at, acknowledged_at, updated_at
    ) ON omni_mobile_push_deliveries TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN (
      'omni_mobile_push_registrations', 'omni_mobile_push_deliveries'
    ) AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'omni_mobile_push_registrations'::regclass,
      'omni_mobile_push_deliveries'::regclass
    ) AND polpermissive AND polcmd = '*'
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'omni_mobile_push_active_token_idx'::regclass
      AND indisunique AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Mobile push delivery boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  146,
  'mobile_push_delivery_v1',
  'f1b9d4b2c1cacd0e2ef0035665d485dbedb50b159d640a0d78b5111e02f5c959',
  clock_timestamp()
);

COMMIT;
