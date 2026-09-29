import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for agents: identity versions, personas, private
// memory and grants, releases and adaptation.

export async function ensureAgentAssignmentHistory(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'atlas'`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS specialist_ids TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_agent_idx ON omni_agent_runs (tenant_id, agent_id, started_at DESC)`;
}

export async function ensureAgentOutcomeFeedback(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS feedback JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_feedback_idx ON omni_agent_runs (tenant_id, agent_id, started_at DESC) WHERE feedback IS NOT NULL`;
}

export async function ensureAgentIdentityVersionsV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 107
          AND name = 'graph_query_telemetry_v1'
          AND checksum =
            'b827edb34b4b148e950daf528fefed302ba2584eeb8d552cb241e47c7b256383'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent identity v107 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    LOCK TABLE
      omni_custom_agents,
      omni_auth_users,
      omni_auth_user_actor_identifiers,
      omni_tenant_execution_principals
    IN SHARE ROW EXCLUSIVE MODE
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_definition_versions (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      definition_version BIGINT NOT NULL,
      previous_definition_version BIGINT,
      owner_actor_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      accent TEXT NOT NULL,
      model_policy TEXT NOT NULL,
      skill_ids TEXT[] NOT NULL DEFAULT '{}',
      published_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, agent_definition_id, definition_version),
      CHECK (schema_version = 1),
      CHECK (char_length(agent_definition_id) BETWEEN 1 AND 240),
      CHECK (definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (
        (definition_version = 1 AND previous_definition_version IS NULL)
        OR previous_definition_version = definition_version - 1
      ),
      CHECK (
        owner_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ),
      CHECK (char_length(slug) BETWEEN 1 AND 80),
      CHECK (char_length(name) BETWEEN 1 AND 120),
      CHECK (char_length(role) BETWEEN 1 AND 120),
      CHECK (char_length(description) BETWEEN 1 AND 700),
      CHECK (char_length(instructions) <= 12000),
      CHECK (status IN ('ready', 'learning', 'paused')),
      CHECK (accent IN ('emerald', 'blue', 'amber', 'violet', 'rose')),
      CHECK (model_policy IN (
        'auto', 'openai_fast', 'openai_reasoning', 'gemini_fast',
        'anthropic_fast', 'anthropic_reasoning'
      )),
      CHECK (cardinality(skill_ids) <= 50),
      FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_definition_versions_owner_idx
    ON omni_agent_definition_versions (
      tenant_id, owner_actor_id, agent_definition_id, definition_version DESC
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_principal_policies (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_generation BIGINT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      agent_definition_version BIGINT NOT NULL,
      authority_mode TEXT NOT NULL DEFAULT 'explicit_grants',
      autonomy TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      memory_scope TEXT NOT NULL,
      tool_grant_ids TEXT[] NOT NULL DEFAULT '{}',
      context_grant_ids TEXT[] NOT NULL DEFAULT '{}',
      capability_grant_ids TEXT[] NOT NULL DEFAULT '{}',
      budget_policy_version_id TEXT NOT NULL DEFAULT 'agent-run-budget:2',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, principal_id, principal_generation),
      CHECK (schema_version = 1),
      CHECK (authority_mode IN ('server_policy', 'explicit_grants')),
      CHECK (autonomy IN ('assist', 'governed', 'execute')),
      CHECK (approval_policy IN ('always', 'risk_based', 'read_only')),
      CHECK (memory_scope IN ('session', 'project', 'all')),
      CHECK (cardinality(tool_grant_ids) <= 50),
      CHECK (cardinality(context_grant_ids) <= 256),
      CHECK (cardinality(capability_grant_ids) <= 256),
      CHECK (
        authority_mode <> 'server_policy'
        OR (
          cardinality(tool_grant_ids) = 0
          AND cardinality(context_grant_ids) = 0
          AND cardinality(capability_grant_ids) = 0
        )
      ),
      CHECK (expires_at IS NULL OR expires_at > created_at),
      FOREIGN KEY (tenant_id, principal_id, principal_generation)
        REFERENCES omni_tenant_execution_principals (
          tenant_id, principal_id, principal_generation
        )
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (
        tenant_id, agent_definition_id, agent_definition_version
      ) REFERENCES omni_agent_definition_versions (
        tenant_id, agent_definition_id, definition_version
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_principal_policies_owner_idx
    ON omni_agent_principal_policies (
      tenant_id, owner_actor_id, agent_definition_id,
      principal_generation DESC
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_identity_backfill_holds (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, agent_definition_id),
      CHECK (schema_version = 1),
      CHECK (reason IN ('missing_controller', 'ambiguous_controller')),
      FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_agent_identity_history_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Agent identity history is immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_agent_definition_version_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_version BIGINT;
      expected_previous_version BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id), hashtext(NEW.agent_definition_id)
      );
      SELECT COALESCE(MAX(definition_version), 0) + 1
      INTO expected_version
      FROM public.omni_agent_definition_versions
      WHERE tenant_id = NEW.tenant_id
        AND agent_definition_id = NEW.agent_definition_id;
      expected_previous_version := CASE
        WHEN expected_version = 1 THEN NULL
        ELSE expected_version - 1
      END;
      IF NEW.definition_version IS DISTINCT FROM expected_version
        OR NEW.previous_definition_version IS DISTINCT FROM
          expected_previous_version
      THEN
        RAISE EXCEPTION 'Agent definition version is not the next revision'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_custom_agents definition
        JOIN public.omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier COLLATE "C" =
            definition.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = NEW.owner_actor_id
        WHERE definition.tenant_id = NEW.tenant_id
          AND definition.id = NEW.agent_definition_id
      ) THEN
        RAISE EXCEPTION 'Agent definition owner is invalid'
          USING ERRCODE = '23503';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.omni_agent_definition_versions
        WHERE tenant_id = NEW.tenant_id
          AND agent_definition_id = NEW.agent_definition_id
          AND published_at >= NEW.published_at
      ) THEN
        RAISE EXCEPTION 'Agent definition publication time is not monotonic'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_agent_principal_activation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NEW.principal_kind = 'agent'
        AND NEW.state = 'active'
        AND OLD.state IS DISTINCT FROM 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM public.omni_agent_principal_policies policy
          WHERE policy.tenant_id = NEW.tenant_id
            AND policy.principal_id = NEW.principal_id
            AND policy.principal_generation = NEW.principal_generation
            AND policy.owner_actor_id = NEW.controller_actor_id
            AND policy.agent_definition_id = NEW.agent_definition_id
        )
      THEN
        RAISE EXCEPTION 'Agent principal activation requires an exact policy version'
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_agent_definition_version_validate
        ON omni_agent_definition_versions;
      CREATE TRIGGER omni_agent_definition_version_validate
      BEFORE INSERT ON omni_agent_definition_versions
      FOR EACH ROW EXECUTE FUNCTION omni_validate_agent_definition_version_v1();
      DROP TRIGGER IF EXISTS omni_agent_definition_history_protect
        ON omni_agent_definition_versions;
      CREATE TRIGGER omni_agent_definition_history_protect
      BEFORE UPDATE OR DELETE ON omni_agent_definition_versions
      FOR EACH ROW EXECUTE FUNCTION omni_protect_agent_identity_history_v1();
      DROP TRIGGER IF EXISTS omni_agent_definition_history_no_truncate
        ON omni_agent_definition_versions;
      CREATE TRIGGER omni_agent_definition_history_no_truncate
      BEFORE TRUNCATE ON omni_agent_definition_versions
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_agent_identity_history_v1();
      DROP TRIGGER IF EXISTS omni_agent_principal_policy_history_protect
        ON omni_agent_principal_policies;
      CREATE TRIGGER omni_agent_principal_policy_history_protect
      BEFORE UPDATE OR DELETE ON omni_agent_principal_policies
      FOR EACH ROW EXECUTE FUNCTION omni_protect_agent_identity_history_v1();
      DROP TRIGGER IF EXISTS omni_agent_principal_policy_history_no_truncate
        ON omni_agent_principal_policies;
      CREATE TRIGGER omni_agent_principal_policy_history_no_truncate
      BEFORE TRUNCATE ON omni_agent_principal_policies
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_agent_identity_history_v1();
      DROP TRIGGER IF EXISTS omni_execution_principal_policy_activation
        ON omni_tenant_execution_principals;
      CREATE TRIGGER omni_execution_principal_policy_activation
      BEFORE UPDATE OF state ON omni_tenant_execution_principals
      FOR EACH ROW EXECUTE FUNCTION omni_validate_agent_principal_activation_v1();
    END
    $migration$
  `;
  await sql`
    INSERT INTO omni_agent_identity_backfill_holds (
      tenant_id, agent_definition_id, reason
    )
    SELECT
      agent.tenant_id,
      agent.id,
      CASE WHEN COUNT(DISTINCT identifier.canonical_actor_id) = 0
        THEN 'missing_controller'
        ELSE 'ambiguous_controller'
      END
    FROM omni_custom_agents agent
    LEFT JOIN omni_auth_user_actor_identifiers identifier
      ON identifier.actor_identifier COLLATE "C" = agent.actor_id COLLATE "C"
    GROUP BY agent.tenant_id, agent.id
    HAVING COUNT(DISTINCT identifier.canonical_actor_id) <> 1
    ON CONFLICT (tenant_id, agent_definition_id) DO NOTHING
  `;
  await sql`
    INSERT INTO omni_agent_definition_versions (
      tenant_id, agent_definition_id, definition_version,
      previous_definition_version, owner_actor_id, slug, name, role,
      description, instructions, status, accent, model_policy, skill_ids,
      published_at
    )
    SELECT
      agent.tenant_id,
      agent.id,
      1,
      NULL,
      MIN(identifier.canonical_actor_id),
      agent.slug,
      agent.name,
      agent.role,
      agent.description,
      agent.instructions,
      agent.status,
      agent.accent,
      agent.model_policy,
      agent.skill_ids,
      agent.updated_at
    FROM omni_custom_agents agent
    JOIN omni_auth_user_actor_identifiers identifier
      ON identifier.actor_identifier COLLATE "C" = agent.actor_id COLLATE "C"
    GROUP BY
      agent.tenant_id, agent.id, agent.slug, agent.name, agent.role,
      agent.description, agent.instructions, agent.status, agent.accent,
      agent.model_policy, agent.skill_ids, agent.updated_at
    HAVING COUNT(DISTINCT identifier.canonical_actor_id) = 1
    ON CONFLICT (tenant_id, agent_definition_id, definition_version)
      DO NOTHING
  `;
  await sql`
    INSERT INTO omni_tenant_execution_principals (
      tenant_id, principal_kind, principal_id, principal_generation,
      controller_actor_id, agent_definition_id, system_principal_class,
      state, lifecycle_revision, created_by_actor_id
    )
    SELECT
      definition.tenant_id,
      'agent',
      'agent:' || definition.agent_definition_id,
      1,
      definition.owner_actor_id,
      definition.agent_definition_id,
      NULL,
      'held',
      0,
      definition.owner_actor_id
    FROM omni_agent_definition_versions definition
    WHERE definition.definition_version = 1
      AND NOT EXISTS (
        SELECT 1
        FROM omni_tenant_execution_principals principal
        WHERE principal.tenant_id = definition.tenant_id
          AND principal.principal_id = 'agent:' || definition.agent_definition_id
      )
  `;
  await sql`
    INSERT INTO omni_agent_principal_policies (
      tenant_id, principal_id, principal_generation, owner_actor_id,
      agent_definition_id, agent_definition_version, authority_mode,
      autonomy, approval_policy, memory_scope, tool_grant_ids,
      context_grant_ids, capability_grant_ids, budget_policy_version_id,
      created_at
    )
    SELECT
      principal.tenant_id,
      principal.principal_id,
      principal.principal_generation,
      principal.controller_actor_id,
      principal.agent_definition_id,
      1,
      'explicit_grants',
      agent.autonomy,
      agent.approval_policy,
      agent.memory_scope,
      agent.tool_ids,
      '{}',
      '{}',
      'agent-run-budget:2',
      principal.created_at
    FROM omni_tenant_execution_principals principal
    JOIN omni_custom_agents agent
      ON agent.tenant_id = principal.tenant_id
      AND agent.id = principal.agent_definition_id
    WHERE principal.principal_kind = 'agent'
      AND principal.principal_generation = 1
    ON CONFLICT (tenant_id, principal_id, principal_generation) DO NOTHING
  `;
  await sql`
    ALTER TABLE omni_tenant_execution_principals
    DROP CONSTRAINT IF EXISTS omni_execution_principal_activation_hold_check
  `;
  await sql`
    UPDATE omni_tenant_execution_principals principal
    SET state = 'active',
        lifecycle_revision = 1,
        activated_by_actor_id = principal.controller_actor_id
    WHERE principal.principal_kind = 'agent'
      AND principal.state = 'held'
      AND EXISTS (
        SELECT 1
        FROM omni_agent_principal_policies policy
        WHERE policy.tenant_id = principal.tenant_id
          AND policy.principal_id = principal.principal_id
          AND policy.principal_generation = principal.principal_generation
      )
  `;
  await sql`
    ALTER TABLE omni_tenant_execution_principals
    DROP CONSTRAINT IF EXISTS omni_execution_principal_agent_definition_fkey
  `;
  await sql`
    DO $migration$
    DECLARE
      policy_name TEXT;
    BEGIN
      ALTER TABLE omni_agent_definition_versions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_definition_versions FORCE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_principal_policies ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_principal_policies FORCE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_identity_backfill_holds ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_identity_backfill_holds FORCE ROW LEVEL SECURITY;
      FOREACH policy_name IN ARRAY ARRAY[
        'omni_execution_principal_holdback',
        'omni_execution_principal_actor_select',
        'omni_execution_principal_actor_insert',
        'omni_execution_principal_actor_update'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON omni_tenant_execution_principals',
          policy_name
        );
      END LOOP;
      CREATE POLICY omni_execution_principal_actor_select
      ON omni_tenant_execution_principals AS RESTRICTIVE FOR SELECT
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, controller_actor_id)
      );
      CREATE POLICY omni_execution_principal_actor_insert
      ON omni_tenant_execution_principals AS RESTRICTIVE FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, controller_actor_id)
      );
      CREATE POLICY omni_execution_principal_actor_update
      ON omni_tenant_execution_principals AS RESTRICTIVE FOR UPDATE
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, controller_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, controller_actor_id)
      );
      CREATE POLICY omni_agent_definition_versions_actor
      ON omni_agent_definition_versions AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_agent_principal_policies_actor
      ON omni_agent_principal_policies AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_agent_identity_backfill_holds_system
      ON omni_agent_identity_backfill_holds AS RESTRICTIVE FOR ALL
      USING (omni_system_scope_enabled())
      WITH CHECK (omni_system_scope_enabled());
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_agent_definition_versions FROM PUBLIC`;
  await sql`REVOKE ALL ON TABLE omni_agent_principal_policies FROM PUBLIC`;
  await sql`REVOKE ALL ON TABLE omni_agent_identity_backfill_holds FROM PUBLIC`;
  await sql`REVOKE ALL ON TABLE omni_tenant_execution_principals FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_definition_versions FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_principal_policies FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_identity_backfill_holds FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON TABLE omni_tenant_execution_principals FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_agent_definition_versions TO omni_runtime;
        GRANT SELECT, INSERT ON omni_agent_principal_policies TO omni_runtime;
        GRANT SELECT, INSERT ON omni_tenant_execution_principals TO omni_runtime;
        GRANT UPDATE (
          state, lifecycle_revision, activated_by_actor_id, revoked_by_actor_id
        ) ON omni_tenant_execution_principals TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_definition_versions FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_principal_policies FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_identity_backfill_holds FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON TABLE omni_tenant_execution_principals FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_agent_definition_versions TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_agent_principal_policies TO omni_maintenance;
        GRANT SELECT ON omni_agent_identity_backfill_holds TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_tenant_execution_principals TO omni_maintenance;
        GRANT UPDATE (
          state, lifecycle_revision, activated_by_actor_id, revoked_by_actor_id
        ) ON omni_tenant_execution_principals TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        JOIN omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier COLLATE "C" = agent.actor_id COLLATE "C"
        GROUP BY agent.tenant_id, agent.id
        HAVING COUNT(DISTINCT identifier.canonical_actor_id) = 1
          AND (
            NOT EXISTS (
              SELECT 1 FROM omni_agent_definition_versions definition
              WHERE definition.tenant_id = agent.tenant_id
                AND definition.agent_definition_id = agent.id
            )
            OR NOT EXISTS (
              SELECT 1 FROM omni_tenant_execution_principals principal
              JOIN omni_agent_principal_policies policy
                ON policy.tenant_id = principal.tenant_id
                AND policy.principal_id = principal.principal_id
                AND policy.principal_generation = principal.principal_generation
              WHERE principal.tenant_id = agent.tenant_id
                AND principal.agent_definition_id = agent.id
                AND principal.state = 'active'
            )
          )
      ) THEN
        RAISE EXCEPTION 'Agent identity backfill parity is incomplete'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_tenant_execution_principals principal
        WHERE principal.principal_kind = 'agent'
          AND principal.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM omni_agent_principal_policies policy
            WHERE policy.tenant_id = principal.tenant_id
              AND policy.principal_id = principal.principal_id
              AND policy.principal_generation = principal.principal_generation
          )
      ) THEN
        RAISE EXCEPTION 'Active agent principal is missing its policy version'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND grantee = 'omni_runtime'
          AND table_name IN (
            'omni_agent_definition_versions',
            'omni_agent_principal_policies',
            'omni_agent_identity_backfill_holds'
          )
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND grantee = 'omni_runtime'
          AND table_name = 'omni_tenant_execution_principals'
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Agent identity runtime grants are too broad'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentDefinitionPersonaV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 108
          AND name = 'agent_identity_versions_v1'
          AND checksum =
            '0061d42b7a5638ffb41b2c51038df6d082c183b08f94aec5d3196920430be476'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent persona v109 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_agent_persona_v1_is_valid(value JSONB)
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    PARALLEL SAFE
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(value) <> 'object' THEN FALSE
        WHEN NOT value ?& ARRAY[
          'schemaVersion', 'charter', 'operatingStyle', 'voice',
          'visualIdentity', 'allowedDomains', 'escalationBehavior',
          'successMeasures'
        ] THEN FALSE
        WHEN (SELECT count(*) FROM jsonb_object_keys(value)) <> 8 THEN FALSE
        WHEN value->>'schemaVersion' <> '1' THEN FALSE
        WHEN jsonb_typeof(value->'charter') <> 'string'
          OR char_length(btrim(value->>'charter')) NOT BETWEEN 2 AND 2000
          OR jsonb_typeof(value->'operatingStyle') <> 'string'
          OR char_length(btrim(value->>'operatingStyle')) NOT BETWEEN 2 AND 2000
          OR jsonb_typeof(value->'voice') <> 'string'
          OR char_length(btrim(value->>'voice')) NOT BETWEEN 2 AND 500
          OR jsonb_typeof(value->'visualIdentity') <> 'string'
          OR char_length(btrim(value->>'visualIdentity')) NOT BETWEEN 2 AND 500
          OR jsonb_typeof(value->'escalationBehavior') <> 'string'
          OR char_length(btrim(value->>'escalationBehavior')) NOT BETWEEN 2 AND 1000
          OR jsonb_typeof(value->'allowedDomains') <> 'array'
          OR jsonb_typeof(value->'successMeasures') <> 'array'
        THEN FALSE
        ELSE
          jsonb_array_length(value->'allowedDomains') <= 20
          AND jsonb_array_length(value->'successMeasures') <= 20
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(value->'allowedDomains') item
            WHERE jsonb_typeof(item) <> 'string'
              OR char_length(btrim(item #>> '{}')) NOT BETWEEN 2 AND 120
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(value->'successMeasures') item
            WHERE jsonb_typeof(item) <> 'string'
              OR char_length(btrim(item #>> '{}')) NOT BETWEEN 2 AND 200
          )
          AND (
            SELECT count(*) = count(DISTINCT lower(btrim(item #>> '{}')))
            FROM jsonb_array_elements(value->'allowedDomains') item
          )
          AND (
            SELECT count(*) = count(DISTINCT lower(btrim(item #>> '{}')))
            FROM jsonb_array_elements(value->'successMeasures') item
          )
      END
    $function$
  `;
  await sql`
    ALTER TABLE omni_custom_agents
      ADD COLUMN IF NOT EXISTS persona_profile JSONB NOT NULL DEFAULT
        '{
          "schemaVersion": 1,
          "charter": "Complete the assigned objective within the user scope.",
          "operatingStyle": "Work in evidence-backed steps and verify the result.",
          "voice": "Clear, direct, calm, and explicit about uncertainty.",
          "visualIdentity": "A focused specialist companion using the selected Agent accent.",
          "allowedDomains": ["General assistance"],
          "escalationBehavior": "Escalate missing authority, context, or consequential approval.",
          "successMeasures": ["The requested outcome is complete and verified."]
        }'::jsonb
  `;
  await sql`
    ALTER TABLE omni_agent_definition_versions
      ADD COLUMN IF NOT EXISTS persona_profile JSONB NOT NULL DEFAULT
        '{
          "schemaVersion": 1,
          "charter": "Complete the assigned objective within the user scope.",
          "operatingStyle": "Work in evidence-backed steps and verify the result.",
          "voice": "Clear, direct, calm, and explicit about uncertainty.",
          "visualIdentity": "A focused specialist companion using the selected Agent accent.",
          "allowedDomains": ["General assistance"],
          "escalationBehavior": "Escalate missing authority, context, or consequential approval.",
          "successMeasures": ["The requested outcome is complete and verified."]
        }'::jsonb
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_custom_agents'::regclass
          AND conname = 'omni_custom_agents_persona_profile_valid'
      ) THEN
        ALTER TABLE omni_custom_agents
          ADD CONSTRAINT omni_custom_agents_persona_profile_valid
          CHECK (omni_agent_persona_v1_is_valid(persona_profile));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_agent_definition_versions'::regclass
          AND conname = 'omni_agent_definition_versions_persona_profile_valid'
      ) THEN
        ALTER TABLE omni_agent_definition_versions
          ADD CONSTRAINT omni_agent_definition_versions_persona_profile_valid
          CHECK (omni_agent_persona_v1_is_valid(persona_profile));
      END IF;
    END
    $migration$
  `;
  await sql`REVOKE ALL ON FUNCTION omni_agent_persona_v1_is_valid(JSONB) FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF to_regprocedure('public.omni_agent_persona_v1_is_valid(jsonb)') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'omni_custom_agents'
            AND column_name = 'persona_profile'
            AND is_nullable = 'NO'
        )
        OR NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'omni_agent_definition_versions'
            AND column_name = 'persona_profile'
            AND is_nullable = 'NO'
        )
        OR (
          SELECT count(*) FROM pg_constraint
          WHERE conname IN (
            'omni_custom_agents_persona_profile_valid',
            'omni_agent_definition_versions_persona_profile_valid'
          ) AND convalidated
        ) <> 2
      THEN
        RAISE EXCEPTION 'Agent persona v1 storage boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentPrivateMemoryV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 109
          AND name = 'agent_definition_persona_v1'
          AND checksum =
            '4c853b38ba5b8a2643c10c9a17789f0c2762feeb4dcc50e7eae1e2b0a086dc89'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent-private memory v110 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    DROP CONSTRAINT IF EXISTS omni_memories_user_private_canary_check
  `;
  await sql`
    ALTER TABLE omni_memories
    DROP CONSTRAINT IF EXISTS omni_memories_private_scope_v1_check
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD CONSTRAINT omni_memories_private_scope_v1_check CHECK (
      access_contract_version = 0
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND owner_actor_id IS NOT NULL
        AND workspace_id IS NULL
        AND project_id IS NULL
        AND mission_id IS NULL
        AND (
          (visibility = 'user_private' AND owner_agent_id IS NULL)
          OR (
            visibility = 'agent_private'
            AND owner_agent_id IS NOT NULL
            AND tier IN ('working', 'episodic', 'semantic', 'procedural')
          )
        )
      )
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_private_scope_v1_check
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_agent_private_memory_scope_v1_allows(
      row_tenant_id TEXT,
      row_owner_actor_id TEXT,
      row_owner_agent_id TEXT,
      row_allowed_purpose_ids TEXT[]
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      WITH access_scope AS (
        SELECT public.omni_current_memory_access_scope_v1() AS value
      )
      SELECT COALESCE(
        (value ->> 'tenantId') = row_tenant_id
        AND (value ->> 'initiatingActorId') = row_owner_actor_id
        AND (value ->> 'executingPrincipalType') = 'agent'
        AND (value ->> 'executingPrincipalId') = row_owner_agent_id
        AND value -> 'workspaceId' = 'null'::JSONB
        AND value -> 'projectId' = 'null'::JSONB
        AND value -> 'missionId' = 'null'::JSONB
        AND (value ->> 'purposeId') = ANY(row_allowed_purpose_ids),
        FALSE
      )
      FROM access_scope
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_agent_private_memory_scope_v1_allows(
      TEXT,
      TEXT,
      TEXT,
      TEXT[]
    ) FROM PUBLIC
  `;
  await sql`
    GRANT EXECUTE ON FUNCTION omni_agent_private_memory_scope_v1_allows(
      TEXT,
      TEXT,
      TEXT,
      TEXT[]
    ) TO PUBLIC
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_access_scope_holdback
    ON omni_memories
  `;
  await sql`
    CREATE POLICY omni_memory_access_scope_holdback
    ON omni_memories
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR (
        access_contract_version = 0
        AND omni_current_memory_access_scope_v1() IS NULL
      )
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND visibility = 'user_private'
        AND omni_user_private_memory_scope_v1_allows(
          tenant_id,
          owner_actor_id,
          allowed_purpose_ids
        )
      )
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND visibility = 'agent_private'
        AND omni_agent_private_memory_scope_v1_allows(
          tenant_id,
          owner_actor_id,
          owner_agent_id,
          allowed_purpose_ids
        )
      )
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR (
        access_contract_version = 0
        AND omni_current_memory_access_scope_v1() IS NULL
      )
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND visibility = 'user_private'
        AND omni_user_private_memory_scope_v1_allows(
          tenant_id,
          owner_actor_id,
          allowed_purpose_ids
        )
      )
      OR (
        access_contract_version = 1
        AND access_state = 'scope_bound'
        AND visibility = 'agent_private'
        AND omni_agent_private_memory_scope_v1_allows(
          tenant_id,
          owner_actor_id,
          owner_agent_id,
          allowed_purpose_ids
        )
      )
    )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_private_scope_v1_check'
          AND contype = 'c'
          AND convalidated
      ) OR to_regprocedure(
        'public.omni_agent_private_memory_scope_v1_allows(text,text,text,text[])'
      ) IS NULL OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND pg_get_expr(polqual, polrelid) LIKE
            '%omni_agent_private_memory_scope_v1_allows%'
          AND pg_get_expr(polwithcheck, polrelid) LIKE
            '%omni_agent_private_memory_scope_v1_allows%'
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version = 1
          AND visibility = 'agent_private'
          AND (
            owner_actor_id IS NULL
            OR owner_agent_id IS NULL
            OR workspace_id IS NOT NULL
            OR project_id IS NOT NULL
            OR mission_id IS NOT NULL
            OR tier NOT IN ('working', 'episodic', 'semantic', 'procedural')
          )
      ) THEN
        RAISE EXCEPTION 'Agent-private memory v1 storage boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentMemoryGrantsV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 110
          AND name = 'agent_private_memory_v1'
          AND checksum =
            '7472b7f5f3ce4099e0b74f6a71bd661cc5de465b014b0df06d9e85571d4ce54b'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent memory grants v111 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_memory_grants (
      tenant_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_memory_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      purpose_id TEXT NOT NULL,
      source_access_scope_sha256 TEXT NOT NULL,
      source_content_sha256 TEXT NOT NULL,
      target_access_scope_sha256 TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL,
      created_by_actor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      contract JSONB NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      PRIMARY KEY (tenant_id, grant_id),
      UNIQUE (tenant_id, target_memory_id),
      FOREIGN KEY (source_memory_id) REFERENCES omni_memories(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (target_memory_id) REFERENCES omni_memories(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (char_length(grant_id) BETWEEN 1 AND 240),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(source_agent_id) BETWEEN 1 AND 240),
      CHECK (char_length(target_agent_id) BETWEEN 1 AND 240),
      CHECK (source_agent_id <> target_agent_id),
      CHECK (purpose_id = 'memory.retrieve.v1'),
      CHECK (source_access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (target_access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (contract ->> 'version' = 'agent-memory-grant:1'),
      CHECK (contract ->> 'grantId' = grant_id),
      CHECK (contract ->> 'tenantId' = tenant_id),
      CHECK (contract ->> 'ownerActorId' = owner_actor_id),
      CHECK (contract ->> 'sourceAgentId' = source_agent_id),
      CHECK (contract ->> 'sourceMemoryId' = source_memory_id),
      CHECK (contract ->> 'targetAgentId' = target_agent_id),
      CHECK (contract ->> 'targetMemoryId' = target_memory_id),
      CHECK (contract ->> 'purposeId' = purpose_id),
      CHECK (
        contract ->> 'sourceAccessScopeSha256' =
          source_access_scope_sha256
      ),
      CHECK (contract ->> 'sourceContentSha256' = source_content_sha256),
      CHECK (
        contract ->> 'targetAccessScopeSha256' =
          target_access_scope_sha256
      ),
      CHECK (
        contract ->> 'idempotencyKeySha256' = idempotency_key_sha256
      ),
      CHECK (contract ->> 'createdByActorId' = created_by_actor_id),
      CHECK ((contract ->> 'createdAt')::TIMESTAMPTZ = created_at),
      CHECK (contract ->> 'artifactSha256' = artifact_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_memory_grants_source_idx
    ON omni_agent_memory_grants (
      tenant_id, owner_actor_id, source_agent_id, source_memory_id,
      created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_memory_grants_target_idx
    ON omni_agent_memory_grants (
      tenant_id, owner_actor_id, target_agent_id, created_at DESC
    )
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_agent_memory_grant_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Agent memory grants are append-only'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_memory_grants'::regclass
          AND tgname = 'omni_agent_memory_grants_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_agent_memory_grants_immutable
        BEFORE UPDATE OR DELETE ON omni_agent_memory_grants
        FOR EACH ROW EXECUTE FUNCTION omni_reject_agent_memory_grant_mutation();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_memory_grants'::regclass
          AND tgname = 'omni_agent_memory_grants_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_agent_memory_grants_no_truncate
        BEFORE TRUNCATE ON omni_agent_memory_grants
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_agent_memory_grant_mutation();
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    DECLARE
      policy_name TEXT;
    BEGIN
      ALTER TABLE omni_agent_memory_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_memory_grants FORCE ROW LEVEL SECURITY;
      FOREACH policy_name IN ARRAY ARRAY[
        'omni_agent_memory_grants_actor_select',
        'omni_agent_memory_grants_actor_insert'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON omni_agent_memory_grants',
          policy_name
        );
      END LOOP;
      CREATE POLICY omni_agent_memory_grants_actor_select
      ON omni_agent_memory_grants AS RESTRICTIVE FOR SELECT
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_agent_memory_grants_actor_insert
      ON omni_agent_memory_grants AS RESTRICTIVE FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR (
          owner_actor_id = created_by_actor_id
          AND omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        )
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_agent_memory_grants FROM PUBLIC`;
  await sql`
    REVOKE ALL ON FUNCTION omni_reject_agent_memory_grant_mutation()
    FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_memory_grants FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_agent_memory_grants TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_memory_grants FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_agent_memory_grants TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_agent_memory_grants'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_agent_memory_grants'::regclass
          AND NOT tgisinternal AND tgenabled = 'O'
      ) <> 2 OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_agent_memory_grants'::regclass
          AND NOT polpermissive
      ) <> 2 OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_agent_memory_grants'
          AND grantee = 'omni_runtime'
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Agent memory grant storage boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentMemoryGrantLifecycleV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 111
          AND name = 'agent_memory_grants_v1'
          AND checksum =
            '7e438818cab0afcf73dfe6aeda9d36edbf6bd7d81c83a26c92b1370f4a0b1dc6'
      ) <> 1 OR EXISTS (
        SELECT 1 FROM omni_tenant_memory_access_grants
        WHERE state <> 'held'
      ) THEN
        RAISE EXCEPTION 'Agent memory grant lifecycle predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_tenant_memory_access_grants
    DROP CONSTRAINT IF EXISTS omni_memory_access_grant_activation_hold_check
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_memory_access_grant_lifecycle_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Memory access grant rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id || ':' || OLD.grant_kind),
        hashtext(OLD.grant_id)
      );
      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked memory access grants are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.grant_kind, NEW.grant_id,
        NEW.grant_generation, NEW.grantee_kind, NEW.grantee_key,
        NEW.grantee_actor_id, NEW.grantee_execution_principal_id,
        NEW.grantee_execution_principal_generation, NEW.purpose_id,
        NEW.target_visibility, NEW.owner_actor_id, NEW.owner_agent_id,
        NEW.owner_agent_principal_generation, NEW.workspace_id,
        NEW.project_id, NEW.mission_id, NEW.resource_ids, NEW.operation_ids,
        NEW.max_items, NEW.max_bytes, NEW.max_invocations,
        NEW.max_cost_microusd, NEW.max_duration_ms, NEW.not_before,
        NEW.expires_at, NEW.created_by_actor_id, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.grant_kind, OLD.grant_id,
        OLD.grant_generation, OLD.grantee_kind, OLD.grantee_key,
        OLD.grantee_actor_id, OLD.grantee_execution_principal_id,
        OLD.grantee_execution_principal_generation, OLD.purpose_id,
        OLD.target_visibility, OLD.owner_actor_id, OLD.owner_agent_id,
        OLD.owner_agent_principal_generation, OLD.workspace_id,
        OLD.project_id, OLD.mission_id, OLD.resource_ids, OLD.operation_ids,
        OLD.max_items, OLD.max_bytes, OLD.max_invocations,
        OLD.max_cost_microusd, OLD.max_duration_ms, OLD.not_before,
        OLD.expires_at, OLD.created_by_actor_id, OLD.created_at
      ) THEN
        RAISE EXCEPTION 'Memory access grant authority is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Memory access grant transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;
      IF NEW.state = 'active' THEN
        IF statement_timestamp() < OLD.not_before
          OR statement_timestamp() >= OLD.expires_at
          OR NEW.activated_by_actor_id IS DISTINCT FROM OLD.owner_actor_id
          OR NEW.revoked_by_actor_id IS NOT NULL
          OR NEW.revoked_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory access grant activation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.activated_at := transition_at;
      ELSE
        IF NEW.revoked_by_actor_id IS DISTINCT FROM OLD.owner_actor_id THEN
          RAISE EXCEPTION 'Memory access grant revocation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
        IF OLD.activated_at IS NULL THEN
          NEW.activated_by_actor_id := NULL;
          NEW.activated_at := NULL;
        ELSE
          NEW.activated_by_actor_id := OLD.activated_by_actor_id;
          NEW.activated_at := OLD.activated_at;
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_memory_access_grant_mutation_hold
        ON omni_tenant_memory_access_grants;
      DROP TRIGGER IF EXISTS omni_memory_access_grant_lifecycle_protect
        ON omni_tenant_memory_access_grants;
      CREATE TRIGGER omni_memory_access_grant_lifecycle_protect
      BEFORE UPDATE OR DELETE ON omni_tenant_memory_access_grants
      FOR EACH ROW
      EXECUTE FUNCTION omni_protect_memory_access_grant_lifecycle_v1();

      DROP POLICY IF EXISTS omni_memory_access_grant_holdback
        ON omni_tenant_memory_access_grants;
      DROP POLICY IF EXISTS omni_memory_access_grant_actor
        ON omni_tenant_memory_access_grants;
      CREATE POLICY omni_memory_access_grant_actor
      ON omni_tenant_memory_access_grants AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_tenant_memory_access_grants FROM PUBLIC`;
  await sql`
    REVOKE ALL ON FUNCTION omni_protect_memory_access_grant_lifecycle_v1()
    FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_tenant_memory_access_grants FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_tenant_memory_access_grants TO omni_runtime;
        GRANT UPDATE (
          state, lifecycle_revision, activated_by_actor_id, revoked_by_actor_id
        ) ON omni_tenant_memory_access_grants TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_tenant_memory_access_grants FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_tenant_memory_access_grants TO omni_maintenance;
        GRANT UPDATE (
          state, lifecycle_revision, activated_by_actor_id, revoked_by_actor_id
        ) ON omni_tenant_memory_access_grants TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
          AND conname = 'omni_memory_access_grant_activation_hold_check'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_memory_access_grants'::regclass
          AND tgname = 'omni_memory_access_grant_lifecycle_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_tenant_memory_access_grants'::regclass
          AND polname = 'omni_memory_access_grant_actor'
          AND NOT polpermissive AND polcmd = '*'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_access_grants'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Agent memory grant lifecycle boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentReleaseLifecycleV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 112
          AND name = 'agent_memory_grant_lifecycle_v1'
          AND checksum =
            '1f4938099e3912d33c92a483db1563bdb6ad76e90c090d2a85b8b456da61c715'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent release lifecycle predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    LOCK TABLE
      omni_custom_agents,
      omni_agent_definition_versions
    IN SHARE ROW EXCLUSIVE MODE
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_release_evaluations (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      definition_version BIGINT NOT NULL,
      baseline_definition_version BIGINT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      evaluated_by_actor_id TEXT NOT NULL,
      policy_version_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      changed_fields TEXT[] NOT NULL,
      checks JSONB NOT NULL,
      verdict TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL,
      baseline_definition_sha256 TEXT NOT NULL,
      definition_snapshot JSONB NOT NULL,
      evaluation_sha256 TEXT NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, evaluation_id),
      UNIQUE (
        tenant_id, agent_definition_id, definition_version,
        baseline_definition_version
      ),
      CHECK (schema_version = 1),
      CHECK (char_length(evaluation_id) BETWEEN 1 AND 240),
      CHECK (definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (baseline_definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (definition_version <> baseline_definition_version),
      CHECK (policy_version_id = 'agent-release-policy:1'),
      CHECK (
        (direction = 'promotion' AND definition_version > baseline_definition_version)
        OR (direction = 'rollback' AND definition_version < baseline_definition_version)
      ),
      CHECK (
        cardinality(changed_fields) BETWEEN 1 AND 10
        AND changed_fields <@ ARRAY[
          'slug', 'name', 'role', 'description', 'instructions', 'persona',
          'status', 'accent', 'model_policy', 'skills'
        ]::TEXT[]
      ),
      CHECK (
        checks = '{
          "exactOwnerBinding": true,
          "versionTransition": true,
          "immutableDefinitionDigest": true,
          "personaContract": true,
          "skillPins": true,
          "authorityExcluded": true,
          "materialChange": true
        }'::JSONB
      ),
      CHECK (verdict = 'passed'),
      CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (baseline_definition_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (evaluation_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (jsonb_typeof(definition_snapshot) = 'object'),
      FOREIGN KEY (tenant_id, agent_definition_id, definition_version)
        REFERENCES omni_agent_definition_versions (
          tenant_id, agent_definition_id, definition_version
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (
        tenant_id, agent_definition_id, baseline_definition_version
      ) REFERENCES omni_agent_definition_versions (
        tenant_id, agent_definition_id, definition_version
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (evaluated_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_release_evaluations_owner_idx
    ON omni_agent_release_evaluations (
      tenant_id, owner_actor_id, agent_definition_id,
      definition_version DESC, evaluated_at DESC
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_release_channels (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      release_revision BIGINT NOT NULL DEFAULT 1,
      active_definition_version BIGINT NOT NULL,
      previous_definition_version BIGINT,
      last_evaluation_id TEXT,
      updated_by_actor_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, agent_definition_id),
      CHECK (schema_version = 1),
      CHECK (state IN ('active', 'retired')),
      CHECK (release_revision BETWEEN 1 AND 9007199254740991),
      CHECK (active_definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (
        previous_definition_version IS NULL
        OR previous_definition_version BETWEEN 1 AND 9007199254740991
      ),
      CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
      FOREIGN KEY (
        tenant_id, agent_definition_id, active_definition_version
      ) REFERENCES omni_agent_definition_versions (
        tenant_id, agent_definition_id, definition_version
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (
        tenant_id, agent_definition_id, previous_definition_version
      ) REFERENCES omni_agent_definition_versions (
        tenant_id, agent_definition_id, definition_version
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, last_evaluation_id)
        REFERENCES omni_agent_release_evaluations (tenant_id, evaluation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (updated_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_release_channels_owner_idx
    ON omni_agent_release_channels (
      tenant_id, owner_actor_id, state, updated_at DESC
    )
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_agent_release_evaluation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Agent release evaluations are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_agent_release_evaluation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id), hashtext(NEW.agent_definition_id)
      );
      IF NEW.evaluated_by_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR cardinality(NEW.changed_fields) IS DISTINCT FROM (
          SELECT count(DISTINCT field)::INTEGER
          FROM unnest(NEW.changed_fields) field
        )
        OR NOT EXISTS (
          SELECT 1
          FROM public.omni_agent_definition_versions definition
          WHERE definition.tenant_id = NEW.tenant_id
            AND definition.agent_definition_id = NEW.agent_definition_id
            AND definition.definition_version = NEW.definition_version
            AND definition.owner_actor_id = NEW.owner_actor_id
        ) OR NOT EXISTS (
          SELECT 1
          FROM public.omni_agent_definition_versions baseline
          WHERE baseline.tenant_id = NEW.tenant_id
            AND baseline.agent_definition_id = NEW.agent_definition_id
            AND baseline.definition_version = NEW.baseline_definition_version
            AND baseline.owner_actor_id = NEW.owner_actor_id
        ) OR NOT EXISTS (
          SELECT 1
          FROM public.omni_agent_release_channels channel
          WHERE channel.tenant_id = NEW.tenant_id
            AND channel.agent_definition_id = NEW.agent_definition_id
            AND channel.owner_actor_id = NEW.owner_actor_id
            AND channel.state = 'active'
            AND channel.active_definition_version =
              NEW.baseline_definition_version
        )
      THEN
        RAISE EXCEPTION 'Agent release evaluation binding is invalid'
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_agent_release_channel_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Agent release channels cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id), hashtext(NEW.agent_definition_id)
      );
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'active'
          OR NEW.release_revision <> 1
          OR NEW.previous_definition_version IS NOT NULL
          OR NEW.last_evaluation_id IS NOT NULL
          OR NEW.retired_at IS NOT NULL
          OR NEW.updated_by_actor_id IS DISTINCT FROM NEW.owner_actor_id
          OR NOT EXISTS (
            SELECT 1
            FROM public.omni_agent_definition_versions definition
            WHERE definition.tenant_id = NEW.tenant_id
              AND definition.agent_definition_id = NEW.agent_definition_id
              AND definition.definition_version =
                NEW.active_definition_version
              AND definition.owner_actor_id = NEW.owner_actor_id
          )
        THEN
          RAISE EXCEPTION 'Initial Agent release channel is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.state = 'retired'
        OR ROW(NEW.schema_version, NEW.tenant_id, NEW.agent_definition_id,
          NEW.owner_actor_id) IS DISTINCT FROM
          ROW(OLD.schema_version, OLD.tenant_id, OLD.agent_definition_id,
          OLD.owner_actor_id)
        OR NEW.release_revision IS DISTINCT FROM OLD.release_revision + 1
        OR NEW.updated_by_actor_id IS DISTINCT FROM OLD.owner_actor_id
      THEN
        RAISE EXCEPTION 'Agent release channel transition is invalid'
          USING ERRCODE = '23514';
      END IF;
      transition_at := GREATEST(
        statement_timestamp(), OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;
      IF NEW.state = 'retired' THEN
        IF NEW.active_definition_version IS DISTINCT FROM
            OLD.active_definition_version
          OR NEW.previous_definition_version IS DISTINCT FROM
            OLD.previous_definition_version
          OR NEW.last_evaluation_id IS DISTINCT FROM OLD.last_evaluation_id
        THEN
          RAISE EXCEPTION 'Agent retirement cannot rebind a release'
            USING ERRCODE = '23514';
        END IF;
        NEW.retired_at := transition_at;
        RETURN NEW;
      END IF;
      IF NEW.state <> 'active'
        OR NEW.active_definition_version = OLD.active_definition_version
        OR NEW.previous_definition_version IS DISTINCT FROM
          OLD.active_definition_version
        OR NEW.last_evaluation_id IS NULL
        OR NEW.retired_at IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.omni_agent_release_evaluations evaluation
          WHERE evaluation.tenant_id = NEW.tenant_id
            AND evaluation.evaluation_id = NEW.last_evaluation_id
            AND evaluation.agent_definition_id = NEW.agent_definition_id
            AND evaluation.owner_actor_id = NEW.owner_actor_id
            AND evaluation.definition_version =
              NEW.active_definition_version
            AND evaluation.baseline_definition_version =
              OLD.active_definition_version
            AND evaluation.verdict = 'passed'
        )
      THEN
        RAISE EXCEPTION 'Agent release promotion requires an exact evaluation'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_agent_release_evaluation_validate
        ON omni_agent_release_evaluations;
      CREATE TRIGGER omni_agent_release_evaluation_validate
      BEFORE INSERT ON omni_agent_release_evaluations
      FOR EACH ROW
      EXECUTE FUNCTION omni_validate_agent_release_evaluation_v1();
      DROP TRIGGER IF EXISTS omni_agent_release_evaluation_protect
        ON omni_agent_release_evaluations;
      CREATE TRIGGER omni_agent_release_evaluation_protect
      BEFORE UPDATE OR DELETE ON omni_agent_release_evaluations
      FOR EACH ROW
      EXECUTE FUNCTION omni_protect_agent_release_evaluation_v1();
      DROP TRIGGER IF EXISTS omni_agent_release_evaluation_no_truncate
        ON omni_agent_release_evaluations;
      CREATE TRIGGER omni_agent_release_evaluation_no_truncate
      BEFORE TRUNCATE ON omni_agent_release_evaluations
      FOR EACH STATEMENT
      EXECUTE FUNCTION omni_protect_agent_release_evaluation_v1();
      DROP TRIGGER IF EXISTS omni_agent_release_channel_protect
        ON omni_agent_release_channels;
      CREATE TRIGGER omni_agent_release_channel_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_agent_release_channels
      FOR EACH ROW
      EXECUTE FUNCTION omni_protect_agent_release_channel_v1();
      DROP TRIGGER IF EXISTS omni_agent_release_channel_no_truncate
        ON omni_agent_release_channels;
      CREATE TRIGGER omni_agent_release_channel_no_truncate
      BEFORE TRUNCATE ON omni_agent_release_channels
      FOR EACH STATEMENT
      EXECUTE FUNCTION omni_protect_agent_release_evaluation_v1();
    END
    $migration$
  `;
  await sql`
    INSERT INTO omni_agent_release_channels (
      tenant_id, agent_definition_id, owner_actor_id,
      active_definition_version, updated_by_actor_id, updated_at
    )
    SELECT
      definition.tenant_id,
      definition.agent_definition_id,
      definition.owner_actor_id,
      definition.definition_version,
      definition.owner_actor_id,
      definition.published_at
    FROM omni_agent_definition_versions definition
    WHERE definition.definition_version = (
      SELECT MAX(candidate.definition_version)
      FROM omni_agent_definition_versions candidate
      WHERE candidate.tenant_id = definition.tenant_id
        AND candidate.agent_definition_id = definition.agent_definition_id
    )
    ON CONFLICT (tenant_id, agent_definition_id) DO NOTHING
  `;
  await sql`
    DO $migration$
    BEGIN
      ALTER TABLE omni_agent_release_channels ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_release_channels FORCE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_release_evaluations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_release_evaluations FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS omni_agent_release_channels_actor
        ON omni_agent_release_channels;
      CREATE POLICY omni_agent_release_channels_actor
      ON omni_agent_release_channels AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      DROP POLICY IF EXISTS omni_agent_release_evaluations_actor
        ON omni_agent_release_evaluations;
      CREATE POLICY omni_agent_release_evaluations_actor
      ON omni_agent_release_evaluations AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_agent_release_channels FROM PUBLIC`;
  await sql`REVOKE ALL ON TABLE omni_agent_release_evaluations FROM PUBLIC`;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_agent_release_evaluation_v1()
    FROM PUBLIC
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_protect_agent_release_evaluation_v1()
    FROM PUBLIC
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_protect_agent_release_channel_v1()
    FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_release_channels FROM omni_runtime';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_release_evaluations FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_agent_release_channels TO omni_runtime;
        GRANT UPDATE (
          state, release_revision, active_definition_version,
          previous_definition_version, last_evaluation_id,
          updated_by_actor_id, updated_at, retired_at
        ) ON omni_agent_release_channels TO omni_runtime;
        GRANT SELECT, INSERT ON omni_agent_release_evaluations TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_release_channels FROM omni_maintenance';
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_release_evaluations FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_agent_release_channels TO omni_maintenance;
        GRANT UPDATE (
          state, release_revision, active_definition_version,
          previous_definition_version, last_evaluation_id,
          updated_by_actor_id, updated_at, retired_at
        ) ON omni_agent_release_channels TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_agent_release_evaluations TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_agent_release_channels'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_agent_release_evaluations'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_release_channels'::regclass
          AND tgname = 'omni_agent_release_channel_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_release_evaluations'::regclass
          AND tgname = 'omni_agent_release_evaluation_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_agent_release_channels',
            'omni_agent_release_evaluations'
          )
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Agent release lifecycle boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentReleaseEnrollmentV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 113
          AND name = 'agent_release_lifecycle_v1'
          AND checksum =
            '9cbb9af27c5978f1fdd9af6ef12da8c9f9282251d162d879d5b323d657b1b6ff'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent release enrollment predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_enroll_initial_agent_release_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NEW.definition_version <> 1 THEN
        RETURN NEW;
      END IF;
      INSERT INTO public.omni_agent_release_channels (
        tenant_id, agent_definition_id, owner_actor_id,
        active_definition_version, updated_by_actor_id, updated_at
      ) VALUES (
        NEW.tenant_id, NEW.agent_definition_id, NEW.owner_actor_id,
        NEW.definition_version, NEW.owner_actor_id, NEW.published_at
      )
      ON CONFLICT (tenant_id, agent_definition_id) DO NOTHING;
      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_agent_release_channels channel
        WHERE channel.tenant_id = NEW.tenant_id
          AND channel.agent_definition_id = NEW.agent_definition_id
          AND channel.owner_actor_id = NEW.owner_actor_id
          AND channel.state = 'active'
          AND channel.release_revision = 1
          AND channel.active_definition_version = 1
          AND channel.previous_definition_version IS NULL
          AND channel.last_evaluation_id IS NULL
          AND channel.retired_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Initial Agent release enrollment is inconsistent'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_agent_definition_release_enroll
    ON omni_agent_definition_versions
  `;
  await sql`
    CREATE TRIGGER omni_agent_definition_release_enroll
    AFTER INSERT ON omni_agent_definition_versions
    FOR EACH ROW
    EXECUTE FUNCTION omni_enroll_initial_agent_release_v1()
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_enroll_initial_agent_release_v1()
    FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_agent_definition_versions'::regclass
          AND tgname = 'omni_agent_definition_release_enroll'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR EXISTS (
        SELECT 1
        FROM omni_agent_definition_versions definition
        LEFT JOIN omni_agent_release_channels channel
          ON channel.tenant_id = definition.tenant_id
          AND channel.agent_definition_id = definition.agent_definition_id
        WHERE definition.definition_version = 1
          AND channel.agent_definition_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Agent release enrollment boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentAdaptationLifecycleV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 114
          AND name = 'agent_release_enrollment_v1'
          AND checksum =
            '368ef844bec7d397e8bf8fe50c743aecd9e383b22f5451132e2feff528516f43'
      ) <> 1 THEN
        RAISE EXCEPTION 'Agent adaptation lifecycle predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_adaptations (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      adaptation_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      owner_binding_sha256 TEXT NOT NULL,
      observed_definition_version BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'observed',
      lifecycle_revision SMALLINT NOT NULL DEFAULT 0,
      evidence JSONB NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      effect_kind TEXT NOT NULL,
      effect_payload JSONB NOT NULL,
      evaluation JSONB,
      evaluation_sha256 TEXT,
      evaluated_definition_version BIGINT,
      activation_version BIGINT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      evaluated_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      rolled_back_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, adaptation_id),
      UNIQUE (
        tenant_id, owner_actor_id, agent_definition_id,
        observed_definition_version, effect_kind, evidence_sha256
      ),
      UNIQUE (
        tenant_id, owner_actor_id, agent_definition_id, activation_version
      ),
      CHECK (schema_version = 1),
      CHECK (char_length(adaptation_id) BETWEEN 1 AND 240),
      CHECK (char_length(agent_definition_id) BETWEEN 1 AND 240),
      CHECK (owner_binding_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (
        observed_definition_version BETWEEN 1 AND 9007199254740991
      ),
      CHECK (state IN ('observed', 'evaluated', 'active', 'rolled_back')),
      CHECK (lifecycle_revision BETWEEN 0 AND 3),
      CHECK (
        jsonb_typeof(evidence) = 'array'
        AND jsonb_array_length(evidence) BETWEEN 1 AND 10
      ),
      CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (confidence BETWEEN 0 AND 1),
      CHECK (effect_kind = 'instruction_guidance'),
      CHECK (
        jsonb_typeof(effect_payload) = 'object'
        AND effect_payload ?& ARRAY[
          'kind', 'guidance', 'guidanceSha256',
          'authorityImpact', 'effectSha256'
        ]
        AND COALESCE(effect_payload->>'kind' = effect_kind, FALSE)
        AND COALESCE(
          char_length(effect_payload->>'guidance') BETWEEN 3 AND 1000,
          FALSE
        )
        AND COALESCE(
          effect_payload->>'guidanceSha256' ~ '^[a-f0-9]{64}$', FALSE
        )
        AND COALESCE(
          effect_payload->>'authorityImpact' = 'none', FALSE
        )
        AND COALESCE(
          effect_payload->>'effectSha256' ~ '^[a-f0-9]{64}$', FALSE
        )
      ),
      CHECK (evaluation IS NULL OR jsonb_typeof(evaluation) = 'object'),
      CHECK (
        evaluation_sha256 IS NULL
        OR evaluation_sha256 ~ '^[a-f0-9]{64}$'
      ),
      CHECK (
        evaluated_definition_version IS NULL
        OR evaluated_definition_version BETWEEN 1 AND 9007199254740991
      ),
      CHECK (
        activation_version IS NULL
        OR activation_version BETWEEN 1 AND 9007199254740991
      ),
      CHECK (
        (state = 'observed' AND lifecycle_revision = 0
          AND evaluation IS NULL AND evaluation_sha256 IS NULL
          AND evaluated_definition_version IS NULL
          AND activation_version IS NULL AND evaluated_at IS NULL
          AND activated_at IS NULL AND rolled_back_at IS NULL)
        OR (state = 'evaluated' AND lifecycle_revision = 1
          AND evaluation IS NOT NULL AND evaluation_sha256 IS NOT NULL
          AND evaluated_definition_version IS NOT NULL
          AND activation_version IS NULL AND evaluated_at IS NOT NULL
          AND activated_at IS NULL AND rolled_back_at IS NULL)
        OR (state = 'active' AND lifecycle_revision = 2
          AND evaluation IS NOT NULL AND evaluation_sha256 IS NOT NULL
          AND evaluated_definition_version IS NOT NULL
          AND activation_version IS NOT NULL AND evaluated_at IS NOT NULL
          AND activated_at IS NOT NULL AND rolled_back_at IS NULL)
        OR (state = 'rolled_back' AND lifecycle_revision = 3
          AND evaluation IS NOT NULL AND evaluation_sha256 IS NOT NULL
          AND evaluated_definition_version IS NOT NULL
          AND activation_version IS NOT NULL AND evaluated_at IS NOT NULL
          AND activated_at IS NOT NULL AND rolled_back_at IS NOT NULL)
      ),
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_adaptations_owner_idx
    ON omni_agent_adaptations (
      tenant_id, owner_actor_id, agent_definition_id,
      state, updated_at DESC
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_agent_adaptations_active_effect_idx
    ON omni_agent_adaptations (
      tenant_id, owner_actor_id, agent_definition_id, effect_kind
    )
    WHERE state = 'active'
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_agent_adaptation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Agent adaptations cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.owner_actor_id || ':' || NEW.agent_definition_id)
      );
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'observed'
          OR NEW.lifecycle_revision <> 0
          OR NEW.evaluation IS NOT NULL
          OR NEW.evaluation_sha256 IS NOT NULL
          OR NEW.evaluated_definition_version IS NOT NULL
          OR NEW.activation_version IS NOT NULL
          OR NEW.evaluated_at IS NOT NULL
          OR NEW.activated_at IS NOT NULL
          OR NEW.rolled_back_at IS NOT NULL
          OR NEW.updated_at IS DISTINCT FROM NEW.created_at
        THEN
          RAISE EXCEPTION 'Initial Agent adaptation is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.adaptation_id,
        NEW.agent_definition_id, NEW.owner_actor_id,
        NEW.owner_binding_sha256, NEW.observed_definition_version,
        NEW.evidence, NEW.evidence_sha256,
        NEW.confidence, NEW.effect_kind, NEW.effect_payload, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.adaptation_id,
        OLD.agent_definition_id, OLD.owner_actor_id,
        OLD.owner_binding_sha256, OLD.observed_definition_version,
        OLD.evidence, OLD.evidence_sha256,
        OLD.confidence, OLD.effect_kind, OLD.effect_payload, OLD.created_at
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Agent adaptation identity is immutable'
          USING ERRCODE = '23514';
      END IF;
      transition_at := GREATEST(
        statement_timestamp(), OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;
      IF OLD.state = 'observed' AND NEW.state = 'evaluated' THEN
        IF NEW.evaluation IS NULL
          OR NEW.evaluation_sha256 IS NULL
          OR NEW.evaluated_definition_version IS NULL
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            NEW.observed_definition_version
          OR NEW.evaluation->>'version' IS DISTINCT FROM
            'p7.6-agent-adaptation-evaluation:1'
          OR NEW.evaluation->>'policyVersionId' IS DISTINCT FROM
            'agent-adaptation-policy:1'
          OR (NEW.evaluation->>'definitionVersion')::BIGINT IS DISTINCT FROM
            NEW.observed_definition_version
          OR (
            NEW.evaluation->>'verdict' IS DISTINCT FROM 'passed'
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'held'
          )
          OR (
            NEW.confidence >= 0.75
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'passed'
          )
          OR (
            NEW.confidence < 0.75
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'held'
          )
          OR NEW.activation_version IS NOT NULL
          OR NEW.activated_at IS NOT NULL
          OR NEW.rolled_back_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Agent adaptation evaluation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.evaluated_at := transition_at;
        RETURN NEW;
      END IF;
      IF OLD.state = 'evaluated' AND NEW.state = 'active' THEN
        IF NEW.evaluation IS DISTINCT FROM OLD.evaluation
          OR NEW.evaluation_sha256 IS DISTINCT FROM OLD.evaluation_sha256
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            OLD.evaluated_definition_version
          OR OLD.evaluation->>'verdict' <> 'passed'
          OR NEW.activation_version IS NULL
          OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
          OR NEW.rolled_back_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Agent adaptation activation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.activated_at := transition_at;
        RETURN NEW;
      END IF;
      IF OLD.state = 'active' AND NEW.state = 'rolled_back' THEN
        IF NEW.evaluation IS DISTINCT FROM OLD.evaluation
          OR NEW.evaluation_sha256 IS DISTINCT FROM OLD.evaluation_sha256
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            OLD.evaluated_definition_version
          OR NEW.activation_version IS DISTINCT FROM OLD.activation_version
          OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
          OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
        THEN
          RAISE EXCEPTION 'Agent adaptation rollback is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.rolled_back_at := transition_at;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Agent adaptation transition is invalid'
        USING ERRCODE = '23514';
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_agent_adaptation_protect
        ON omni_agent_adaptations;
      CREATE TRIGGER omni_agent_adaptation_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_agent_adaptations
      FOR EACH ROW
      EXECUTE FUNCTION omni_protect_agent_adaptation_v1();
      DROP TRIGGER IF EXISTS omni_agent_adaptation_no_truncate
        ON omni_agent_adaptations;
      CREATE TRIGGER omni_agent_adaptation_no_truncate
      BEFORE TRUNCATE ON omni_agent_adaptations
      FOR EACH STATEMENT
      EXECUTE FUNCTION omni_protect_agent_adaptation_v1();
      ALTER TABLE omni_agent_adaptations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_agent_adaptations FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS omni_agent_adaptations_actor
        ON omni_agent_adaptations;
      CREATE POLICY omni_agent_adaptations_actor
      ON omni_agent_adaptations AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_agent_adaptations FROM PUBLIC`;
  await sql`
    REVOKE ALL ON FUNCTION omni_protect_agent_adaptation_v1()
    FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_adaptations FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_agent_adaptations TO omni_runtime;
        GRANT UPDATE (
          state, lifecycle_revision, evaluation, evaluation_sha256,
          evaluated_definition_version, activation_version, updated_at,
          evaluated_at, activated_at, rolled_back_at
        ) ON omni_agent_adaptations TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_agent_adaptations FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_agent_adaptations TO omni_maintenance;
        GRANT UPDATE (
          state, lifecycle_revision, evaluation, evaluation_sha256,
          evaluated_definition_version, activation_version, updated_at,
          evaluated_at, activated_at, rolled_back_at
        ) ON omni_agent_adaptations TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_agent_adaptations'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_adaptations'::regclass
          AND tgname = 'omni_agent_adaptation_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_agent_adaptations'::regclass
          AND tgname = 'omni_agent_adaptation_no_truncate'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = 'omni_protect_agent_adaptation_v1()'::regprocedure
          AND NOT prosecdef
      ) OR EXISTS (
        SELECT 1
        FROM pg_proc function_row
        CROSS JOIN LATERAL aclexplode(COALESCE(
          function_row.proacl,
          acldefault('f', function_row.proowner)
        )) function_acl
        WHERE function_row.oid =
          'omni_protect_agent_adaptation_v1()'::regprocedure
          AND function_acl.grantee = 0
          AND function_acl.privilege_type = 'EXECUTE'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_agent_adaptations'::regclass
          AND polname = 'omni_agent_adaptations_actor'
          AND NOT polpermissive AND polcmd = '*'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_index
        WHERE indexrelid = 'omni_agent_adaptations_active_effect_idx'::regclass
          AND indisvalid AND indisunique
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_agent_adaptations'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_column_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_agent_adaptations'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type = 'UPDATE'
          AND column_name NOT IN (
            'state', 'lifecycle_revision', 'evaluation',
            'evaluation_sha256', 'evaluated_definition_version',
            'activation_version', 'updated_at', 'evaluated_at',
            'activated_at', 'rolled_back_at'
          )
      ) THEN
        RAISE EXCEPTION 'Agent adaptation lifecycle boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureCustomAgentSkillReferenceIntegrity(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  // Freeze both sides of the reference graph before the audit. The locks are
  // transaction-held, so no writer can create a gap between preflight and the
  // trigger installation below.
  await sql`
    LOCK TABLE omni_custom_agents, omni_custom_skills
    IN SHARE ROW EXCLUSIVE MODE
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid IN (
            'omni_custom_agents'::regclass,
            'omni_custom_skills'::regclass
          )
          AND NOT trigger_record.tgisinternal
      ) THEN
        RAISE EXCEPTION 'Unexpected custom Agent or Skill triggers exist before integrity installation'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_skills custom_skill
        WHERE custom_skill.id IS NULL
          OR custom_skill.id IS DISTINCT FROM btrim(custom_skill.id)
          OR char_length(custom_skill.id) NOT BETWEEN 1 AND 120
          OR custom_skill.id COLLATE "C" IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
      ) THEN
        RAISE EXCEPTION 'Existing custom Skill identifiers are malformed or reserved'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        WHERE agent.skill_ids IS NULL
          OR cardinality(agent.skill_ids) > 30
      ) THEN
        RAISE EXCEPTION 'Existing custom Agent Skill reference arrays are null or oversized'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        CROSS JOIN LATERAL unnest(agent.skill_ids) referenced(skill_id)
        WHERE referenced.skill_id IS NULL
          OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
          OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
      ) THEN
        RAISE EXCEPTION 'Existing custom Agent Skill reference identifiers are malformed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        CROSS JOIN LATERAL unnest(agent.skill_ids) referenced(skill_id)
        GROUP BY agent.id, referenced.skill_id COLLATE "C"
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Existing custom Agent Skill reference arrays contain duplicates'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        CROSS JOIN LATERAL unnest(agent.skill_ids) referenced(skill_id)
        WHERE referenced.skill_id COLLATE "C" NOT IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM omni_custom_skills custom_skill
            WHERE custom_skill.id COLLATE "C" =
                referenced.skill_id COLLATE "C"
              AND custom_skill.tenant_id COLLATE "C" =
                agent.tenant_id COLLATE "C"
              AND custom_skill.actor_id COLLATE "C" =
                agent.actor_id COLLATE "C"
          )
      ) THEN
        RAISE EXCEPTION 'Existing custom Agent Skill references do not resolve to their exact owner'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_custom_agent_skill_references()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      referenced_skill_id TEXT;
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_agents'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Agent Skill validator has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.skill_ids IS NULL
        OR cardinality(NEW.skill_ids) > 30
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
      THEN
        RAISE EXCEPTION 'Custom agent skill references are invalid'
          USING ERRCODE = '23514',
            SCHEMA = 'public',
            TABLE = 'omni_custom_agents',
            COLUMN = 'skill_ids',
            CONSTRAINT = 'omni_custom_agents_skill_references_valid';
      END IF;

      FOR referenced_skill_id IN
        SELECT referenced.skill_id COLLATE "C"
        FROM unnest(NEW.skill_ids) referenced(skill_id)
        WHERE referenced.skill_id COLLATE "C" NOT IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
        GROUP BY referenced.skill_id COLLATE "C"
        ORDER BY referenced.skill_id COLLATE "C"
      LOOP
        PERFORM 1
        FROM public.omni_custom_skills custom_skill
        WHERE custom_skill.id COLLATE "C" =
            referenced_skill_id COLLATE "C"
          AND custom_skill.tenant_id COLLATE "C" =
            NEW.tenant_id COLLATE "C"
          AND custom_skill.actor_id COLLATE "C" =
            NEW.actor_id COLLATE "C"
        FOR KEY SHARE OF custom_skill;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Custom agent skill references are invalid'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_agents',
              COLUMN = 'skill_ids',
              CONSTRAINT = 'omni_custom_agents_skill_references_valid';
        END IF;
      END LOOP;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_custom_skill_reference_identity()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill reference guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.id IS NULL
          OR NEW.id IS DISTINCT FROM btrim(NEW.id)
          OR char_length(NEW.id) NOT BETWEEN 1 AND 120
          OR NEW.id COLLATE "C" IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
        THEN
          RAISE EXCEPTION 'Custom skill identifier is invalid or reserved'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              COLUMN = 'id',
              CONSTRAINT = 'omni_custom_skills_id_valid';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id COLLATE "C" IS DISTINCT FROM OLD.id COLLATE "C"
          OR NEW.tenant_id COLLATE "C" IS DISTINCT FROM
            OLD.tenant_id COLLATE "C"
          OR NEW.actor_id COLLATE "C" IS DISTINCT FROM
            OLD.actor_id COLLATE "C"
        THEN
          RAISE EXCEPTION 'Custom skill reference identity is immutable'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              CONSTRAINT = 'omni_custom_skills_reference_identity_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF current_setting('transaction_isolation') IS DISTINCT FROM
          'read committed'
      THEN
        RAISE EXCEPTION 'Custom skill deletion requires read committed isolation'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_custom_agents agent
        WHERE agent.tenant_id COLLATE "C" = OLD.tenant_id COLLATE "C"
          AND agent.actor_id COLLATE "C" = OLD.actor_id COLLATE "C"
          AND EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id COLLATE "C" = OLD.id COLLATE "C"
          )
      ) THEN
        RAISE EXCEPTION 'Custom skill is still referenced by an agent'
          USING ERRCODE = '23503',
            SCHEMA = 'public',
            TABLE = 'omni_custom_skills',
            CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
      END IF;

      RETURN OLD;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_custom_skills_truncate()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'STATEMENT'
        OR TG_OP IS DISTINCT FROM 'TRUNCATE'
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill truncate guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      RAISE EXCEPTION 'Custom skills cannot be truncated while Agent references are durable'
        USING ERRCODE = '23503',
          SCHEMA = 'public',
          TABLE = 'omni_custom_skills',
          CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_custom_agents'::regclass
          AND tgname = 'omni_custom_agents_validate_skill_references'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_custom_agents_validate_skill_references
        BEFORE INSERT OR UPDATE OF tenant_id, actor_id, skill_ids
        ON omni_custom_agents
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_custom_agent_skill_references();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_custom_skills'::regclass
          AND tgname = 'omni_custom_skills_protect_reference_identity'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_custom_skills_protect_reference_identity
        BEFORE INSERT OR UPDATE OF id, tenant_id, actor_id OR DELETE
        ON omni_custom_skills
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_custom_skill_reference_identity();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_custom_skills'::regclass
          AND tgname = 'omni_custom_skills_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_custom_skills_no_truncate
        BEFORE TRUNCATE ON omni_custom_skills
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_custom_skills_truncate();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_custom_agent_skill_references()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_custom_skill_reference_identity()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_custom_skills_truncate()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE TRIGGER
    ON TABLE omni_custom_agents
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE TRIGGER, TRUNCATE
    ON TABLE omni_custom_skills
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_validate_custom_agent_skill_references',
            'omni_protect_custom_skill_reference_identity',
            'omni_reject_custom_skills_truncate'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_custom_agent_skill_references() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_custom_skill_reference_identity() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_custom_skills_truncate() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND (
            (
              table_name = 'omni_custom_agents'
              AND privilege_type = 'TRIGGER'
            ) OR (
              table_name = 'omni_custom_skills'
              AND privilege_type IN ('TRIGGER', 'TRUNCATE')
            )
          )
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE TRIGGER ON TABLE %I.omni_custom_agents FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE TRIGGER, TRUNCATE ON TABLE %I.omni_custom_skills FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_custom_skills custom_skill
        WHERE custom_skill.id IS NULL
          OR custom_skill.id IS DISTINCT FROM btrim(custom_skill.id)
          OR char_length(custom_skill.id) NOT BETWEEN 1 AND 120
          OR custom_skill.id COLLATE "C" IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
      ) THEN
        RAISE EXCEPTION 'Custom Skill identifier integrity changed during migration'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_custom_agents agent
        WHERE agent.skill_ids IS NULL
          OR cardinality(agent.skill_ids) > 30
          OR EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id IS NULL
              OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
              OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
          )
          OR EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            GROUP BY referenced.skill_id COLLATE "C"
            HAVING count(*) > 1
          )
          OR EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id COLLATE "C" NOT IN (
                'core.research',
                'core.builder',
                'core.critic',
                'core.memory'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM omni_custom_skills custom_skill
                WHERE custom_skill.id COLLATE "C" =
                    referenced.skill_id COLLATE "C"
                  AND custom_skill.tenant_id COLLATE "C" =
                    agent.tenant_id COLLATE "C"
                  AND custom_skill.actor_id COLLATE "C" =
                    agent.actor_id COLLATE "C"
              )
          )
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference integrity changed during migration'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_proc procedure
        JOIN pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure.proname IN (
            'omni_validate_custom_agent_skill_references',
            'omni_protect_custom_skill_reference_identity',
            'omni_reject_custom_skills_truncate'
          )
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure.proname IN (
            'omni_validate_custom_agent_skill_references',
            'omni_protect_custom_skill_reference_identity',
            'omni_reject_custom_skills_truncate'
          )
          AND procedure.oid NOT IN (
            to_regprocedure(
              'public.omni_validate_custom_agent_skill_references()'
            ),
            to_regprocedure(
              'public.omni_protect_custom_skill_reference_identity()'
            ),
            to_regprocedure(
              'public.omni_reject_custom_skills_truncate()'
            )
          )
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference functions are overloaded'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_custom_agents'::regclass
          AND trigger_record.tgname =
            'omni_custom_agents_validate_skill_references'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_validate_custom_agent_skill_references()'
          )
          AND trigger_record.tgtype = 23
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = (
            SELECT string_agg(attribute.attnum::TEXT, ' ' ORDER BY attribute.attnum)
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'omni_custom_agents'::regclass
              AND attribute.attname IN ('tenant_id', 'actor_id', 'skill_ids')
              AND NOT attribute.attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_custom_skills'::regclass
          AND trigger_record.tgname =
            'omni_custom_skills_protect_reference_identity'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_custom_skill_reference_identity()'
          )
          AND trigger_record.tgtype = 31
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = (
            SELECT string_agg(attribute.attnum::TEXT, ' ' ORDER BY attribute.attnum)
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'omni_custom_skills'::regclass
              AND attribute.attname IN ('id', 'tenant_id', 'actor_id')
              AND NOT attribute.attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_custom_skills'::regclass
          AND trigger_record.tgname = 'omni_custom_skills_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_custom_skills_truncate()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = ''
      ) OR (
        SELECT count(*)
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid IN (
            'omni_custom_agents'::regclass,
            'omni_custom_skills'::regclass
          )
          AND NOT trigger_record.tgisinternal
      ) <> 3
      THEN
        RAISE EXCEPTION 'Custom Agent Skill reference triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_validate_custom_agent_skill_references()'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    DECLARE
      referenced_skill_id TEXT;
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_agents'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Agent Skill validator has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.skill_ids IS NULL
        OR cardinality(NEW.skill_ids) > 30
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
      THEN
        RAISE EXCEPTION 'Custom agent skill references are invalid'
          USING ERRCODE = '23514',
            SCHEMA = 'public',
            TABLE = 'omni_custom_agents',
            COLUMN = 'skill_ids',
            CONSTRAINT = 'omni_custom_agents_skill_references_valid';
      END IF;

      FOR referenced_skill_id IN
        SELECT referenced.skill_id COLLATE "C"
        FROM unnest(NEW.skill_ids) referenced(skill_id)
        WHERE referenced.skill_id COLLATE "C" NOT IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
        GROUP BY referenced.skill_id COLLATE "C"
        ORDER BY referenced.skill_id COLLATE "C"
      LOOP
        PERFORM 1
        FROM public.omni_custom_skills custom_skill
        WHERE custom_skill.id COLLATE "C" =
            referenced_skill_id COLLATE "C"
          AND custom_skill.tenant_id COLLATE "C" =
            NEW.tenant_id COLLATE "C"
          AND custom_skill.actor_id COLLATE "C" =
            NEW.actor_id COLLATE "C"
        FOR KEY SHARE OF custom_skill;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Custom agent skill references are invalid'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_agents',
              COLUMN = 'skill_ids',
              CONSTRAINT = 'omni_custom_agents_skill_references_valid';
        END IF;
      END LOOP;

      RETURN NEW;
    END
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_protect_custom_skill_reference_identity()'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill reference guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.id IS NULL
          OR NEW.id IS DISTINCT FROM btrim(NEW.id)
          OR char_length(NEW.id) NOT BETWEEN 1 AND 120
          OR NEW.id COLLATE "C" IN (
            'core.research',
            'core.builder',
            'core.critic',
            'core.memory'
          )
        THEN
          RAISE EXCEPTION 'Custom skill identifier is invalid or reserved'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              COLUMN = 'id',
              CONSTRAINT = 'omni_custom_skills_id_valid';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id COLLATE "C" IS DISTINCT FROM OLD.id COLLATE "C"
          OR NEW.tenant_id COLLATE "C" IS DISTINCT FROM
            OLD.tenant_id COLLATE "C"
          OR NEW.actor_id COLLATE "C" IS DISTINCT FROM
            OLD.actor_id COLLATE "C"
        THEN
          RAISE EXCEPTION 'Custom skill reference identity is immutable'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              CONSTRAINT = 'omni_custom_skills_reference_identity_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF current_setting('transaction_isolation') IS DISTINCT FROM
          'read committed'
      THEN
        RAISE EXCEPTION 'Custom skill deletion requires read committed isolation'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_custom_agents agent
        WHERE agent.tenant_id COLLATE "C" = OLD.tenant_id COLLATE "C"
          AND agent.actor_id COLLATE "C" = OLD.actor_id COLLATE "C"
          AND EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id COLLATE "C" = OLD.id COLLATE "C"
          )
      ) THEN
        RAISE EXCEPTION 'Custom skill is still referenced by an agent'
          USING ERRCODE = '23503',
            SCHEMA = 'public',
            TABLE = 'omni_custom_skills',
            CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
      END IF;

      RETURN OLD;
    END
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_custom_skills_truncate()'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'STATEMENT'
        OR TG_OP IS DISTINCT FROM 'TRUNCATE'
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill truncate guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      RAISE EXCEPTION 'Custom skills cannot be truncated while Agent references are durable'
        USING ERRCODE = '23503',
          SCHEMA = 'public',
          TABLE = 'omni_custom_skills',
          CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (to_regprocedure(
              'public.omni_validate_custom_agent_skill_references()'
            )),
            (to_regprocedure(
              'public.omni_protect_custom_skill_reference_identity()'
            )),
            (to_regprocedure(
              'public.omni_reject_custom_skills_truncate()'
            ))
        ) expected(procedure_oid)
        JOIN pg_proc procedure ON procedure.oid = expected.procedure_oid
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            procedure.proacl,
            acldefault('f', procedure.proowner)
          )
        ) privilege
        WHERE privilege.grantee <> procedure.proowner
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference functions have serving grants'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND (
            (
              table_name = 'omni_custom_agents'
              AND privilege_type = 'TRIGGER'
            ) OR (
              table_name = 'omni_custom_skills'
              AND privilege_type IN ('TRIGGER', 'TRUNCATE')
            )
          )
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference tables retain unsafe serving grants'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_custom_agents'::regclass),
            ('omni_custom_skills'::regclass)
        ) expected(relation_oid)
        JOIN pg_class relation ON relation.oid = expected.relation_oid
        WHERE relation.relowner IS DISTINCT FROM (
          SELECT relowner
          FROM pg_class
          WHERE oid = 'omni_schema_version'::regclass
        )
      ) THEN
        RAISE EXCEPTION 'Custom Agent Skill reference trigger relations have invalid ownership'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
