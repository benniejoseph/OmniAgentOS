BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 172 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 172 AND name = 'app_builder_production_releases_v1'
      AND checksum = '7d4c51d2d01df3f14c2ccf263b8c2b029acaf1537db427d8b2353b4b3ea8fed0'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder deployment URL repair predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_app_builder_deployments DROP CONSTRAINT omni_app_builder_deployments_row_check;
ALTER TABLE public.omni_app_builder_deployments ADD CONSTRAINT omni_app_builder_deployments_row_check CHECK (COALESCE(
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
  AND file_count BETWEEN 1 AND 500
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

ALTER TABLE public.omni_app_builder_releases DROP CONSTRAINT omni_app_builder_releases_row_check;
ALTER TABLE public.omni_app_builder_releases ADD CONSTRAINT omni_app_builder_releases_row_check CHECK (COALESCE(
  schema_version = 1
  AND id ~ '^app_build_release_[a-f0-9]{48}$'
  AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
  AND char_length(project_id) BETWEEN 1 AND 200
  AND session_id ~ '^app_build_[a-f0-9]{48}$'
  AND deployment_id ~ '^app_build_deployment_[a-f0-9]{48}$'
  AND contract_version = 'app-builder-release:1'
  AND preview_provider_deployment_id ~ '^dpl_[A-Za-z0-9]+$'
  AND workspace_sha256 ~ '^[a-f0-9]{64}$'
  AND preview_evidence_sha256 ~ '^[a-f0-9]{64}$'
  AND release_digest ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(migration_evidence) = 'object' AND pg_column_size(migration_evidence) <= 4096
  AND migration_evidence->>'status' IN ('not_declared', 'declared')
  AND (migration_evidence->>'fileCount') ~ '^[0-9]{1,4}$'
  AND (migration_evidence->>'manifestSha256') ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(rollback_evidence) = 'object' AND pg_column_size(rollback_evidence) <= 4096
  AND rollback_evidence->>'status' IN ('available', 'first_release')
  AND (
    (rollback_evidence->>'status' = 'first_release' AND NOT (rollback_evidence ? 'providerDeploymentId') AND NOT (rollback_evidence ? 'deploymentUrl'))
    OR (rollback_evidence->>'status' = 'available' AND (rollback_evidence->>'providerDeploymentId') ~ '^dpl_[A-Za-z0-9]+$' AND (rollback_evidence->>'deploymentUrl') ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$')
  )
  AND status IN ('review_pending', 'releasing', 'building', 'healthy', 'incomplete', 'failed', 'expired')
  AND (provider_project_id IS NULL OR provider_project_id ~ '^prj_[A-Za-z0-9]+$')
  AND (provider_deployment_id IS NULL OR provider_deployment_id ~ '^dpl_[A-Za-z0-9]+$')
  AND (provider_state IS NULL OR char_length(provider_state) BETWEEN 1 AND 40)
  AND (deployment_url IS NULL OR deployment_url ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$')
  AND jsonb_typeof(logs) = 'object' AND pg_column_size(logs) <= 4096
  AND jsonb_typeof(route_evidence) = 'object' AND pg_column_size(route_evidence) <= 16384
  AND jsonb_typeof(browser_evidence) = 'object' AND pg_column_size(browser_evidence) <= 16384
  AND (failure_code IS NULL OR failure_code ~ '^release_[a-f0-9]{12}$')
  AND (
    (status IN ('review_pending', 'expired') AND provider_project_id IS NULL AND provider_deployment_id IS NULL AND provider_state IS NULL AND deployment_url IS NULL AND released_at IS NULL AND failure_code IS NULL)
    OR (status = 'releasing' AND released_at IS NOT NULL AND failure_code IS NULL AND ((provider_project_id IS NULL AND provider_deployment_id IS NULL AND deployment_url IS NULL) OR (provider_project_id IS NOT NULL AND provider_deployment_id IS NOT NULL AND deployment_url IS NOT NULL)))
    OR (status IN ('building', 'healthy', 'incomplete') AND provider_project_id IS NOT NULL AND provider_deployment_id IS NOT NULL AND deployment_url IS NOT NULL AND released_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL AND ((provider_project_id IS NULL AND provider_deployment_id IS NULL AND deployment_url IS NULL) OR (provider_project_id IS NOT NULL AND provider_deployment_id IS NOT NULL AND deployment_url IS NOT NULL)))
  )
  AND created_at <= updated_at
  AND created_at < expires_at AND expires_at <= created_at + INTERVAL '30 minutes'
  AND (released_at IS NULL OR released_at >= created_at)
  AND updated_at <= NOW() + INTERVAL '30 seconds'
, FALSE));

DO $verify$
BEGIN
  IF NOT ('https://asael-app-1234567890abcdef.vercel.app/' ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$')
    OR 'https://asael-app-1234567890abcdefXvercelYapp/' ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9][.]vercel[.]app/$' THEN
    RAISE EXCEPTION 'App Builder deployment URL constraint repair is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (173, 'app_builder_deployment_url_constraint_repair_v1', 'a41d2d82ad95d8402b182f8136f9bee67133d2380f246605c803915838c7da8e', clock_timestamp());

COMMIT;
