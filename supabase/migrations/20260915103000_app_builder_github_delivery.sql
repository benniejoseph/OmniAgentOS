BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 169 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 169 AND name = 'app_builder_verification_v1'
      AND checksum = '42d9291da42daf9b4513f4fe9f3221bae4336d2d20074773a96db70135d9d176'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder GitHub delivery predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_app_builder_repository_bindings (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  is_private BOOLEAN NOT NULL,
  default_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_app_builder_repository_bindings_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_repository_bindings_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_repository_bindings_session_key UNIQUE (tenant_id, owner_actor_id, session_id),
  CONSTRAINT omni_app_builder_repository_bindings_session_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_repository_bindings_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_repository_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND contract_version = 'app-builder-repository:1'
    AND repository_id ~ '^[0-9]{1,24}$'
    AND char_length(btrim(repository_owner)) BETWEEN 1 AND 100
    AND char_length(btrim(repository_name)) BETWEEN 1 AND 100
    AND repository_full_name = repository_owner || '/' || repository_name
    AND char_length(btrim(default_branch)) BETWEEN 1 AND 120
    AND base_sha ~ '^[a-f0-9]{40,64}$'
    AND revision > 0
    AND bound_at <= updated_at
    AND updated_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_app_builder_repository_bindings_owner_time_idx
ON public.omni_app_builder_repository_bindings (tenant_id, owner_actor_id, updated_at DESC, id);

CREATE TABLE public.omni_app_builder_deliveries (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  commit_sha TEXT,
  pull_request_number INTEGER,
  pull_request_url TEXT,
  secret_scan_sha256 TEXT NOT NULL,
  secret_finding_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_app_builder_deliveries_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_deliveries_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_deliveries_binding_fkey FOREIGN KEY (tenant_id, repository_binding_id, owner_actor_id)
    REFERENCES public.omni_app_builder_repository_bindings (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deliveries_session_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deliveries_checkpoint_fkey FOREIGN KEY (tenant_id, checkpoint_id, owner_actor_id)
    REFERENCES public.omni_app_builder_checkpoints (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deliveries_verification_fkey FOREIGN KEY (tenant_id, verification_id, owner_actor_id)
    REFERENCES public.omni_app_builder_verifications (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_deliveries_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_delivery_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND repository_binding_id ~ '^app_build_repository_[a-f0-9]{48}$'
    AND contract_version = 'app-builder-delivery:1'
    AND checkpoint_id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
    AND verification_id ~ '^app_build_verification_[a-f0-9]{48}$'
    AND workspace_sha256 ~ '^[a-f0-9]{64}$'
    AND base_sha ~ '^[a-f0-9]{40,64}$'
    AND char_length(btrim(branch_name)) BETWEEN 1 AND 120
    AND (commit_sha IS NULL OR commit_sha ~ '^[a-f0-9]{40,64}$')
    AND (pull_request_number IS NULL OR pull_request_number > 0)
    AND (pull_request_url IS NULL OR pull_request_url LIKE 'https://github.com/%')
    AND secret_scan_sha256 ~ '^[a-f0-9]{64}$'
    AND secret_finding_count BETWEEN 0 AND 5000
    AND status IN ('preparing', 'pull_request_open', 'failed')
    AND (failure_code IS NULL OR failure_code ~ '^github_[a-f0-9]{12}$')
    AND (
      (status = 'preparing' AND commit_sha IS NULL AND pull_request_number IS NULL AND pull_request_url IS NULL AND failure_code IS NULL)
      OR (status = 'pull_request_open' AND commit_sha IS NOT NULL AND pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND pull_request_number IS NULL AND pull_request_url IS NULL AND failure_code IS NOT NULL)
    )
    AND created_at <= updated_at
    AND updated_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_app_builder_deliveries_owner_time_idx
ON public.omni_app_builder_deliveries (tenant_id, owner_actor_id, session_id, created_at DESC, id);

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
      'app_builder.delivery.pull_request_open', 'app_builder.delivery.failed'
    )
    AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
    AND payload_sha256 ~ '^[a-f0-9]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE));

ALTER TABLE public.omni_app_builder_repository_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_repository_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_app_builder_repository_bindings_actor_scope ON public.omni_app_builder_repository_bindings
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

CREATE POLICY omni_app_builder_deliveries_actor_scope ON public.omni_app_builder_deliveries
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

REVOKE ALL ON public.omni_app_builder_repository_bindings, public.omni_app_builder_deliveries FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON public.omni_app_builder_repository_bindings TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_app_builder_deliveries TO omni_runtime;
    GRANT UPDATE (status, commit_sha, pull_request_number, pull_request_url, failure_code, updated_at)
      ON public.omni_app_builder_deliveries TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT, UPDATE ON public.omni_app_builder_repository_bindings TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_app_builder_deliveries TO omni_maintenance;
    GRANT UPDATE (status, commit_sha, pull_request_number, pull_request_url, failure_code, updated_at)
      ON public.omni_app_builder_deliveries TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_repository_bindings, public.omni_app_builder_deliveries TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class
    WHERE oid IN (
      'public.omni_app_builder_repository_bindings'::regclass,
      'public.omni_app_builder_deliveries'::regclass
    ) AND relrowsecurity AND relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_app_builder_repository_bindings'::regclass,
      'public.omni_app_builder_deliveries'::regclass
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'App Builder GitHub delivery isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (170, 'app_builder_github_delivery_v1', '7d1f8e773faa0de1e8a5ac7a58ffb79a236a79504932fc757ee4cfbfbf796e7f', clock_timestamp());

COMMIT;
