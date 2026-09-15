export const APP_BUILDER_PRODUCTION_RELEASE_SCHEMA_SQL = String.raw`
CREATE TABLE public.omni_app_builder_releases (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  preview_provider_deployment_id TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  preview_evidence_sha256 TEXT NOT NULL,
  release_digest TEXT NOT NULL,
  migration_evidence JSONB NOT NULL,
  rollback_evidence JSONB NOT NULL,
  status TEXT NOT NULL,
  provider_project_id TEXT,
  provider_deployment_id TEXT,
  provider_state TEXT,
  deployment_url TEXT,
  logs JSONB NOT NULL,
  route_evidence JSONB NOT NULL,
  browser_evidence JSONB NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CONSTRAINT omni_app_builder_releases_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_releases_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_releases_session_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_releases_deployment_fkey FOREIGN KEY (tenant_id, deployment_id, owner_actor_id)
    REFERENCES public.omni_app_builder_deployments (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_releases_row_check CHECK (COALESCE(
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
      OR (rollback_evidence->>'status' = 'available' AND (rollback_evidence->>'providerDeploymentId') ~ '^dpl_[A-Za-z0-9]+$' AND (rollback_evidence->>'deploymentUrl') ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9]\.vercel\.app/$')
    )
    AND status IN ('review_pending', 'releasing', 'building', 'healthy', 'incomplete', 'failed', 'expired')
    AND (provider_project_id IS NULL OR provider_project_id ~ '^prj_[A-Za-z0-9]+$')
    AND (provider_deployment_id IS NULL OR provider_deployment_id ~ '^dpl_[A-Za-z0-9]+$')
    AND (provider_state IS NULL OR char_length(provider_state) BETWEEN 1 AND 40)
    AND (deployment_url IS NULL OR deployment_url ~ '^https://[a-z0-9][a-z0-9-]*[a-z0-9]\.vercel\.app/$')
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
  , FALSE))
);

CREATE INDEX omni_app_builder_releases_owner_time_idx
ON public.omni_app_builder_releases (tenant_id, owner_actor_id, session_id, created_at DESC, id);

ALTER TABLE public.omni_app_builder_events DROP CONSTRAINT omni_app_builder_events_row_check;
ALTER TABLE public.omni_app_builder_events ADD CONSTRAINT omni_app_builder_events_row_check CHECK (COALESCE(
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
    'app_builder.deployment.preview_incomplete', 'app_builder.deployment.preview_failed',
    'app_builder.release.review_prepared', 'app_builder.release.production_queued',
    'app_builder.release.production_healthy', 'app_builder.release.production_incomplete',
    'app_builder.release.production_failed'
  )
  AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
  AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND occurred_at <= NOW() + INTERVAL '30 seconds'
, FALSE));

ALTER TABLE public.omni_app_builder_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_app_builder_releases_actor_scope ON public.omni_app_builder_releases
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));
REVOKE ALL ON public.omni_app_builder_releases FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_releases TO omni_runtime;
    GRANT UPDATE (status, provider_project_id, provider_deployment_id, provider_state, deployment_url, logs, route_evidence, browser_evidence, failure_code, updated_at, released_at) ON public.omni_app_builder_releases TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_releases TO omni_maintenance;
    GRANT UPDATE (status, provider_project_id, provider_deployment_id, provider_state, deployment_url, logs, route_evidence, browser_evidence, failure_code, updated_at, released_at) ON public.omni_app_builder_releases TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_releases TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_app_builder_releases'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.omni_app_builder_releases'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder production release isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;
`;
