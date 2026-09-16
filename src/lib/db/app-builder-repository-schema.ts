type SqlRow = Record<string, unknown>;

export type AppBuilderRepositorySchemaSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export async function ensureAppBuilderDeploymentUrlConstraintRepairV1(
  sql: AppBuilderRepositorySchemaSqlClient,
) {
  await sql.query(`
    DO $verify$
    BEGIN
      IF NOT ('https://asael-app-1234567890abcdef.vercel.app/' ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$')
        OR 'https://asael-app-1234567890abcdefXvercelYapp/' ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$' THEN
        RAISE EXCEPTION 'App Builder deployment URL constraint repair is invalid' USING ERRCODE = '55000';
      END IF;
    END
    $verify$
  `);
}

export async function ensureAppBuilderRepositoryWorkspacesV1(
  sql: AppBuilderRepositorySchemaSqlClient,
) {
  await sql.query(`
    ALTER TABLE omni_app_builder_checkpoints DROP CONSTRAINT omni_app_builder_checkpoints_row_check;
    ALTER TABLE omni_app_builder_checkpoints ADD CONSTRAINT omni_app_builder_checkpoints_row_check CHECK (COALESCE(
      schema_version = 1
      AND id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
      AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
      AND char_length(project_id) BETWEEN 1 AND 200
      AND session_id ~ '^app_build_[a-f0-9]{48}$'
      AND contract_version = 'app-builder-checkpoint:1'
      AND char_length(btrim(provider_snapshot_id)) BETWEEN 1 AND 240
      AND workspace_sha256 ~ '^[a-f0-9]{64}$'
      AND file_count BETWEEN 1 AND 10000
      AND snapshot_bytes >= 0
      AND reason IN ('manual', 'before_forge', 'after_forge', 'before_sentinel', 'before_restore')
      AND char_length(btrim(label)) BETWEEN 1 AND 120
      AND (source_run_id IS NULL OR char_length(btrim(source_run_id)) BETWEEN 1 AND 240)
      AND session_revision > 0
      AND created_at <= NOW() + INTERVAL '30 seconds'
      AND (expires_at IS NULL OR expires_at > created_at)
    , FALSE));
    ALTER TABLE omni_app_builder_events DROP CONSTRAINT omni_app_builder_events_row_check;
    ALTER TABLE omni_app_builder_events ADD CONSTRAINT omni_app_builder_events_row_check CHECK (COALESCE(
      schema_version = 1
      AND id ~ '^app_build_event_[a-f0-9]{48}$'
      AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
      AND session_id ~ '^app_build_[a-f0-9]{48}$'
      AND event_type IN (
        'app_builder.session.provisioning_started', 'app_builder.session.ready',
        'app_builder.session.failed', 'app_builder.session.stopped',
        'app_builder.file.updated', 'app_builder.command.completed',
        'app_builder.checkpoint.created', 'app_builder.checkpoint.restored',
        'app_builder.verification.completed', 'app_builder.sentinel.reviewed',
        'app_builder.repository.bound', 'app_builder.repository.checked_out',
        'app_builder.secret_scan.completed',
        'app_builder.delivery.pull_request_open', 'app_builder.delivery.failed',
        'app_builder.deployment.preview_queued', 'app_builder.deployment.preview_ready',
        'app_builder.deployment.preview_incomplete', 'app_builder.deployment.preview_failed',
        'app_builder.release.review_prepared', 'app_builder.release.production_queued',
        'app_builder.release.production_healthy', 'app_builder.release.production_incomplete',
        'app_builder.release.production_failed'
      )
      AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
      AND payload_sha256 ~ '^[a-f0-9]{64}$'
      AND occurred_at <= NOW() + INTERVAL '30 seconds'
    , FALSE));
  `);
}

export async function ensureAppBuilderRepositoryGitPreviewV1(
  sql: AppBuilderRepositorySchemaSqlClient,
) {
  await sql.query(`
    ALTER TABLE omni_app_builder_deployments DROP CONSTRAINT omni_app_builder_deployments_row_check;
    ALTER TABLE omni_app_builder_deployments ADD CONSTRAINT omni_app_builder_deployments_row_check CHECK (COALESCE(
      schema_version = 1
      AND id ~ '^app_build_deployment_[a-f0-9]{48}$'
      AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
      AND char_length(project_id) BETWEEN 1 AND 200
      AND session_id ~ '^app_build_[a-f0-9]{48}$'
      AND contract_version = 'app-builder-deployment:1'
      AND checkpoint_id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
      AND verification_id ~ '^app_build_verification_[a-f0-9]{48}$'
      AND (repository_delivery_id IS NULL OR repository_delivery_id ~ '^app_build_delivery_[a-f0-9]{48}$')
      AND (commit_sha IS NULL OR commit_sha ~ '^[a-f0-9]{40,64}$')
      AND ((repository_delivery_id IS NULL AND commit_sha IS NULL) OR (repository_delivery_id IS NOT NULL AND commit_sha IS NOT NULL))
      AND workspace_sha256 ~ '^[a-f0-9]{64}$'
      AND file_manifest_sha256 ~ '^[a-f0-9]{64}$'
      AND file_count BETWEEN 1 AND 10000
      AND byte_count BETWEEN 1 AND 8000000
      AND secret_scan_sha256 ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(smoke_routes) = 'array' AND jsonb_array_length(smoke_routes) BETWEEN 1 AND 20
      AND pg_column_size(smoke_routes) <= 4096
      AND (provider_project_id IS NULL OR provider_project_id ~ '^prj_[A-Za-z0-9]+$')
      AND (provider_deployment_id IS NULL OR provider_deployment_id ~ '^dpl_[A-Za-z0-9]+$')
      AND (provider_state IS NULL OR char_length(provider_state) BETWEEN 1 AND 40)
      AND (deployment_url IS NULL OR deployment_url ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$')
      AND status IN ('preparing', 'queued', 'building', 'verifying', 'ready', 'incomplete', 'failed')
      AND jsonb_typeof(logs) = 'object' AND pg_column_size(logs) <= 4096
      AND jsonb_typeof(route_evidence) = 'object' AND pg_column_size(route_evidence) <= 16384
      AND jsonb_typeof(browser_evidence) = 'object' AND pg_column_size(browser_evidence) <= 16384
      AND (failure_code IS NULL OR failure_code ~ '^vercel_[a-f0-9]{12}$')
      AND (
        (status = 'preparing' AND provider_project_id IS NULL AND provider_deployment_id IS NULL AND deployment_url IS NULL AND failure_code IS NULL)
        OR (status IN ('queued', 'building', 'verifying', 'ready', 'incomplete') AND provider_project_id IS NOT NULL AND provider_deployment_id IS NOT NULL AND deployment_url IS NOT NULL AND failure_code IS NULL)
        OR (status = 'failed' AND failure_code IS NOT NULL)
      )
      AND created_at <= updated_at
      AND updated_at <= NOW() + INTERVAL '30 seconds'
    , FALSE));
  `);
  await sql`
    DO $verify$
    DECLARE constraint_definition TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO constraint_definition
      FROM pg_constraint
      WHERE conrelid = 'omni_app_builder_deployments'::regclass
        AND conname = 'omni_app_builder_deployments_row_check';
      IF constraint_definition IS NULL
        OR position('10000' IN constraint_definition) = 0
        OR position('8000000' IN constraint_definition) = 0 THEN
        RAISE EXCEPTION 'App Builder repository Git preview capacity is invalid' USING ERRCODE = '55000';
      END IF;
    END
    $verify$
  `;
}
