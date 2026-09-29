import "server-only";

import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for the platform: tenant ownership, safety
// controls, retention, settings, rollouts, usage and the asset object plane.

export async function ensureTenantScopedAssetObjectPlaneV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_asset_objects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      object_version INTEGER NOT NULL,
      storage_provider TEXT NOT NULL,
      storage_locator TEXT NOT NULL,
      storage_etag TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      content_sha256 TEXT NOT NULL,
      byte_count BIGINT NOT NULL,
      media_type TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'user_private',
      sensitivity TEXT NOT NULL DEFAULT 'confidential',
      permission_grant_ids TEXT[] NOT NULL DEFAULT '{}',
      allowed_purpose_ids TEXT[] NOT NULL DEFAULT '{}',
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      extraction_state TEXT NOT NULL,
      upload_job_id TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT,
      execution_scope JSONB NOT NULL,
      ready_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      scrubbed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT omni_asset_objects_source_version_key
        UNIQUE (tenant_id, source_kind, source_id, object_version),
      CONSTRAINT omni_asset_objects_storage_locator_key
        UNIQUE (tenant_id, storage_provider, storage_locator),
      CONSTRAINT omni_asset_objects_identity_check CHECK (
        id ~ '^asset_object_[a-f0-9]{48}$'
        AND length(tenant_id) BETWEEN 1 AND 160
        AND length(owner_actor_id) BETWEEN 1 AND 320
        AND length(source_id) BETWEEN 1 AND 200
        AND object_version >= 1
      ),
      CONSTRAINT omni_asset_objects_source_kind_check CHECK (
        source_kind IN ('capture_asset', 'capture_segment')
      ),
      CONSTRAINT omni_asset_objects_provider_check CHECK (
        storage_provider = 'vercel_blob_private'
      ),
      CONSTRAINT omni_asset_objects_status_check CHECK (
        status IN ('pending', 'ready', 'failed', 'deleted')
      ),
      CONSTRAINT omni_asset_objects_integrity_check CHECK (
        content_sha256 ~ '^[a-f0-9]{64}$'
        AND byte_count > 0
        AND length(media_type) BETWEEN 1 AND 200
        AND storage_locator ~ '^v1/[a-f0-9]{32}/[a-f0-9]{32}/(capture_asset|capture_segment)/[a-f0-9]{48}/v[1-9][0-9]*/[a-f0-9]{64}\\.bin$'
      ),
      CONSTRAINT omni_asset_objects_access_check CHECK (
        visibility = 'user_private'
        AND sensitivity IN ('confidential', 'restricted')
        AND cardinality(permission_grant_ids) >= 1
        AND cardinality(allowed_purpose_ids) >= 1
        AND length(retention_policy_id) BETWEEN 1 AND 120
      ),
      CONSTRAINT omni_asset_objects_extraction_check CHECK (
        extraction_state IN ('pending', 'completed', 'unsupported', 'failed')
      ),
      CONSTRAINT omni_asset_objects_scope_check CHECK (
        jsonb_typeof(execution_scope) = 'object'
        AND execution_scope ->> 'version' = '1'
        AND execution_scope ->> 'tenantId' = tenant_id
        AND execution_scope ->> 'initiatingActorId' = owner_actor_id
        AND COALESCE(execution_scope ->> 'workspaceId', '') = COALESCE(workspace_id, '')
        AND COALESCE(execution_scope ->> 'projectId', '') = COALESCE(project_id, '')
        AND COALESCE(execution_scope ->> 'missionId', '') = COALESCE(mission_id, '')
      ),
      CONSTRAINT omni_asset_objects_lifecycle_check CHECK (
        failure_count >= 0
        AND (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$')
        AND (status <> 'ready' OR (ready_at IS NOT NULL AND deleted_at IS NULL))
        AND (status <> 'deleted' OR deleted_at IS NOT NULL)
        AND (scrubbed_at IS NULL OR status = 'deleted')
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_asset_objects_owner_source_idx
    ON omni_asset_objects (
      tenant_id, owner_actor_id, source_kind, source_id, object_version DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_asset_objects_pending_idx
    ON omni_asset_objects (tenant_id, created_at ASC, id)
    WHERE status IN ('pending', 'failed')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_asset_objects_retention_idx
    ON omni_asset_objects (retention_expires_at, tenant_id, id)
    WHERE status <> 'deleted' AND retention_expires_at IS NOT NULL
  `;
  await sql`
    DROP POLICY IF EXISTS omni_asset_objects_actor_scope
    ON omni_asset_objects
  `;
  await sql`
    CREATE POLICY omni_asset_objects_actor_scope
    ON omni_asset_objects
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON omni_asset_objects TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON omni_asset_objects TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_asset_objects'::regclass
          AND polname = 'omni_asset_objects_actor_scope'
          AND NOT polpermissive
          AND polcmd = '*'
      ) THEN
        RAISE EXCEPTION 'Asset object actor boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAssetObjectBackfillReceiptsV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_asset_object_migrations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      cursor_kind TEXT,
      cursor_id TEXT,
      total_count INTEGER NOT NULL DEFAULT 0,
      ready_count INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      mismatch_count INTEGER NOT NULL DEFAULT 0,
      verification_sha256 TEXT,
      operation_job_id TEXT,
      execution_scope JSONB NOT NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT omni_asset_object_migrations_owner_generation_key
        UNIQUE (tenant_id, owner_actor_id, generation),
      CONSTRAINT omni_asset_object_migrations_identity_check CHECK (
        id ~ '^asset_migration_[a-f0-9]{48}$'
        AND length(tenant_id) BETWEEN 1 AND 160
        AND length(owner_actor_id) BETWEEN 1 AND 320
        AND generation >= 1
      ),
      CONSTRAINT omni_asset_object_migrations_status_check CHECK (
        status IN ('queued', 'running', 'verifying', 'completed', 'failed')
      ),
      CONSTRAINT omni_asset_object_migrations_cursor_check CHECK (
        (cursor_kind IS NULL AND cursor_id IS NULL)
        OR (
          cursor_kind IN ('capture_asset', 'capture_segment')
          AND length(cursor_id) BETWEEN 1 AND 200
        )
      ),
      CONSTRAINT omni_asset_object_migrations_counts_check CHECK (
        total_count >= 0 AND ready_count >= 0 AND pending_count >= 0
        AND failed_count >= 0 AND missing_count >= 0 AND mismatch_count >= 0
        AND ready_count + pending_count + failed_count + missing_count <= total_count
      ),
      CONSTRAINT omni_asset_object_migrations_verification_check CHECK (
        verification_sha256 IS NULL
        OR verification_sha256 ~ '^[a-f0-9]{64}$'
      ),
      CONSTRAINT omni_asset_object_migrations_scope_check CHECK (
        jsonb_typeof(execution_scope) = 'object'
        AND execution_scope ->> 'version' = '1'
        AND execution_scope ->> 'tenantId' = tenant_id
        AND execution_scope ->> 'initiatingActorId' = owner_actor_id
      ),
      CONSTRAINT omni_asset_object_migrations_lifecycle_check CHECK (
        (status = 'queued' OR started_at IS NOT NULL)
        AND (status = 'completed') = (completed_at IS NOT NULL)
        AND (status <> 'completed' OR (
          ready_count = total_count
          AND pending_count = 0
          AND failed_count = 0
          AND missing_count = 0
          AND mismatch_count = 0
          AND verification_sha256 IS NOT NULL
        ))
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_asset_object_migrations_owner_idx
    ON omni_asset_object_migrations (
      tenant_id, owner_actor_id, generation DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_asset_object_migrations_active_idx
    ON omni_asset_object_migrations (tenant_id, status, updated_at, id)
    WHERE status IN ('queued', 'running', 'verifying')
  `;
  await sql`
    DROP POLICY IF EXISTS omni_asset_object_migrations_actor_scope
    ON omni_asset_object_migrations
  `;
  await sql`
    CREATE POLICY omni_asset_object_migrations_actor_scope
    ON omni_asset_object_migrations
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON omni_asset_object_migrations TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON omni_asset_object_migrations TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_asset_object_migrations'::regclass
          AND polname = 'omni_asset_object_migrations_actor_scope'
          AND NOT polpermissive
          AND polcmd = '*'
      ) THEN
        RAISE EXCEPTION 'Asset object migration actor boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureSettingsControlPlane(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_provider_connections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_validation'
        CHECK (status IN ('needs_validation', 'validating', 'connected', 'error', 'disabled', 'revoked')),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
      credential_key_id TEXT NOT NULL,
      credential_fingerprint TEXT,
      configured_fields TEXT[] NOT NULL DEFAULT '{}',
      sealed_credentials JSONB NOT NULL,
      last_validated_at TIMESTAMPTZ,
      validation_code TEXT,
      catalog_refreshed_at TIMESTAMPTZ,
      rotated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, provider)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_provider_connections_tenant_actor_idx ON omni_provider_connections (tenant_id, actor_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_model_catalog (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capabilities TEXT[] NOT NULL DEFAULT '{}',
      lifecycle TEXT NOT NULL DEFAULT 'unknown'
        CHECK (lifecycle IN ('available', 'deprecated', 'retiring', 'unknown')),
      lifecycle_reason TEXT,
      lifecycle_checked_at TIMESTAMPTZ,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, provider, model_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_model_catalog_tenant_actor_provider_idx ON omni_model_catalog (tenant_id, actor_id, provider, lifecycle, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_model_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL
        CHECK (scope IN ('main_agent', 'orchestrator', 'planner', 'verifier', 'council', 'memory', 'embeddings', 'vision', 'audio', 'audio_diarization', 'web_search', 'image_generation', 'video_generation', 'computer_use', 'speech_synthesis', 'realtime_transcription')),
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      model_id TEXT NOT NULL,
      fallback_provider TEXT
        CHECK (fallback_provider IS NULL OR fallback_provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      fallback_model_id TEXT,
      allow_cross_provider_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      runtime_readiness TEXT NOT NULL DEFAULT 'configuration_only'
        CHECK (runtime_readiness IN ('active', 'configuration_only')),
      contract_version TEXT NOT NULL DEFAULT 'legacy'
        CHECK (contract_version IN ('legacy', 'p11.8-model-assignment:1')),
      assignment_revision INTEGER NOT NULL DEFAULT 1
        CHECK (assignment_revision > 0),
      configuration_sha256 TEXT,
      validated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, scope),
      CHECK ((fallback_provider IS NULL) = (fallback_model_id IS NULL)),
      CHECK (
        fallback_provider IS NULL
        OR fallback_provider = provider
        OR allow_cross_provider_fallback
      )
    )
  `;
  await sql`ALTER TABLE omni_model_assignments ADD COLUMN IF NOT EXISTS contract_version TEXT NOT NULL DEFAULT 'legacy'`;
  await sql`ALTER TABLE omni_model_assignments ADD COLUMN IF NOT EXISTS assignment_revision INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE omni_model_assignments ADD COLUMN IF NOT EXISTS configuration_sha256 TEXT`;
  await sql`ALTER TABLE omni_model_assignments ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_model_assignments DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check`;
  await sql`UPDATE omni_model_assignments SET scope = 'planner' WHERE scope = 'workflow'`;
  await sql`ALTER TABLE omni_model_assignments ADD CONSTRAINT omni_model_assignments_scope_check CHECK (scope IN ('main_agent', 'orchestrator', 'planner', 'verifier', 'council', 'memory', 'embeddings', 'vision', 'audio', 'audio_diarization', 'web_search', 'image_generation', 'video_generation', 'computer_use', 'speech_synthesis', 'realtime_transcription'))`;
  await sql`ALTER TABLE omni_model_assignments DROP CONSTRAINT IF EXISTS omni_model_assignments_runtime_readiness_check`;
  await sql`ALTER TABLE omni_model_assignments ADD CONSTRAINT omni_model_assignments_runtime_readiness_check CHECK (runtime_readiness IN ('active', 'configuration_only'))`;
  await sql`CREATE INDEX IF NOT EXISTS omni_model_assignments_tenant_actor_idx ON omni_model_assignments (tenant_id, actor_id, scope)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_service_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      token_last_four TEXT NOT NULL CHECK (char_length(token_last_four) = 4),
      scopes TEXT[] NOT NULL DEFAULT '{}'
        CHECK (scopes <@ ARRAY[
          'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
          'missions:read', 'missions:write', 'memory:read', 'memory:write',
          'runs:read', 'settings:read'
        ]::TEXT[]),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_service_api_keys_tenant_actor_idx ON omni_service_api_keys (tenant_id, actor_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_service_api_keys_expiry_idx ON omni_service_api_keys (expires_at) WHERE status = 'active'`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mcp_export_configurations (
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      server_name TEXT NOT NULL DEFAULT 'Asael',
      allowed_scopes TEXT[] NOT NULL DEFAULT '{mcp:discover,mcp:tools:list}'
        CHECK (allowed_scopes <@ ARRAY[
          'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
          'missions:read', 'missions:write', 'memory:read', 'memory:write',
          'runs:read', 'settings:read'
        ]::TEXT[]),
      default_approval_mode TEXT NOT NULL DEFAULT 'governed'
        CHECK (default_approval_mode = 'governed'),
      expose_resources BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, actor_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_export_configurations_tenant_actor_idx ON omni_mcp_export_configurations (tenant_id, actor_id)`;
}

export async function ensureAsaelCanonicalIdentity(sql: SqlClient) {
  // Keep the physical omni_* schema stable for existing data and rollback;
  // migrate only the product identity stored in this user-visible setting.
  await sql`
    ALTER TABLE omni_mcp_export_configurations
    ALTER COLUMN server_name SET DEFAULT 'Asael'
  `;
  await sql`
    UPDATE omni_mcp_export_configurations
    SET server_name = 'Asael',
        updated_at = NOW()
    WHERE server_name = 'OmniAgent'
  `;
}

export async function ensureTenantCapabilityRollouts(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_capability_rollouts (
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      engine_version TEXT NOT NULL,
      contract_version_id TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      activated_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_capability_rollouts_pkey
        PRIMARY KEY (tenant_id, capability_id, rollout_generation),
      CONSTRAINT omni_tenant_capability_rollouts_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_tenant_capability_rollouts_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(capability_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND omni_source_contract_id_is_valid(contract_version_id)
        AND omni_source_contract_id_is_valid(created_by_actor_id)
        AND (
          activated_by_actor_id IS NULL
          OR omni_source_contract_id_is_valid(activated_by_actor_id)
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_generation_check CHECK (
        rollout_generation BETWEEN 1 AND 9007199254740991
        AND lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND (
          (status = 'registered' AND lifecycle_revision = 0)
          OR (status <> 'registered' AND lifecycle_revision >= 1)
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_hash_check CHECK (
        configuration_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_tenant_capability_rollouts_mode_check CHECK (
        mode IN ('shadow', 'canary', 'enabled')
      ),
      CONSTRAINT omni_tenant_capability_rollouts_status_check CHECK (
        status IN ('registered', 'active', 'paused', 'superseded')
      ),
      CONSTRAINT omni_tenant_capability_rollouts_activation_check CHECK (
        (activated_by_actor_id IS NULL) = (activated_at IS NULL)
        AND (
          (status = 'registered' AND activated_at IS NULL)
          OR (status IN ('active', 'paused') AND activated_at IS NOT NULL)
          OR status = 'superseded'
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_superseded_check CHECK (
        (status = 'superseded') = (superseded_at IS NOT NULL)
      ),
      CONSTRAINT omni_tenant_capability_rollouts_timestamps_check CHECK (
        created_at <= updated_at
        AND (activated_at IS NULL OR created_at <= activated_at)
        AND (activated_at IS NULL OR activated_at <= updated_at)
        AND (superseded_at IS NULL OR created_at <= superseded_at)
        AND (superseded_at IS NULL OR superseded_at <= updated_at)
        AND (activated_at IS NULL OR superseded_at IS NULL
          OR activated_at <= superseded_at)
      )
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_tenant_capability_rollouts_one_current_idx
    ON omni_tenant_capability_rollouts (tenant_id, capability_id)
    WHERE status <> 'superseded'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS
      omni_tenant_capability_rollouts_active_idx
    ON omni_tenant_capability_rollouts (
      tenant_id,
      status,
      capability_id,
      rollout_generation DESC
    )
    WHERE status IN ('active', 'paused')
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_capability_rollout_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.capability_id)
      );

      IF NEW.status <> 'registered'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.superseded_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Capability rollouts must be inserted as registered'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.capability_id
          AND rollout.rollout_generation >= NEW.rollout_generation
      ) THEN
        RAISE EXCEPTION 'Capability rollout generation must increase'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.status <> 'superseded' AND EXISTS (
        SELECT 1
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.capability_id
          AND rollout.status <> 'superseded'
      ) THEN
        RAISE EXCEPTION 'Capability already has a current rollout generation'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_capability_rollout()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.capability_id)
      );

      IF OLD.status = 'superseded' THEN
        RAISE EXCEPTION 'Superseded capability rollouts are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.contract_version_id IS DISTINCT FROM OLD.contract_version_id
        OR NEW.configuration_sha256 IS DISTINCT FROM OLD.configuration_sha256
        OR NEW.mode IS DISTINCT FROM OLD.mode
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Capability rollout contract is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.status = 'registered' AND NEW.status IN ('active', 'superseded'))
        OR (OLD.status = 'active' AND NEW.status IN ('paused', 'superseded'))
        OR (OLD.status = 'paused' AND NEW.status IN ('active', 'superseded'))
      ) THEN
        RAISE EXCEPTION 'Capability rollout status transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Capability rollout lifecycle revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Capability rollout activation identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL
        AND NEW.activated_at IS NOT NULL
        AND NOT (OLD.status = 'registered' AND NEW.status = 'active')
      THEN
        RAISE EXCEPTION 'Capability rollout activation metadata is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF OLD.superseded_at IS NOT NULL
        AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
      THEN
        RAISE EXCEPTION 'Capability rollout supersession time is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Capability rollout updated_at must increase'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_validate_insert'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_validate_insert
        BEFORE INSERT ON omni_tenant_capability_rollouts
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_capability_rollout_insert();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_protect'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_capability_rollouts
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_capability_rollout();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_no_truncate'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_no_truncate
        BEFORE TRUNCATE ON omni_tenant_capability_rollouts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_capability_rollout();
      END IF;
    END
    $migration$
  `;

  // Mirror the existing mutable tenant-control-plane grants without naming a
  // deployment-owned runtime role in application schema code.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_provider_connections'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_tenant_capability_rollouts TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

export async function ensureMcpConnectorCredentialVault(sql: SqlClient) {
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_version INTEGER`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_key_id TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_origin TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS sealed_credential JSONB`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_created_by TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_rotated_by TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_created_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_rotated_at TIMESTAMPTZ`;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_mcp_connectors_credential_version_check'
          AND conrelid = 'omni_mcp_connectors'::regclass
      ) THEN
        ALTER TABLE omni_mcp_connectors
        ADD CONSTRAINT omni_mcp_connectors_credential_version_check
        CHECK (credential_version IS NULL OR credential_version > 0);
      END IF;
    END
    $migration$
  `;
}

export async function ensureMobileSessions(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_mobile_sessions (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_version TEXT,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      consumed_refresh_token_hashes JSONB NOT NULL DEFAULT '[]',
      access_expires_at TIMESTAMPTZ NOT NULL,
      refresh_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_access_idx ON omni_mobile_sessions (access_token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_refresh_idx ON omni_mobile_sessions (refresh_token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_consumed_refresh_idx ON omni_mobile_sessions USING GIN (consumed_refresh_token_hashes)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_user_device_idx ON omni_mobile_sessions (user_id, device_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_expiry_idx ON omni_mobile_sessions (refresh_expires_at)`;
}

export async function ensureUnifiedAiUsageLedger(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_ai_usage (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_stream_id TEXT NOT NULL,
      source_event_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      execution_scope JSONB CHECK (
        execution_scope IS NULL OR jsonb_typeof(execution_scope) = 'object'
      ),
      operation TEXT NOT NULL
        CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
          'text_generation', 'structured_generation', 'tool_turn',
          'embedding', 'web_search', 'ocr', 'image_generation', 'video_generation',
          'transcription', 'speech_synthesis', 'browser_automation'
        )),
      purpose TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      usage JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(usage) = 'object'),
      call_receipts JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT omni_ai_usage_call_receipts_check
        CHECK (jsonb_typeof(call_receipts) = 'array'),
      provider_call_count INTEGER NOT NULL DEFAULT 1
        CHECK (provider_call_count >= 0),
      attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
      failed_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempt_count >= 0 AND failed_attempt_count <= attempt_count),
      latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
      estimated_cost_microusd BIGINT CHECK (
        estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0
      ),
      pricing_source TEXT,
      pricing_version TEXT,
      provider_request_id TEXT,
      assignment_id TEXT,
      assignment_scope TEXT,
      assignment_revision INTEGER CHECK (
        assignment_revision IS NULL OR assignment_revision > 0
      ),
      assignment_configuration_sha256 TEXT CHECK (
        assignment_configuration_sha256 IS NULL
        OR assignment_configuration_sha256 ~ '^[a-f0-9]{64}$'
      ),
      credential_source TEXT CHECK (
        credential_source IS NULL
        OR credential_source IN ('tenant_vault', 'deployment_environment')
      ),
      failure_kind TEXT,
      retryable BOOLEAN,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (btrim(tenant_id) <> ''),
      CHECK (btrim(actor_id) <> ''),
      CHECK (btrim(source_stream_id) <> ''),
      CHECK (btrim(purpose) <> ''),
      CHECK (btrim(provider) <> ''),
      CHECK (btrim(model) <> ''),
      CONSTRAINT omni_ai_usage_provider_attempt_check
        CHECK (provider_call_count <= attempt_count)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_ai_usage_tenant_source_event_idx
    ON omni_ai_usage (tenant_id, source_event_id)
    WHERE source_event_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_recorded_idx
    ON omni_ai_usage (tenant_id, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_actor_recorded_idx
    ON omni_ai_usage (tenant_id, actor_id, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_purpose_recorded_idx
    ON omni_ai_usage (tenant_id, purpose, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_retention_idx
    ON omni_ai_usage (recorded_at ASC)
  `;
}

export async function ensureUnifiedAiUsageLedgerCompatibility(sql: SqlClient) {
  await ensureUnifiedAiUsageLedger(sql);
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS correlation_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS causation_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS execution_scope JSONB`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS call_receipts JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS provider_request_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS assignment_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS assignment_scope TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS assignment_revision INTEGER`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS assignment_configuration_sha256 TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS credential_source TEXT`;
  await sql`ALTER TABLE omni_ai_usage DROP CONSTRAINT IF EXISTS omni_ai_usage_operation_check`;
  await sql`
    ALTER TABLE omni_ai_usage
    ADD CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
      'text_generation', 'structured_generation', 'tool_turn',
      'embedding', 'web_search', 'ocr', 'image_generation', 'video_generation',
      'transcription', 'speech_synthesis', 'browser_automation'
    ))
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_call_receipts_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_call_receipts_check
        CHECK (jsonb_typeof(call_receipts) = 'array');
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_provider_attempt_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_provider_attempt_check
        CHECK (provider_call_count <= attempt_count);
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_execution_scope_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_execution_scope_check
        CHECK (execution_scope IS NULL OR jsonb_typeof(execution_scope) = 'object');
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_credential_source_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_credential_source_check
        CHECK (
          credential_source IS NULL
          OR credential_source IN ('tenant_vault', 'deployment_environment')
        );
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantOwnedOperationalSchema(sql: SqlClient) {
  const tenantTables = [
    "omni_memory_graph_nodes",
    "omni_memory_graph_edges",
    "omni_memory_graph_builds",
    "omni_memory_graph_rebuild_queue",
    "omni_workflow_triggers",
    "omni_workflow_trigger_events",
    "omni_operation_jobs",
    "omni_system_health_checks",
    "omni_incidents",
    "omni_incident_events",
    "omni_alert_deliveries",
    "omni_observability_slo_policies",
    "omni_observability_slo_policy_changes",
    "omni_tool_executions",
    "omni_eval_reports",
    "omni_observability_events",
  ] as const;

  // Add columns without constraints first, preserve all legacy rows as the
  // default tenant, then enforce ownership. This ordering is safe for deployed
  // databases and never drops or rewrites a table.
  for (const tableName of tenantTables) {
    await sql.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  }

  // Recover ownership from tenant-aware parents before assigning the legacy
  // default. Mixed-version deployments can already contain non-default runs,
  // memories, traces, or evals while their newer child tables are unowned.
  await sql`
    UPDATE omni_operation_jobs job
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE job.payload->>'workflowRunId' = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        job.tenant_id IS NULL
        OR job.tenant_id = ''
        OR (job.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_workflow_trigger_events event
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE event.workflow_run_id = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    WITH trigger_ownership AS (
      SELECT trigger_id, MIN(tenant_id) AS tenant_id
      FROM omni_workflow_trigger_events
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      GROUP BY trigger_id
      HAVING COUNT(DISTINCT tenant_id) = 1
    )
    UPDATE omni_workflow_triggers trigger
    SET tenant_id = ownership.tenant_id
    FROM trigger_ownership ownership
    WHERE trigger.id = ownership.trigger_id
      AND (
        trigger.tenant_id IS NULL
        OR trigger.tenant_id = ''
        OR (trigger.tenant_id = 'default' AND ownership.tenant_id <> 'default')
      )
  `;
  await sql`
    WITH graph_evidence AS (
      SELECT node.id AS node_id, memory.tenant_id
      FROM omni_memory_graph_nodes node
      CROSS JOIN LATERAL unnest(node.memory_ids) memory_id
      JOIN omni_memories memory ON memory.id = memory_id
      UNION ALL
      SELECT node.id AS node_id, trace.tenant_id
      FROM omni_memory_graph_nodes node
      CROSS JOIN LATERAL unnest(node.trace_ids) trace_id
      JOIN omni_retrieval_traces trace ON trace.id = trace_id
    ),
    graph_ownership AS (
      SELECT node_id, MIN(tenant_id) AS tenant_id
      FROM graph_evidence
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      GROUP BY node_id
      HAVING COUNT(DISTINCT tenant_id) = 1
    )
    UPDATE omni_memory_graph_nodes node
    SET tenant_id = ownership.tenant_id
    FROM graph_ownership ownership
    WHERE node.id = ownership.node_id
      AND (
        node.tenant_id IS NULL
        OR node.tenant_id = ''
        OR (node.tenant_id = 'default' AND ownership.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_observability_slo_policy_changes policy_change
    SET tenant_id = policy.tenant_id
    FROM omni_observability_slo_policies policy
    WHERE policy_change.policy_id = policy.id
      AND policy.tenant_id IS NOT NULL
      AND (
        policy_change.tenant_id IS NULL
        OR policy_change.tenant_id = ''
        OR (policy_change.tenant_id = 'default' AND policy.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_eval_reports report
    SET tenant_id = run.tenant_id
    FROM omni_eval_runs run
    WHERE report.eval_run_id = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        report.tenant_id IS NULL
        OR report.tenant_id = ''
        OR (report.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_memory_graph_edges edge
    SET tenant_id = node.tenant_id
    FROM omni_memory_graph_nodes node
    WHERE edge.source_node_id = node.id
      AND node.tenant_id IS NOT NULL
      AND (
        edge.tenant_id IS NULL
        OR edge.tenant_id = ''
        OR (edge.tenant_id = 'default' AND node.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_incident_events event
    SET tenant_id = incident.tenant_id
    FROM omni_incidents incident
    WHERE event.incident_id = incident.id
      AND incident.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND incident.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_alert_deliveries delivery
    SET tenant_id = incident.tenant_id
    FROM omni_incidents incident
    WHERE delivery.incident_id = incident.id
      AND incident.tenant_id IS NOT NULL
      AND (
        delivery.tenant_id IS NULL
        OR delivery.tenant_id = ''
        OR (delivery.tenant_id = 'default' AND incident.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_workflow_trigger_events event
    SET tenant_id = trigger.tenant_id
    FROM omni_workflow_triggers trigger
    WHERE event.trigger_id = trigger.id
      AND trigger.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND trigger.tenant_id <> 'default')
      )
  `;

  for (const tableName of tenantTables) {
    await sql.query(`
      UPDATE ${tableName}
      SET tenant_id = 'default'
      WHERE tenant_id IS NULL OR tenant_id = ''
    `);
    await sql.query(`ALTER TABLE ${tableName} ALTER COLUMN tenant_id SET DEFAULT 'default'`);
    await sql.query(`ALTER TABLE ${tableName} ALTER COLUMN tenant_id SET NOT NULL`);
  }

  // New writes namespace dedupe keys by tenant. Bring inferred non-default
  // legacy jobs onto the same key shape without colliding with an already
  // migrated row.
  await sql`
    UPDATE omni_operation_jobs job
    SET dedupe_key = NULL
    WHERE job.tenant_id <> 'default'
      AND job.dedupe_key IS NOT NULL
      AND job.dedupe_key NOT LIKE job.tenant_id || '/%'
      AND EXISTS (
        SELECT 1
        FROM omni_operation_jobs migrated
        WHERE migrated.id <> job.id
          AND migrated.dedupe_key = job.tenant_id || '/' || job.dedupe_key
      )
  `;
  await sql`
    UPDATE omni_operation_jobs
    SET dedupe_key = tenant_id || '/' || dedupe_key
    WHERE tenant_id <> 'default'
      AND dedupe_key IS NOT NULL
      AND dedupe_key NOT LIKE tenant_id || '/%'
  `;

  await sql`ALTER TABLE omni_workflow_trigger_events ADD COLUMN IF NOT EXISTS delivery_key TEXT`;
  await sql`ALTER TABLE omni_workflow_trigger_events ADD COLUMN IF NOT EXISTS signature_digest TEXT`;

  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tenant_updated_idx ON omni_memory_graph_nodes (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tenant_kind_idx ON omni_memory_graph_nodes (tenant_id, kind)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_tenant_updated_idx ON omni_memory_graph_edges (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_tenant_source_idx ON omni_memory_graph_edges (tenant_id, source_node_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_builds_tenant_created_idx ON omni_memory_graph_builds (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_tenant_updated_idx ON omni_workflow_triggers (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_tenant_trigger_idx ON omni_workflow_trigger_events (tenant_id, trigger_id, received_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_tenant_status_run_idx ON omni_operation_jobs (tenant_id, status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_tenant_updated_idx ON omni_operation_jobs (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_tenant_created_idx ON omni_system_health_checks (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_tenant_status_updated_idx ON omni_incidents (tenant_id, status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_tenant_fingerprint_idx ON omni_incidents (tenant_id, fingerprint)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_tenant_incident_idx ON omni_incident_events (tenant_id, incident_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_tenant_status_run_idx ON omni_alert_deliveries (tenant_id, status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_tenant_incident_idx ON omni_alert_deliveries (tenant_id, incident_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_tenant_updated_idx ON omni_observability_slo_policies (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_tenant_enabled_idx ON omni_observability_slo_policies (tenant_id, enabled, updated_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_trigger_events_delivery_idx
    ON omni_workflow_trigger_events (tenant_id, trigger_id, delivery_key)
    WHERE delivery_key IS NOT NULL
  `;
}

export async function ensurePlatformSafetyTables(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_rate_limits_expires_idx
    ON omni_rate_limits (expires_at ASC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_access_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      use_case TEXT NOT NULL,
      timeline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      reviewed_by TEXT,
      review_note TEXT,
      reviewed_at TIMESTAMPTZ,
      provisioned_user_id TEXT,
      provisioned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_tenant_status_created_idx
    ON omni_access_requests (tenant_id, status, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_tenant_email_idx
    ON omni_access_requests (tenant_id, email)
  `;
}

export async function ensurePlatformSafetyControls(sql: SqlClient) {
  await ensurePlatformSafetyTables(sql);
  // Existing deployments may already have completed the RLS migration before
  // this table was introduced. Re-running the idempotent policy installer
  // closes the new table in the same transaction as its creation.
  await ensureTenantIsolationPolicies(sql);
}

export async function ensureSensitiveDataRetention(sql: SqlClient) {
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_generated_retention_idx
    ON omni_memories (updated_at ASC)
    WHERE source IN ('agent', 'consolidator')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_pending_retention_idx
    ON omni_access_requests (created_at ASC)
    WHERE status = 'pending_review'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_reviewed_retention_idx
    ON omni_access_requests (updated_at ASC)
    WHERE status IN ('provisioned', 'declined')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_runs_waiting_retention_idx
    ON omni_agent_runs (started_at ASC)
    WHERE status = 'waiting_approval'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_workflow_runs_terminal_retention_idx
    ON omni_workflow_runs (COALESCE(completed_at, updated_at) ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_workflow_plans_retention_idx
    ON omni_workflow_plans (updated_at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_operation_jobs_terminal_retention_idx
    ON omni_operation_jobs (COALESCE(completed_at, updated_at) ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_runs_terminal_retention_idx
    ON omni_agent_runs (completed_at ASC)
    WHERE status IN ('completed', 'failed')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_tool_executions_pending_retention_idx
    ON omni_tool_executions (created_at ASC)
    WHERE status = 'approval_required'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_tool_executions_terminal_retention_idx
    ON omni_tool_executions (COALESCE(completed_at, created_at) ASC)
    WHERE status IN ('dry_run', 'executed', 'blocked', 'failed', 'rejected')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_events_retention_idx
    ON omni_events (at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_observability_events_retention_idx
    ON omni_observability_events (created_at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_security_audits_retention_idx
    ON omni_security_audits (created_at ASC)
  `;
  // Reconcile policy definitions for tables added to tenant isolation after
  // earlier schema versions had already shipped.
  await ensureTenantIsolationPolicies(sql);
}

export async function ensureAgentRunCancellationRetention(sql: SqlClient) {
  await sql`DROP INDEX IF EXISTS omni_agent_runs_terminal_retention_idx`;
  await sql`
    CREATE INDEX omni_agent_runs_terminal_retention_idx
    ON omni_agent_runs (completed_at ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
}

export async function ensureDatabaseIdentity(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_database_identity (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO omni_database_identity (singleton, id)
    VALUES (
      TRUE,
      md5(
        random()::text ||
        clock_timestamp()::text ||
        current_database() ||
        pg_backend_pid()::text
      )
    )
    ON CONFLICT (singleton) DO NOTHING
  `;
}

export async function normalizeLegacyJsonbStorage(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION pg_temp.omni_decode_legacy_jsonb(value JSONB)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      decoded JSONB;
    BEGIN
      IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN
        RETURN value;
      END IF;
      BEGIN
        decoded := (value #>> '{}')::jsonb;
        RETURN decoded;
      EXCEPTION WHEN OTHERS THEN
        RETURN value;
      END;
    END
    $function$
  `;
  await sql`
    DO $migration$
    DECLARE
      json_column RECORD;
    BEGIN
      FOR json_column IN
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name LIKE 'omni\_%' ESCAPE '\'
          AND data_type = 'jsonb'
        ORDER BY table_name, ordinal_position
      LOOP
        EXECUTE format(
          'UPDATE %I.%I SET %I = pg_temp.omni_decode_legacy_jsonb(%I) ' ||
          'WHERE jsonb_typeof(%I) = ''string''',
          json_column.table_schema,
          json_column.table_name,
          json_column.column_name,
          json_column.column_name,
          json_column.column_name
        );
      END LOOP;
    END
    $migration$
  `;
  await sql`
    UPDATE omni_operation_jobs
    SET payload =
      pg_temp.omni_decode_legacy_jsonb(payload -> 0) ||
      (payload -> 1)
    WHERE jsonb_typeof(payload) = 'array'
      AND jsonb_array_length(payload) = 2
      AND jsonb_typeof(pg_temp.omni_decode_legacy_jsonb(payload -> 0)) = 'object'
      AND jsonb_typeof(payload -> 1) = 'object'
      AND payload -> 1 ? '__rerunRequested'
  `;
}

export async function ensureNativeClientCompatibilityTelemetry(sql: SqlClient) {
  await sql`
    DO $migration$
    DECLARE
      attribute RECORD;
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Native client compatibility migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_mobile_sessions'::regclass
          AND relkind = 'r'
      ) THEN
        RAISE EXCEPTION 'Native mobile session relation is missing'
          USING ERRCODE = '55000';
      END IF;

      FOR attribute IN
        SELECT
          expected.name,
          expected.type_oid,
          existing.atttypid
        FROM (
          VALUES
            ('app_build_number'::TEXT, 'integer'::regtype::OID),
            ('client_contract_version'::TEXT, 'integer'::regtype::OID),
            ('last_seen_at'::TEXT, 'timestamp with time zone'::regtype::OID),
            ('client_attested_at'::TEXT, 'timestamp with time zone'::regtype::OID)
        ) expected(name, type_oid)
        JOIN pg_attribute existing
          ON existing.attrelid = 'omni_mobile_sessions'::regclass
          AND existing.attname = expected.name
          AND NOT existing.attisdropped
      LOOP
        IF attribute.atttypid IS DISTINCT FROM attribute.type_oid THEN
          RAISE EXCEPTION 'Existing native client compatibility column % has an incompatible type',
            attribute.name
            USING ERRCODE = '55000';
        END IF;
      END LOOP;

    END
    $migration$
  `;

  // Hold native enrollment writers while the additive contract columns and
  // checks are installed. Legacy app_version values remain untouched.
  await sql`
    LOCK TABLE omni_mobile_sessions IN SHARE ROW EXCLUSIVE MODE
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ADD COLUMN IF NOT EXISTS app_build_number INTEGER
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ADD COLUMN IF NOT EXISTS client_contract_version INTEGER NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ADD COLUMN IF NOT EXISTS client_attested_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ALTER COLUMN app_build_number DROP DEFAULT,
    ALTER COLUMN app_build_number DROP NOT NULL,
    ALTER COLUMN client_contract_version SET DEFAULT 0
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ALTER COLUMN client_contract_version SET NOT NULL,
    ALTER COLUMN last_seen_at DROP DEFAULT,
    ALTER COLUMN last_seen_at DROP NOT NULL,
    ALTER COLUMN client_attested_at DROP DEFAULT,
    ALTER COLUMN client_attested_at DROP NOT NULL
  `;

  // These names are owned by this migration. Rebuild them under the table
  // lock so a same-named weak or partially installed object cannot be
  // accepted through IF NOT EXISTS on a recovery run.
  await sql`
    ALTER TABLE omni_mobile_sessions
    DROP CONSTRAINT IF EXISTS omni_mobile_sessions_client_attestation_check
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    ADD CONSTRAINT omni_mobile_sessions_client_attestation_check
    CHECK (
      (
        client_contract_version = 0
        AND app_build_number IS NULL
        AND client_attested_at IS NULL
      ) OR (
        client_contract_version BETWEEN 1 AND 2147483647
        AND app_build_number IS NOT NULL
        AND app_build_number BETWEEN 1 AND 2147483647
        AND platform IS NOT NULL
        AND platform COLLATE "C" IN ('android', 'ios', 'macos')
        AND app_version IS NOT NULL
        AND app_version = btrim(app_version)
        AND client_attested_at IS NOT NULL
        AND app_version COLLATE "C" ~
          '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$'
      )
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_mobile_sessions
    VALIDATE CONSTRAINT omni_mobile_sessions_client_attestation_check
  `;

  await sql`
    DROP INDEX IF EXISTS omni_mobile_sessions_native_adoption_idx
  `;
  await sql`
    CREATE INDEX omni_mobile_sessions_native_adoption_idx
    ON omni_mobile_sessions (
      tenant_id,
      user_id,
      device_id,
      (COALESCE(last_seen_at, updated_at)) DESC,
      updated_at DESC,
      id COLLATE "C"
    )
    WHERE revoked_at IS NULL
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        LEFT JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_mobile_sessions'::regclass
          AND attribute.attname = 'app_build_number'
          AND attribute.atttypid = 'integer'::regtype
          AND NOT attribute.attnotnull
          AND NOT attribute.attisdropped
          AND attribute_default.oid IS NULL
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_mobile_sessions'::regclass
          AND attribute.attname = 'client_contract_version'
          AND attribute.atttypid = 'integer'::regtype
          AND attribute.attnotnull
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '0'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        LEFT JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_mobile_sessions'::regclass
          AND attribute.attname = 'last_seen_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attnotnull
          AND NOT attribute.attisdropped
          AND attribute_default.oid IS NULL
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        LEFT JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_mobile_sessions'::regclass
          AND attribute.attname = 'client_attested_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attnotnull
          AND NOT attribute.attisdropped
          AND attribute_default.oid IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_mobile_sessions
        WHERE NOT (
            (
              client_contract_version = 0
              AND app_build_number IS NULL
              AND client_attested_at IS NULL
            ) OR (
              client_contract_version BETWEEN 1 AND 2147483647
              AND app_build_number IS NOT NULL
              AND app_build_number BETWEEN 1 AND 2147483647
              AND platform IS NOT NULL
              AND platform COLLATE "C" IN ('android', 'ios', 'macos')
              AND app_version IS NOT NULL
              AND app_version = btrim(app_version)
              AND client_attested_at IS NOT NULL
              AND app_version COLLATE "C" ~
                '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$'
            )
          )
      ) THEN
        RAISE EXCEPTION 'Native client compatibility columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_constraint constraint_record
        WHERE conrelid = 'omni_mobile_sessions'::regclass
          AND conname = 'omni_mobile_sessions_client_attestation_check'
          AND contype = 'c'
          AND convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
      ) <> 1 OR NOT EXISTS (
        SELECT 1
        FROM pg_index
        WHERE indexrelid =
            'omni_mobile_sessions_native_adoption_idx'::regclass
          AND indrelid = 'omni_mobile_sessions'::regclass
          AND indisvalid
          AND indisready
          AND indpred IS NOT NULL
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_mobile_sessions'::regclass
          AND relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_mobile_sessions'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) THEN
        RAISE EXCEPTION 'Native client compatibility storage boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
