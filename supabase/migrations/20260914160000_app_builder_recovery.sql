BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 167 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 167 AND name = 'app_builder_workspaces_v1'
      AND checksum = 'df930dd3d4221b175bcabcbe4670c200798568f95c91a1c04537d509a3b0133c'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder recovery predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_app_builder_sessions
  ADD COLUMN current_checkpoint_id TEXT;
ALTER TABLE public.omni_app_builder_sessions
  DROP CONSTRAINT omni_app_builder_sessions_row_check;
ALTER TABLE public.omni_app_builder_sessions
  ADD CONSTRAINT omni_app_builder_sessions_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND contract_version = 'app-builder-session:1'
    AND template_id = 'nextjs-starter-v1'
    AND sandbox_name ~ '^asael-[a-f0-9]{28}$'
    AND status IN ('provisioning', 'ready', 'running', 'failed', 'stopped')
    AND revision > 0
    AND (current_checkpoint_id IS NULL OR current_checkpoint_id ~ '^app_build_checkpoint_[a-f0-9]{48}$')
    AND (last_error_code IS NULL OR last_error_code ~ '^builder_[a-f0-9]{12}$')
    AND created_at <= updated_at
    AND updated_at <= NOW() + INTERVAL '30 seconds'
    AND ((status = 'stopped' AND stopped_at IS NOT NULL) OR (status <> 'stopped' AND stopped_at IS NULL))
  , FALSE));

CREATE TABLE public.omni_app_builder_checkpoints (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  provider_snapshot_id TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  snapshot_bytes BIGINT NOT NULL,
  reason TEXT NOT NULL,
  label TEXT NOT NULL,
  source_run_id TEXT,
  session_revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  CONSTRAINT omni_app_builder_checkpoints_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_checkpoints_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_checkpoints_parent_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_checkpoints_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND contract_version = 'app-builder-checkpoint:1'
    AND char_length(btrim(provider_snapshot_id)) BETWEEN 1 AND 240
    AND workspace_sha256 ~ '^[a-f0-9]{64}$'
    AND file_count BETWEEN 1 AND 500
    AND snapshot_bytes >= 0
    AND reason IN ('manual', 'before_forge', 'after_forge', 'before_sentinel', 'before_restore')
    AND char_length(btrim(label)) BETWEEN 1 AND 120
    AND (source_run_id IS NULL OR char_length(btrim(source_run_id)) BETWEEN 1 AND 240)
    AND session_revision > 0
    AND created_at <= NOW() + INTERVAL '30 seconds'
    AND (expires_at IS NULL OR expires_at > created_at)
  , FALSE))
);

CREATE INDEX omni_app_builder_checkpoints_owner_time_idx
ON public.omni_app_builder_checkpoints (tenant_id, owner_actor_id, session_id, created_at DESC, id);

ALTER TABLE public.omni_app_builder_sessions
  ADD CONSTRAINT omni_app_builder_sessions_current_checkpoint_fkey
  FOREIGN KEY (tenant_id, current_checkpoint_id, owner_actor_id)
  REFERENCES public.omni_app_builder_checkpoints (tenant_id, id, owner_actor_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

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
      'app_builder.checkpoint.created', 'app_builder.checkpoint.restored'
    )
    AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
    AND payload_sha256 ~ '^[a-f0-9]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE));

ALTER TABLE public.omni_app_builder_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_app_builder_checkpoints_actor_scope ON public.omni_app_builder_checkpoints
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

REVOKE ALL ON public.omni_app_builder_checkpoints FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_checkpoints TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_checkpoints TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_checkpoints TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_app_builder_checkpoints'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.omni_app_builder_checkpoints'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder checkpoint isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (168, 'app_builder_recovery_v1', '5817c2ae6209f9344439fd536fef3551ed6adca4cafb2811810eaf9ffc6cfd82', clock_timestamp());

COMMIT;
