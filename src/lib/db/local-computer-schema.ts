type SqlRow = Record<string, unknown>;

export type LocalComputerSchemaSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
};

/**
 * Durable routing metadata for a local macOS executor. Raw screenshots and
 * accessibility snapshots may exist in a command row only until the waiting
 * governed tool consumes them; they are never copied into the tool ledger.
 */
export async function ensureLocalComputerRuntimeV1(
  sql: LocalComputerSchemaSqlClient,
) {
  await sql.query(`
    CREATE TABLE omni_local_computer_devices (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      mobile_session_id TEXT NOT NULL REFERENCES omni_mobile_sessions(id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      native_contract_version INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL,
      helper_version TEXT NOT NULL,
      permission_status JSONB NOT NULL,
      activity_state TEXT NOT NULL,
      lifecycle_revision BIGINT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      stopped_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_local_computer_devices_pkey PRIMARY KEY (
        tenant_id, owner_actor_id, device_id
      ),
      CONSTRAINT omni_local_computer_devices_identity_key UNIQUE (
        tenant_id, owner_actor_id, device_id, mobile_session_id
      ),
      CONSTRAINT omni_local_computer_devices_row_check CHECK (COALESCE(
        schema_version = 1
        AND btrim(tenant_id) <> ''
        AND btrim(owner_actor_id) <> ''
        AND btrim(user_id) <> ''
        AND btrim(mobile_session_id) <> ''
        AND device_id ~ '^[A-Za-z0-9._:-]{8,200}$'
        AND platform = 'macos'
        AND native_contract_version >= 11
        AND helper_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
        AND jsonb_typeof(permission_status) = 'object'
        AND pg_column_size(permission_status) <= 4096
        AND activity_state IN ('idle', 'active', 'stopped', 'error')
        AND lifecycle_revision >= 1
        AND last_seen_at <= updated_at + INTERVAL '30 seconds'
        AND lease_expires_at <= updated_at + INTERVAL '30 seconds'
        AND created_at <= updated_at
        AND ((enabled AND stopped_at IS NULL) OR (NOT enabled))
      , FALSE))
    );
    CREATE INDEX omni_local_computer_devices_online_idx
      ON omni_local_computer_devices (
        tenant_id, owner_actor_id, enabled, lease_expires_at DESC, device_id
      );

    CREATE TABLE omni_local_computer_sessions (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      mobile_session_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      stopped_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_local_computer_sessions_pkey PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_local_computer_sessions_owner_key UNIQUE (
        tenant_id, owner_actor_id, correlation_id
      ),
      CONSTRAINT omni_local_computer_sessions_device_fkey FOREIGN KEY (
        tenant_id, owner_actor_id, device_id, mobile_session_id
      ) REFERENCES omni_local_computer_devices (
        tenant_id, owner_actor_id, device_id, mobile_session_id
      ) ON UPDATE RESTRICT ON DELETE CASCADE,
      CONSTRAINT omni_local_computer_sessions_row_check CHECK (COALESCE(
        schema_version = 1
        AND id ~ '^local_computer_session_[0-9a-f]{48}$'
        AND btrim(tenant_id) <> ''
        AND btrim(owner_actor_id) <> ''
        AND device_id ~ '^[A-Za-z0-9._:-]{8,200}$'
        AND char_length(btrim(correlation_id)) BETWEEN 1 AND 200
        AND state IN ('active', 'stopped', 'expired')
        AND expires_at > created_at
        AND created_at <= updated_at
        AND ((state = 'active' AND stopped_at IS NULL) OR state <> 'active')
      , FALSE))
    );
    CREATE INDEX omni_local_computer_sessions_active_idx
      ON omni_local_computer_sessions (
        tenant_id, owner_actor_id, correlation_id, expires_at DESC
      ) WHERE state = 'active';

    CREATE TABLE omni_local_computer_commands (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      action TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      claim_token_sha256 TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ,
      claim_expires_at TIMESTAMPTZ,
      outcome TEXT,
      result JSONB,
      result_sha256 TEXT,
      error_code TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      CONSTRAINT omni_local_computer_commands_pkey PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_local_computer_commands_execution_key UNIQUE (
        tenant_id, owner_actor_id, execution_id
      ),
      CONSTRAINT omni_local_computer_commands_session_fkey FOREIGN KEY (
        tenant_id, session_id
      ) REFERENCES omni_local_computer_sessions (tenant_id, id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
      CONSTRAINT omni_local_computer_commands_row_check CHECK (COALESCE(
        schema_version = 1
        AND id ~ '^local_computer_command_[0-9a-f]{48}$'
        AND btrim(tenant_id) <> ''
        AND btrim(owner_actor_id) <> ''
        AND device_id ~ '^[A-Za-z0-9._:-]{8,200}$'
        AND char_length(btrim(execution_id)) BETWEEN 1 AND 240
        AND action IN (
          'observe', 'list_apps', 'activate_app', 'press', 'click',
          'type', 'key', 'scroll'
        )
        AND input_sha256 ~ '^[0-9a-f]{64}$'
        AND state IN (
          'queued', 'claimed', 'completed', 'failed', 'canceled',
          'expired', 'consumed'
        )
        AND claim_generation >= 0
        AND (
          (state = 'queued' AND claim_token_sha256 IS NULL)
          OR state <> 'queued'
        )
        AND (
          claim_token_sha256 IS NULL
          OR claim_token_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          (claimed_at IS NULL AND claim_expires_at IS NULL)
          OR (claimed_at IS NOT NULL AND claim_expires_at > claimed_at)
        )
        AND (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'canceled'))
        AND (result IS NULL OR (
          jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 2097152
        ))
        AND (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$')
        AND (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 160)
        AND expires_at > created_at
        AND created_at <= updated_at
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (consumed_at IS NULL OR completed_at IS NOT NULL)
      , FALSE))
    );
    CREATE INDEX omni_local_computer_commands_claim_idx
      ON omni_local_computer_commands (
        tenant_id, owner_actor_id, device_id, state, created_at, id
      );
    CREATE INDEX omni_local_computer_commands_expiry_idx
      ON omni_local_computer_commands (expires_at, state);

    ALTER TABLE omni_local_computer_devices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_local_computer_devices FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_local_computer_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_local_computer_sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_local_computer_commands ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_local_computer_commands FORCE ROW LEVEL SECURITY;

    CREATE POLICY omni_local_computer_devices_actor_scope
      ON omni_local_computer_devices FOR ALL TO PUBLIC
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );
    CREATE POLICY omni_local_computer_sessions_actor_scope
      ON omni_local_computer_sessions FOR ALL TO PUBLIC
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );
    CREATE POLICY omni_local_computer_commands_actor_scope
      ON omni_local_computer_commands FOR ALL TO PUBLIC
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );

    REVOKE ALL ON omni_local_computer_devices FROM PUBLIC;
    REVOKE ALL ON omni_local_computer_sessions FROM PUBLIC;
    REVOKE ALL ON omni_local_computer_commands FROM PUBLIC;
  `);
  await sql`
    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON omni_local_computer_devices TO omni_runtime;
        GRANT SELECT, INSERT, UPDATE ON omni_local_computer_sessions TO omni_runtime;
        GRANT SELECT, INSERT, UPDATE ON omni_local_computer_commands TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON omni_local_computer_devices TO omni_maintenance;
        GRANT SELECT, INSERT, UPDATE, DELETE ON omni_local_computer_sessions TO omni_maintenance;
        GRANT SELECT, INSERT, UPDATE, DELETE ON omni_local_computer_commands TO omni_maintenance;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO omni_backup;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT ON TABLES TO omni_backup;
      END IF;
    END
    $grants$
  `;
  await sql`
    DO $verify$
    BEGIN
      IF (
        SELECT count(*) FROM pg_class
        WHERE oid IN (
          'omni_local_computer_devices'::regclass,
          'omni_local_computer_sessions'::regclass,
          'omni_local_computer_commands'::regclass
        ) AND relrowsecurity AND relforcerowsecurity
      ) <> 3 OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid IN (
          'omni_local_computer_devices'::regclass,
          'omni_local_computer_sessions'::regclass,
          'omni_local_computer_commands'::regclass
        )
      ) <> 3 THEN
        RAISE EXCEPTION 'Local Computer Use isolation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $verify$
  `;
}
