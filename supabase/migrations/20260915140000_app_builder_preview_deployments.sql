BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 170 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 170 AND name = 'app_builder_github_delivery_v1'
      AND checksum = '7d1f8e773faa0de1e8a5ac7a58ffb79a236a79504932fc757ee4cfbfbf796e7f'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder preview deployment predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_app_builder_deployments (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  repository_delivery_id TEXT,
  commit_sha TEXT,
  workspace_sha256 TEXT NOT NULL,
  file_manifest_sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  byte_count BIGINT NOT NULL,
  secret_scan_sha256 TEXT NOT NULL,
  smoke_routes JSONB NOT NULL,
  provider_project_id TEXT,
  provider_deployment_id TEXT,
  provider_state TEXT,
  deployment_url TEXT,
  status TEXT NOT NULL,
  logs JSONB NOT NULL,
  route_evidence JSONB NOT NULL,
  browser_evidence JSONB NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_app_builder_deployments_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_deployments_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_deployments_session_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deployments_checkpoint_fkey FOREIGN KEY (tenant_id, checkpoint_id, owner_actor_id)
    REFERENCES public.omni_app_builder_checkpoints (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deployments_verification_fkey FOREIGN KEY (tenant_id, verification_id, owner_actor_id)
    REFERENCES public.omni_app_builder_verifications (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deployments_delivery_fkey FOREIGN KEY (tenant_id, repository_delivery_id, owner_actor_id)
    REFERENCES public.omni_app_builder_deliveries (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deployments_row_check CHECK (COALESCE(
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
    AND (deployment_url IS NULL OR deployment_url ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9]\\.vercel\\.app/$')
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
  , FALSE))
);

CREATE INDEX omni_app_builder_deployments_owner_time_idx
ON public.omni_app_builder_deployments (tenant_id, owner_actor_id, session_id, created_at DESC, id);

ALTER TABLE public.omni_app_builder_events
  DROP CONSTRAINT omni_app_builder_events_row_check;
ALTER TABLE public.omni_app_builder_events
  ADD CONSTRAINT omni_app_builder_events_row_check CHECK (COALESCE(
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
      'app_builder.repository.bound', 'app_builder.secret_scan.completed',
      'app_builder.delivery.pull_request_open', 'app_builder.delivery.failed',
      'app_builder.deployment.preview_queued', 'app_builder.deployment.preview_ready',
      'app_builder.deployment.preview_incomplete', 'app_builder.deployment.preview_failed'
    )
    AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
    AND payload_sha256 ~ '^[a-f0-9]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE));

ALTER TABLE public.omni_app_builder_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_deployments FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_app_builder_deployments_actor_scope ON public.omni_app_builder_deployments
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

REVOKE ALL ON public.omni_app_builder_deployments FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_deployments TO omni_runtime;
    GRANT UPDATE (status, provider_project_id, provider_deployment_id, provider_state, deployment_url, logs, route_evidence, browser_evidence, failure_code, updated_at)
      ON public.omni_app_builder_deployments TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_deployments TO omni_maintenance;
    GRANT UPDATE (status, provider_project_id, provider_deployment_id, provider_state, deployment_url, logs, route_evidence, browser_evidence, failure_code, updated_at)
      ON public.omni_app_builder_deployments TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_deployments TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_app_builder_deployments'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.omni_app_builder_deployments'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder preview deployment isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (171, 'app_builder_preview_deployments_v1', '22a1cc4db58ef6e999d0276af281a12d4876dc46964009ebd124d645327294ad', clock_timestamp());

COMMIT;
