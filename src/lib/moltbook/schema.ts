type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

/**
 * Runtime form of schema migration v190. The ordered migrator supplies the
 * transaction, advisory lock, system scope, and schema-version receipt.
 */
export async function ensureMoltbookAgentConnectionsV1(sql: MigrationSql) {
  await sql.query(String.raw`
    DO $constraint$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'omni_custom_agents'::regclass
          AND conname = 'omni_custom_agents_owner_id_unique'
      ) THEN
        ALTER TABLE omni_custom_agents
          ADD CONSTRAINT omni_custom_agents_owner_id_unique
          UNIQUE (tenant_id, actor_id, id);
      END IF;
    END
    $constraint$;

    CREATE TABLE IF NOT EXISTS omni_moltbook_connections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      external_name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_state TEXT NOT NULL,
      heartbeat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      credential_version INTEGER NOT NULL,
      credential_key_id TEXT,
      sealed_credentials JSONB,
      last_heartbeat_at TIMESTAMPTZ,
      next_heartbeat_at TIMESTAMPTZ,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      rate_limit_projection JSONB,
      paused_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, agent_id),
      UNIQUE (tenant_id, owner_actor_id, id),
      FOREIGN KEY (tenant_id, owner_actor_id, agent_id)
        REFERENCES omni_custom_agents (tenant_id, actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (id ~ '^moltbook_connection_[a-f0-9]{48}$'),
      CHECK (char_length(tenant_id) BETWEEN 1 AND 160),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(agent_id) BETWEEN 1 AND 240),
      CHECK (
        char_length(external_name) BETWEEN 2 AND 32
        AND external_name = btrim(external_name)
        AND external_name ~ '^[A-Za-z0-9_-]+$'
      ),
      CHECK (
        char_length(description) BETWEEN 2 AND 1000
        AND description = btrim(description)
      ),
      CHECK (status IN (
        'registering', 'pending_claim', 'claimed', 'paused', 'error', 'revoked'
      )),
      CHECK (claim_state IN ('unavailable', 'pending', 'claimed')),
      CHECK (credential_version >= 1),
      CHECK (
        (sealed_credentials IS NULL AND credential_key_id IS NULL)
        OR (
          jsonb_typeof(sealed_credentials) = 'object'
          AND pg_column_size(sealed_credentials) <= 131072
          AND sealed_credentials ?& ARRAY[
            'version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'tag'
          ]
          AND credential_key_id = sealed_credentials ->> 'keyId'
        )
      ),
      CHECK (
        (status = 'registering' AND claim_state = 'unavailable'
          AND sealed_credentials IS NULL)
        OR status <> 'registering'
      ),
      CHECK (
        (claim_state IN ('pending', 'claimed') AND sealed_credentials IS NOT NULL)
        OR claim_state = 'unavailable'
      ),
      CHECK (consecutive_failures BETWEEN 0 AND 1000000),
      CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK (
        rate_limit_projection IS NULL OR (
          jsonb_typeof(rate_limit_projection) = 'object'
          AND pg_column_size(rate_limit_projection) <= 4096
          AND rate_limit_projection - ARRAY[
            'limit', 'remaining', 'resetAt', 'retryAfterSeconds', 'observedAt'
          ] = '{}'::JSONB
          AND rate_limit_projection ? 'observedAt'
        )
      ),
      CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at >= created_at),
      CHECK (next_heartbeat_at IS NULL OR next_heartbeat_at >= created_at),
      CHECK (paused_at IS NULL OR paused_at >= created_at),
      CHECK (revoked_at IS NULL OR revoked_at >= created_at),
      CHECK ((status = 'paused') = (paused_at IS NOT NULL)),
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      CHECK (updated_at >= created_at)
    );

    CREATE TABLE IF NOT EXISTS omni_moltbook_activities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      provider_object_type TEXT,
      provider_object_ref TEXT,
      provider_object_url TEXT,
      tool_execution_id TEXT,
      agent_run_id TEXT,
      request_sha256 TEXT,
      response_sha256 TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      FOREIGN KEY (tenant_id, owner_actor_id, connection_id)
        REFERENCES omni_moltbook_connections (tenant_id, owner_actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (id ~ '^moltbook_activity_[a-f0-9]{48}$'),
      CHECK (char_length(agent_id) BETWEEN 1 AND 240),
      CHECK (kind ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK (status IN ('succeeded', 'failed', 'pending_verification', 'published')),
      CHECK (char_length(summary) BETWEEN 1 AND 1000),
      CHECK (provider_object_type IS NULL OR provider_object_type ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK (provider_object_ref IS NULL OR provider_object_ref ~ '^[A-Za-z0-9_.:-]{1,240}$'),
      CHECK (
        (provider_object_type IS NULL AND provider_object_ref IS NULL
          AND provider_object_url IS NULL)
        OR (provider_object_type IS NOT NULL AND provider_object_ref IS NOT NULL)
      ),
      CHECK (
        provider_object_url IS NULL OR (
          char_length(provider_object_url) <= 2048
          AND provider_object_url ~ '^https://www\.moltbook\.com/'
        )
      ),
      CHECK (tool_execution_id IS NULL OR char_length(tool_execution_id) BETWEEN 1 AND 240),
      CHECK (agent_run_id IS NULL OR char_length(agent_run_id) BETWEEN 1 AND 240),
      CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK ((status = 'failed') = (error_code IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS omni_moltbook_effect_receipts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      effect_status TEXT NOT NULL,
      provider_object_type TEXT,
      provider_object_ref TEXT,
      tool_execution_id TEXT NOT NULL,
      agent_run_id TEXT,
      request_sha256 TEXT NOT NULL,
      response_sha256 TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      FOREIGN KEY (tenant_id, owner_actor_id, connection_id)
        REFERENCES omni_moltbook_connections (tenant_id, owner_actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (id ~ '^moltbook_effect_[a-f0-9]{48}$'),
      CHECK (char_length(agent_id) BETWEEN 1 AND 240),
      CHECK (effect_kind ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK (effect_status IN ('succeeded', 'failed', 'pending_verification', 'published')),
      CHECK (provider_object_type IS NULL OR provider_object_type ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK (provider_object_ref IS NULL OR provider_object_ref ~ '^[A-Za-z0-9_.:-]{1,240}$'),
      CHECK ((provider_object_type IS NULL) = (provider_object_ref IS NULL)),
      CHECK (char_length(tool_execution_id) BETWEEN 1 AND 240),
      CHECK (agent_run_id IS NULL OR char_length(agent_run_id) BETWEEN 1 AND 240),
      CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.:-]{1,80}$'),
      CHECK ((effect_status = 'failed') = (error_code IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS omni_moltbook_connections_due_idx
      ON omni_moltbook_connections (
        tenant_id, heartbeat_enabled, status, next_heartbeat_at, id
      ) WHERE heartbeat_enabled = TRUE AND status IN ('pending_claim', 'claimed');
    CREATE INDEX IF NOT EXISTS omni_moltbook_activities_owner_cursor_idx
      ON omni_moltbook_activities (
        tenant_id, owner_actor_id, agent_id, created_at DESC, id DESC
      );
    CREATE INDEX IF NOT EXISTS omni_moltbook_effect_receipts_execution_idx
      ON omni_moltbook_effect_receipts (
        tenant_id, owner_actor_id, tool_execution_id, created_at, id
      );

    CREATE OR REPLACE FUNCTION omni_protect_moltbook_connection_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Moltbook connections cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
        OR OLD.external_name IS DISTINCT FROM NEW.external_name
        OR OLD.description IS DISTINCT FROM NEW.description
        OR OLD.credential_version IS DISTINCT FROM NEW.credential_version
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR NEW.updated_at <= OLD.updated_at
      THEN
        RAISE EXCEPTION 'Moltbook connection identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.sealed_credentials IS DISTINCT FROM NEW.sealed_credentials
        AND NOT (OLD.status = 'registering' AND NEW.status = 'pending_claim'
          AND OLD.sealed_credentials IS NULL AND NEW.sealed_credentials IS NOT NULL)
      THEN
        RAISE EXCEPTION 'Moltbook credential transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.credential_key_id IS DISTINCT FROM NEW.credential_key_id
        AND NOT (OLD.status = 'registering' AND NEW.status = 'pending_claim'
          AND OLD.credential_key_id IS NULL AND NEW.credential_key_id IS NOT NULL)
      THEN
        RAISE EXCEPTION 'Moltbook credential key transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT (
        (OLD.status = NEW.status AND OLD.status <> 'revoked')
        OR (OLD.status = 'registering' AND NEW.status IN ('pending_claim', 'error'))
        OR (OLD.status = 'pending_claim' AND NEW.status IN ('claimed', 'paused', 'error', 'revoked'))
        OR (OLD.status = 'claimed' AND NEW.status IN ('paused', 'error', 'revoked'))
        OR (OLD.status = 'paused' AND NEW.status IN ('pending_claim', 'claimed', 'error', 'revoked'))
        OR (OLD.status = 'error' AND NEW.status IN ('pending_claim', 'claimed', 'paused', 'revoked'))
      ) THEN
        RAISE EXCEPTION 'Moltbook connection lifecycle transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE OR REPLACE FUNCTION omni_reject_moltbook_receipt_mutation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Moltbook activities and effect receipts are immutable'
        USING ERRCODE = '55000';
    END
    $function$;

    DROP TRIGGER IF EXISTS omni_moltbook_connections_protect
      ON omni_moltbook_connections;
    CREATE TRIGGER omni_moltbook_connections_protect
      BEFORE UPDATE OR DELETE ON omni_moltbook_connections
      FOR EACH ROW EXECUTE FUNCTION omni_protect_moltbook_connection_v1();
    DROP TRIGGER IF EXISTS omni_moltbook_connections_no_truncate
      ON omni_moltbook_connections;
    CREATE TRIGGER omni_moltbook_connections_no_truncate
      BEFORE TRUNCATE ON omni_moltbook_connections
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_moltbook_connection_v1();
    DROP TRIGGER IF EXISTS omni_moltbook_activities_immutable
      ON omni_moltbook_activities;
    CREATE TRIGGER omni_moltbook_activities_immutable
      BEFORE UPDATE OR DELETE ON omni_moltbook_activities
      FOR EACH ROW EXECUTE FUNCTION omni_reject_moltbook_receipt_mutation_v1();
    DROP TRIGGER IF EXISTS omni_moltbook_activities_no_truncate
      ON omni_moltbook_activities;
    CREATE TRIGGER omni_moltbook_activities_no_truncate
      BEFORE TRUNCATE ON omni_moltbook_activities
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_moltbook_receipt_mutation_v1();
    DROP TRIGGER IF EXISTS omni_moltbook_effect_receipts_immutable
      ON omni_moltbook_effect_receipts;
    CREATE TRIGGER omni_moltbook_effect_receipts_immutable
      BEFORE UPDATE OR DELETE ON omni_moltbook_effect_receipts
      FOR EACH ROW EXECUTE FUNCTION omni_reject_moltbook_receipt_mutation_v1();
    DROP TRIGGER IF EXISTS omni_moltbook_effect_receipts_no_truncate
      ON omni_moltbook_effect_receipts;
    CREATE TRIGGER omni_moltbook_effect_receipts_no_truncate
      BEFORE TRUNCATE ON omni_moltbook_effect_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_moltbook_receipt_mutation_v1();

    DO $policies$
    DECLARE table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'omni_moltbook_connections',
        'omni_moltbook_activities',
        'omni_moltbook_effect_receipts'
      ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
          'DROP POLICY IF EXISTS omni_tenant_isolation ON %I', table_name
        );
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON %I', table_name || '_actor', table_name
        );
        EXECUTE format(
          'CREATE POLICY omni_tenant_isolation ON %I AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
          table_name
        );
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
          table_name || '_actor', table_name
        );
      END LOOP;
    END
    $policies$;

    REVOKE ALL ON omni_moltbook_connections FROM PUBLIC;
    REVOKE ALL ON omni_moltbook_activities FROM PUBLIC;
    REVOKE ALL ON omni_moltbook_effect_receipts FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_moltbook_connection_v1() FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_moltbook_receipt_mutation_v1() FROM PUBLIC;

    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT ON omni_moltbook_connections TO omni_runtime;
        GRANT UPDATE (
          status, claim_state, heartbeat_enabled, credential_key_id,
          sealed_credentials, last_heartbeat_at, next_heartbeat_at,
          consecutive_failures, last_error_code, rate_limit_projection,
          paused_at, revoked_at, updated_at
        ) ON omni_moltbook_connections TO omni_runtime;
        GRANT SELECT, INSERT ON omni_moltbook_activities TO omni_runtime;
        GRANT SELECT, INSERT ON omni_moltbook_effect_receipts TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT ON omni_moltbook_connections TO omni_maintenance;
        GRANT UPDATE (
          status, claim_state, heartbeat_enabled, credential_key_id,
          sealed_credentials, last_heartbeat_at, next_heartbeat_at,
          consecutive_failures, last_error_code, rate_limit_projection,
          paused_at, revoked_at, updated_at
        ) ON omni_moltbook_connections TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_moltbook_activities TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_moltbook_effect_receipts TO omni_maintenance;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
        GRANT SELECT ON omni_moltbook_connections TO omni_backup;
        GRANT SELECT ON omni_moltbook_activities TO omni_backup;
        GRANT SELECT ON omni_moltbook_effect_receipts TO omni_backup;
      END IF;
    END
    $grants$;

    DO $verify$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_class relation
        WHERE relation.oid IN (
          'omni_moltbook_connections'::regclass,
          'omni_moltbook_activities'::regclass,
          'omni_moltbook_effect_receipts'::regclass
        )
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
      ) <> 3 OR (
        SELECT count(*)
        FROM pg_policy policy
        WHERE policy.polrelid IN (
          'omni_moltbook_connections'::regclass,
          'omni_moltbook_activities'::regclass,
          'omni_moltbook_effect_receipts'::regclass
        )
          AND NOT policy.polpermissive
          AND policy.polcmd = '*'
          AND policy.polroles = ARRAY[0::OID]
          AND policy.polname LIKE '%_actor'
      ) <> 3 THEN
        RAISE EXCEPTION 'Moltbook actor-private RLS is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $verify$;
  `);
}
