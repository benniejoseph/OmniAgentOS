BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 175 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 175 AND name = 'tool_execution_retention_redaction_v2'
      AND checksum = '300aff0f20a6d42ce84437c5ae8c45ac0c9e7fcd0f64b5b52fd5a291bd385e57'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder repository Git previews predecessor is invalid' USING ERRCODE = '55000';
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

DO $verify$
DECLARE constraint_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_definition
  FROM pg_constraint
  WHERE conrelid = 'public.omni_app_builder_deployments'::regclass
    AND conname = 'omni_app_builder_deployments_row_check';

  IF constraint_definition IS NULL
    OR position('10000' IN constraint_definition) = 0
    OR position('8000000' IN constraint_definition) = 0 THEN
    RAISE EXCEPTION 'App Builder repository Git preview capacity is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  176,
  'app_builder_repository_git_preview_v1',
  'fe9e7e77a45fcbf2a17012c232859f0172d0cacac134da4373d38a60afd67e4c',
  clock_timestamp()
);

COMMIT;
