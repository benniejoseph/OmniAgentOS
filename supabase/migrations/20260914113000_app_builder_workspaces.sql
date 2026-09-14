BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 166 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 166 AND name = 'market_analysis_versions_v1'
      AND checksum = 'ee55253b32cf5838ac8e37a5a4e969e314c82fd2190be7a397e5d2a64eb4b232'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_model_assignments
  DROP CONSTRAINT IF EXISTS omni_model_assignments_scope_check;
ALTER TABLE public.omni_model_assignments
  ADD CONSTRAINT omni_model_assignments_scope_check CHECK (scope IN (
    'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
    'market_research', 'code_builder', 'memory', 'embeddings', 'vision',
    'audio', 'audio_diarization', 'web_search', 'image_generation',
    'video_generation', 'computer_use', 'speech_synthesis',
    'realtime_transcription'
  ));

ALTER TABLE public.omni_ai_usage
  DROP CONSTRAINT IF EXISTS omni_ai_usage_assignment_receipt_check;
ALTER TABLE public.omni_ai_usage
  ADD CONSTRAINT omni_ai_usage_assignment_receipt_check CHECK (
    (
      assignment_scope IS NULL AND assignment_revision IS NULL
      AND assignment_configuration_sha256 IS NULL
    ) OR (
      assignment_id IS NOT NULL
      AND assignment_scope IN (
        'main_agent', 'orchestrator', 'planner', 'verifier', 'council',
        'market_research', 'code_builder', 'memory', 'embeddings', 'vision',
        'audio', 'audio_diarization', 'web_search', 'image_generation',
        'video_generation', 'computer_use', 'speech_synthesis',
        'realtime_transcription'
      )
      AND assignment_revision > 0
      AND assignment_configuration_sha256 ~ '^[a-f0-9]{64}$'
      AND credential_source = 'tenant_vault'
    )
  );

CREATE TABLE public.omni_app_builder_sessions (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  template_id TEXT NOT NULL,
  sandbox_name TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  CONSTRAINT omni_app_builder_sessions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_sessions_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_sessions_project_key UNIQUE (tenant_id, owner_actor_id, project_id),
  CONSTRAINT omni_app_builder_sessions_sandbox_key UNIQUE (sandbox_name),
  CONSTRAINT omni_app_builder_sessions_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND contract_version = 'app-builder-session:1'
    AND template_id = 'nextjs-starter-v1'
    AND sandbox_name ~ '^asael-[a-f0-9]{28}$'
    AND status IN ('provisioning', 'ready', 'running', 'failed', 'stopped')
    AND revision > 0
    AND (last_error_code IS NULL OR last_error_code ~ '^builder_[a-f0-9]{12}$')
    AND created_at <= updated_at
    AND updated_at <= NOW() + INTERVAL '30 seconds'
    AND ((status = 'stopped' AND stopped_at IS NOT NULL) OR (status <> 'stopped' AND stopped_at IS NULL))
  , FALSE))
);

CREATE INDEX omni_app_builder_sessions_owner_time_idx
ON public.omni_app_builder_sessions (tenant_id, owner_actor_id, updated_at DESC, id);

CREATE TABLE public.omni_app_builder_events (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_app_builder_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_events_parent_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_events_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_event_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND event_type IN (
      'app_builder.session.provisioning_started', 'app_builder.session.ready',
      'app_builder.session.failed', 'app_builder.session.stopped',
      'app_builder.file.updated', 'app_builder.command.completed'
    )
    AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
    AND payload_sha256 ~ '^[a-f0-9]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_app_builder_events_owner_time_idx
ON public.omni_app_builder_events (tenant_id, owner_actor_id, session_id, occurred_at DESC, id);

ALTER TABLE public.omni_app_builder_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_events FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_app_builder_sessions_actor_scope ON public.omni_app_builder_sessions
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

CREATE POLICY omni_app_builder_events_actor_scope ON public.omni_app_builder_events
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

REVOKE ALL ON public.omni_app_builder_sessions FROM PUBLIC;
REVOKE ALL ON public.omni_app_builder_events FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON public.omni_app_builder_sessions TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_app_builder_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT, UPDATE ON public.omni_app_builder_sessions TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_app_builder_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_sessions, public.omni_app_builder_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class
    WHERE oid IN ('public.omni_app_builder_sessions'::regclass, 'public.omni_app_builder_events'::regclass)
      AND relrowsecurity AND relforcerowsecurity
  ) <> 2 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN ('public.omni_app_builder_sessions'::regclass, 'public.omni_app_builder_events'::regclass)
  ) <> 2 THEN
    RAISE EXCEPTION 'App Builder isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (167, 'app_builder_workspaces_v1', 'df930dd3d4221b175bcabcbe4670c200798568f95c91a1c04537d509a3b0133c', clock_timestamp());

COMMIT;
