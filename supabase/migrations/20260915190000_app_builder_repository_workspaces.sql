BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 173 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 173 AND name = 'app_builder_deployment_url_constraint_repair_v1'
      AND checksum = 'a41d2d82ad95d8402b182f8136f9bee67133d2380f246605c803915838c7da8e'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder repository workspace predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_app_builder_checkpoints DROP CONSTRAINT omni_app_builder_checkpoints_row_check;
ALTER TABLE public.omni_app_builder_checkpoints ADD CONSTRAINT omni_app_builder_checkpoints_row_check CHECK (COALESCE(
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

DO $verify$
BEGIN
  IF position('10000' IN pg_get_constraintdef(
    (SELECT oid FROM pg_constraint WHERE conrelid = 'public.omni_app_builder_checkpoints'::regclass AND conname = 'omni_app_builder_checkpoints_row_check')
  )) = 0 OR position('app_builder.repository.checked_out' IN pg_get_constraintdef(
    (SELECT oid FROM pg_constraint WHERE conrelid = 'public.omni_app_builder_events'::regclass AND conname = 'omni_app_builder_events_row_check')
  )) = 0 THEN
    RAISE EXCEPTION 'App Builder repository workspace constraints are invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (174, 'app_builder_repository_workspaces_v1', '30f4769a6fcccd41aa457882b6be2752583d7d5920be75597e3b2121e91604d0', clock_timestamp());

COMMIT;
