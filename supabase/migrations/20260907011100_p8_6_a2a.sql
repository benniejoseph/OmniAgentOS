BEGIN;

SELECT pg_advisory_xact_lock(271828182);

SELECT set_config('statement_timeout', '600000', true);

SELECT set_config('omni.system_scope', 'true', true);

SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 116
          AND name = 'delegation_task_lifecycle_v1'
          AND checksum =
            '8b60665b57c9d7d1e4c31c3d17a6b57fbd50d4c9f0fecbe3d2ffaa2a7eee4ccc'
      ) <> 1 THEN
        RAISE EXCEPTION 'A2A peer rollout predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

ALTER TABLE omni_service_api_keys
    DROP CONSTRAINT IF EXISTS omni_service_api_keys_scopes_check;

ALTER TABLE omni_service_api_keys
    ADD CONSTRAINT omni_service_api_keys_scopes_check CHECK (scopes <@ ARRAY[
      'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
      'a2a:discover', 'a2a:tasks:read', 'a2a:tasks:write',
      'missions:read', 'missions:write', 'memory:read', 'memory:write',
      'runs:read', 'settings:read'
    ]::TEXT[]);

ALTER TABLE omni_mcp_export_configurations
    DROP CONSTRAINT IF EXISTS omni_mcp_export_configurations_allowed_scopes_check;

ALTER TABLE omni_mcp_export_configurations
    ADD CONSTRAINT omni_mcp_export_configurations_allowed_scopes_check
    CHECK (allowed_scopes <@ ARRAY[
      'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
      'a2a:discover', 'a2a:tasks:read', 'a2a:tasks:write',
      'missions:read', 'missions:write', 'memory:read', 'memory:write',
      'runs:read', 'settings:read'
    ]::TEXT[]);

CREATE TABLE IF NOT EXISTS omni_a2a_peer_rollouts (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      rollout_id TEXT NOT NULL,
      rollout_sha256 TEXT NOT NULL,
      direction TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      interface_url TEXT NOT NULL,
      interface_origin TEXT NOT NULL,
      agent_card_sha256 TEXT NOT NULL,
      protocol_version TEXT NOT NULL,
      protocol_binding TEXT NOT NULL,
      adapter_release TEXT NOT NULL,
      adapter_artifact_sha256 TEXT NOT NULL,
      inbound_service_api_key_id TEXT,
      outbound_credential_configured BOOLEAN NOT NULL,
      credential_version INTEGER,
      credential_origin TEXT,
      credential_fingerprint TEXT,
      sealed_credential JSONB,
      allowed_skill_ids TEXT[] NOT NULL,
      allowed_inbound_agent_ids TEXT[] NOT NULL,
      max_task_duration_ms INTEGER NOT NULL,
      max_input_bytes INTEGER NOT NULL,
      max_output_bytes INTEGER NOT NULL,
      rollout JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, rollout_id),
      UNIQUE (tenant_id, owner_actor_id, peer_id, generation),
      CHECK (schema_version = 1),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(peer_id) BETWEEN 1 AND 240),
      CHECK (generation BETWEEN 1 AND 9007199254740991),
      CHECK (char_length(rollout_id) BETWEEN 1 AND 240),
      CHECK (rollout_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
      CHECK (mode IN ('shadow', 'enabled')),
      CHECK (status IN ('registered', 'active', 'paused', 'revoked')),
      CHECK (lifecycle_revision BETWEEN 0 AND 9007199254740991),
      CHECK ((status = 'registered') = (lifecycle_revision = 0)),
      CHECK (interface_url ~ '^https://'),
      CHECK (interface_origin ~ '^https://'),
      CHECK (agent_card_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (protocol_version = '1.0'),
      CHECK (protocol_binding = 'HTTP+JSON'),
      CHECK (adapter_release = 'p8.6-a2a-adapter:1'),
      CHECK (adapter_artifact_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (
        (direction = 'outbound' AND inbound_service_api_key_id IS NULL)
        OR (direction IN ('inbound', 'bidirectional') AND inbound_service_api_key_id IS NOT NULL)
      ),
      CHECK (
        (direction = 'inbound' AND NOT outbound_credential_configured)
        OR (direction IN ('outbound', 'bidirectional') AND outbound_credential_configured)
      ),
      CHECK (
        outbound_credential_configured = (
          credential_version IS NOT NULL
          AND credential_origin IS NOT NULL
          AND credential_fingerprint IS NOT NULL
          AND sealed_credential IS NOT NULL
        )
      ),
      CHECK (credential_version IS NULL OR credential_version BETWEEN 1 AND 2147483647),
      CHECK (credential_fingerprint IS NULL OR credential_fingerprint ~ '^[a-f0-9]{64}$'),
      CHECK (cardinality(allowed_skill_ids) BETWEEN 1 AND 64),
      CHECK (
        allowed_inbound_agent_ids <@ ARRAY[
          'atlas', 'scout', 'forge', 'sentinel', 'mnemosyne'
        ]::TEXT[]
      ),
      CHECK (
        (direction = 'outbound' AND cardinality(allowed_inbound_agent_ids) = 0)
        OR (
          direction IN ('inbound', 'bidirectional')
          AND cardinality(allowed_inbound_agent_ids) BETWEEN 1 AND 5
        )
      ),
      CHECK (max_task_duration_ms BETWEEN 1000 AND 3600000),
      CHECK (max_input_bytes BETWEEN 1 AND 1000000),
      CHECK (max_output_bytes BETWEEN 1 AND 2000000),
      CHECK (jsonb_typeof(rollout) = 'object'),
      CHECK (rollout->>'version' = 'p8.6-a2a-peer-rollout:1'),
      CHECK (rollout->>'tenantId' = tenant_id),
      CHECK (rollout->>'ownerActorId' = owner_actor_id),
      CHECK (rollout->>'peerId' = peer_id),
      CHECK ((rollout->>'generation')::BIGINT = generation),
      CHECK (rollout->>'rolloutId' = rollout_id),
      CHECK (rollout->>'rolloutSha256' = rollout_sha256),
      CHECK (rollout->>'direction' = direction),
      CHECK (rollout->>'mode' = mode),
      CHECK (rollout->>'status' = status),
      CHECK ((rollout->>'lifecycleRevision')::BIGINT = lifecycle_revision),
      CHECK (rollout->>'interfaceUrl' = interface_url),
      CHECK (rollout->>'agentCardSha256' = agent_card_sha256),
      CHECK (rollout->>'protocolVersion' = protocol_version),
      CHECK (rollout->>'protocolBinding' = protocol_binding),
      CHECK (rollout->>'adapterRelease' = adapter_release),
      CHECK (rollout->>'adapterArtifactSha256' = adapter_artifact_sha256),
      CHECK ((rollout->>'inboundServiceApiKeyId') IS NOT DISTINCT FROM inbound_service_api_key_id),
      CHECK ((rollout->>'outboundCredentialConfigured')::BOOLEAN = outbound_credential_configured),
      CHECK ((rollout->>'createdAt')::TIMESTAMPTZ = created_at),
      CHECK ((rollout->>'updatedAt')::TIMESTAMPTZ = updated_at),
      CHECK (created_at <= updated_at),
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (inbound_service_api_key_id)
        REFERENCES omni_service_api_keys (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

CREATE UNIQUE INDEX IF NOT EXISTS omni_a2a_peer_rollouts_current_idx
    ON omni_a2a_peer_rollouts (tenant_id, owner_actor_id, peer_id)
    WHERE status <> 'revoked';

CREATE UNIQUE INDEX IF NOT EXISTS omni_a2a_peer_rollouts_inbound_key_idx
    ON omni_a2a_peer_rollouts (tenant_id, inbound_service_api_key_id)
    WHERE status = 'active' AND mode = 'enabled'
      AND inbound_service_api_key_id IS NOT NULL;

CREATE OR REPLACE FUNCTION omni_protect_a2a_peer_rollout_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'A2A peer rollouts cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'registered' OR NEW.lifecycle_revision <> 0
          OR NEW.updated_at IS DISTINCT FROM NEW.created_at
        THEN
          RAISE EXCEPTION 'Initial A2A peer rollout is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.peer_id,
        NEW.generation, NEW.rollout_id, NEW.direction, NEW.mode,
        NEW.interface_url, NEW.interface_origin, NEW.agent_card_sha256,
        NEW.protocol_version, NEW.protocol_binding, NEW.adapter_release,
        NEW.adapter_artifact_sha256, NEW.inbound_service_api_key_id,
        NEW.outbound_credential_configured, NEW.credential_version,
        NEW.credential_origin, NEW.credential_fingerprint,
        NEW.sealed_credential, NEW.allowed_skill_ids,
        NEW.allowed_inbound_agent_ids,
        NEW.max_task_duration_ms, NEW.max_input_bytes, NEW.max_output_bytes,
        NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.peer_id,
        OLD.generation, OLD.rollout_id, OLD.direction, OLD.mode,
        OLD.interface_url, OLD.interface_origin, OLD.agent_card_sha256,
        OLD.protocol_version, OLD.protocol_binding, OLD.adapter_release,
        OLD.adapter_artifact_sha256, OLD.inbound_service_api_key_id,
        OLD.outbound_credential_configured, OLD.credential_version,
        OLD.credential_origin, OLD.credential_fingerprint,
        OLD.sealed_credential, OLD.allowed_skill_ids,
        OLD.allowed_inbound_agent_ids,
        OLD.max_task_duration_ms, OLD.max_input_bytes, OLD.max_output_bytes,
        OLD.created_at
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
        OR NEW.updated_at < OLD.updated_at
      THEN
        RAISE EXCEPTION 'A2A peer rollout identity or revision is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NOT (
        (OLD.status = 'registered' AND NEW.status IN ('active', 'revoked'))
        OR (OLD.status = 'active' AND NEW.status IN ('paused', 'revoked'))
        OR (OLD.status = 'paused' AND NEW.status IN ('active', 'revoked'))
      ) THEN
        RAISE EXCEPTION 'A2A peer rollout transition is invalid'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$;

DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_a2a_peer_rollout_protect
        ON omni_a2a_peer_rollouts;
      CREATE TRIGGER omni_a2a_peer_rollout_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_a2a_peer_rollouts
      FOR EACH ROW EXECUTE FUNCTION omni_protect_a2a_peer_rollout_v1();
      DROP TRIGGER IF EXISTS omni_a2a_peer_rollout_no_truncate
        ON omni_a2a_peer_rollouts;
      CREATE TRIGGER omni_a2a_peer_rollout_no_truncate
      BEFORE TRUNCATE ON omni_a2a_peer_rollouts
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_a2a_peer_rollout_v1();
      ALTER TABLE omni_a2a_peer_rollouts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_a2a_peer_rollouts FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS omni_a2a_peer_rollouts_actor
        ON omni_a2a_peer_rollouts;
      CREATE POLICY omni_a2a_peer_rollouts_actor
      ON omni_a2a_peer_rollouts AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
    END
    $migration$;

REVOKE ALL ON TABLE omni_a2a_peer_rollouts FROM PUBLIC;

REVOKE ALL ON FUNCTION omni_protect_a2a_peer_rollout_v1() FROM PUBLIC;

DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_peer_rollouts FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_a2a_peer_rollouts TO omni_runtime;
        GRANT UPDATE (
          status, lifecycle_revision, rollout_sha256, rollout, updated_at
        ) ON omni_a2a_peer_rollouts TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_peer_rollouts FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_a2a_peer_rollouts TO omni_maintenance;
        GRANT UPDATE (
          status, lifecycle_revision, rollout_sha256, rollout, updated_at
        ) ON omni_a2a_peer_rollouts TO omni_maintenance;
      END IF;
    END
    $migration$;

DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_a2a_peer_rollouts'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_a2a_peer_rollouts'::regclass
          AND tgname = 'omni_a2a_peer_rollout_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_a2a_peer_rollouts'::regclass
          AND tgname = 'omni_a2a_peer_rollout_no_truncate'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_a2a_peer_rollouts'::regclass
          AND polname = 'omni_a2a_peer_rollouts_actor'
          AND NOT polpermissive AND polcmd = '*'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_a2a_peer_rollouts'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_column_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_a2a_peer_rollouts'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type = 'UPDATE'
          AND column_name NOT IN (
            'status', 'lifecycle_revision', 'rollout_sha256',
            'rollout', 'updated_at'
          )
      ) THEN
        RAISE EXCEPTION 'A2A peer rollout boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
   VALUES (117, 'a2a_peer_rollouts_v1',
     'a11e97b868005023fe398d66bb795bd9939ca3b19963515452a54fe849aecb67', NOW());

DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 117
          AND name = 'a2a_peer_rollouts_v1'
          AND checksum =
            'a11e97b868005023fe398d66bb795bd9939ca3b19963515452a54fe849aecb67'
      ) <> 1 THEN
        RAISE EXCEPTION 'A2A task mapping predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

CREATE TABLE IF NOT EXISTS omni_a2a_task_mappings (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      mapping_id TEXT NOT NULL,
      mapping_sha256 TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      rollout_id TEXT NOT NULL,
      rollout_sha256 TEXT NOT NULL,
      direction TEXT NOT NULL,
      external_task_id TEXT NOT NULL,
      external_context_id TEXT NOT NULL,
      internal_task_id TEXT NOT NULL,
      internal_delegation_id TEXT NOT NULL,
      internal_contract_sha256 TEXT NOT NULL,
      local_agent_id TEXT NOT NULL,
      local_agent_definition_version BIGINT NOT NULL,
      negotiated_skill_id TEXT NOT NULL,
      mapping JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, mapping_id),
      UNIQUE (tenant_id, owner_actor_id, peer_id, external_task_id),
      UNIQUE (tenant_id, internal_task_id),
      CHECK (schema_version = 1),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(mapping_id) BETWEEN 1 AND 240),
      CHECK (mapping_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (char_length(peer_id) BETWEEN 1 AND 240),
      CHECK (char_length(rollout_id) BETWEEN 1 AND 240),
      CHECK (rollout_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (direction IN ('inbound', 'outbound')),
      CHECK (char_length(external_task_id) BETWEEN 1 AND 240),
      CHECK (char_length(external_context_id) BETWEEN 1 AND 240),
      CHECK (char_length(internal_task_id) BETWEEN 1 AND 240),
      CHECK (char_length(internal_delegation_id) BETWEEN 1 AND 240),
      CHECK (internal_contract_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (local_agent_id IN ('atlas', 'scout', 'forge', 'sentinel', 'mnemosyne')),
      CHECK (local_agent_definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (char_length(negotiated_skill_id) BETWEEN 1 AND 240),
      CHECK (jsonb_typeof(mapping) = 'object'),
      CHECK (mapping->>'version' = 'p8.6-a2a-task-mapping:1'),
      CHECK (mapping->>'mappingId' = mapping_id),
      CHECK (mapping->>'mappingSha256' = mapping_sha256),
      CHECK (mapping->>'tenantId' = tenant_id),
      CHECK (mapping->>'ownerActorId' = owner_actor_id),
      CHECK (mapping->>'peerId' = peer_id),
      CHECK (mapping->>'rolloutId' = rollout_id),
      CHECK (mapping->>'rolloutSha256' = rollout_sha256),
      CHECK (mapping->>'direction' = direction),
      CHECK (mapping->>'externalTaskId' = external_task_id),
      CHECK (mapping->>'externalContextId' = external_context_id),
      CHECK (mapping->>'internalTaskId' = internal_task_id),
      CHECK (mapping->>'internalDelegationId' = internal_delegation_id),
      CHECK (mapping->>'internalContractSha256' = internal_contract_sha256),
      CHECK (mapping->>'localAgentId' = local_agent_id),
      CHECK ((mapping->>'localAgentDefinitionVersion')::BIGINT = local_agent_definition_version),
      CHECK (mapping->>'negotiatedSkillId' = negotiated_skill_id),
      CHECK ((mapping->>'createdAt')::TIMESTAMPTZ = created_at),
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, rollout_id)
        REFERENCES omni_a2a_peer_rollouts (tenant_id, rollout_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, internal_task_id)
        REFERENCES omni_delegation_tasks (tenant_id, task_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

CREATE INDEX IF NOT EXISTS omni_a2a_task_mappings_context_idx
    ON omni_a2a_task_mappings (
      tenant_id, owner_actor_id, peer_id, external_context_id, created_at DESC
    );

CREATE TABLE IF NOT EXISTS omni_a2a_exchanges (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      sequence BIGSERIAL NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      exchange_sha256 TEXT NOT NULL,
      mapping_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      external_task_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      payload_type TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload JSONB NOT NULL,
      exchange JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, exchange_id),
      UNIQUE (sequence),
      CHECK (schema_version = 1),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(exchange_id) BETWEEN 1 AND 240),
      CHECK (exchange_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (char_length(mapping_id) BETWEEN 1 AND 240),
      CHECK (char_length(peer_id) BETWEEN 1 AND 240),
      CHECK (char_length(external_task_id) BETWEEN 1 AND 240),
      CHECK (direction IN ('inbound', 'outbound')),
      CHECK (payload_type IN ('message', 'artifact', 'status')),
      CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (jsonb_typeof(payload) = 'object'),
      CHECK (jsonb_typeof(exchange) = 'object'),
      CHECK (pg_column_size(payload) <= 262144),
      CHECK (exchange->>'version' = 'p8.6-a2a-exchange:1'),
      CHECK (exchange->>'exchangeId' = exchange_id),
      CHECK (exchange->>'exchangeSha256' = exchange_sha256),
      CHECK (exchange->>'tenantId' = tenant_id),
      CHECK (exchange->>'ownerActorId' = owner_actor_id),
      CHECK (exchange->>'mappingId' = mapping_id),
      CHECK (exchange->>'peerId' = peer_id),
      CHECK (exchange->>'externalTaskId' = external_task_id),
      CHECK (exchange->>'direction' = direction),
      CHECK (exchange->>'payloadSha256' = payload_sha256),
      CHECK (exchange->'payload'->>'type' = payload_type),
      CHECK ((exchange->>'createdAt')::TIMESTAMPTZ = created_at),
      FOREIGN KEY (tenant_id, mapping_id)
        REFERENCES omni_a2a_task_mappings (tenant_id, mapping_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

CREATE INDEX IF NOT EXISTS omni_a2a_exchanges_task_order_idx
    ON omni_a2a_exchanges (
      tenant_id, owner_actor_id, mapping_id, sequence
    );

CREATE OR REPLACE FUNCTION omni_reject_a2a_append_only_mutation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'A2A task mappings and exchanges are append-only'
        USING ERRCODE = '55000';
    END
    $function$;

DO $migration$
    DECLARE table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'omni_a2a_task_mappings', 'omni_a2a_exchanges'
      ] LOOP
        EXECUTE format(
          'DROP TRIGGER IF EXISTS %I ON %I',
          table_name || '_immutable', table_name
        );
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_reject_a2a_append_only_mutation_v1()',
          table_name || '_immutable', table_name
        );
        EXECUTE format(
          'DROP TRIGGER IF EXISTS %I ON %I',
          table_name || '_no_truncate', table_name
        );
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_a2a_append_only_mutation_v1()',
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

REVOKE ALL ON TABLE omni_a2a_task_mappings FROM PUBLIC;

REVOKE ALL ON TABLE omni_a2a_exchanges FROM PUBLIC;

REVOKE ALL ON FUNCTION omni_reject_a2a_append_only_mutation_v1() FROM PUBLIC;

    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_task_mappings FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_exchanges FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON SEQUENCE omni_a2a_exchanges_sequence_seq FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_a2a_task_mappings TO omni_runtime;
        GRANT SELECT, INSERT ON omni_a2a_exchanges TO omni_runtime;
        GRANT USAGE, SELECT ON SEQUENCE omni_a2a_exchanges_sequence_seq TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_task_mappings FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON TABLE omni_a2a_exchanges FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON SEQUENCE omni_a2a_exchanges_sequence_seq FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_a2a_task_mappings TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_a2a_exchanges TO omni_maintenance;
        GRANT USAGE, SELECT ON SEQUENCE omni_a2a_exchanges_sequence_seq TO omni_maintenance;
      END IF;
    END
    $migration$;

DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name IN ('omni_a2a_task_mappings', 'omni_a2a_exchanges')
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) OR EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname IN ('omni_a2a_task_mappings', 'omni_a2a_exchanges')
          AND (NOT relrowsecurity OR NOT relforcerowsecurity)
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid IN (
          'omni_a2a_task_mappings'::regclass,
          'omni_a2a_exchanges'::regclass
        ) AND NOT polpermissive AND polcmd = '*'
      ) <> 2 THEN
        RAISE EXCEPTION 'A2A task mapping boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
   VALUES (118, 'a2a_task_mappings_v1',
     '79e1d6eab1184b8737e08f128ae49d6c966b53d7386d36c1e94efd5974085f8c', NOW());

COMMIT;
