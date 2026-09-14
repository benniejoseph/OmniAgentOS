BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 168 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 168 AND name = 'app_builder_recovery_v1'
      AND checksum = '5817c2ae6209f9344439fd536fef3551ed6adca4cafb2811810eaf9ffc6cfd82'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder verification predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_app_builder_verifications (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  checks JSONB NOT NULL,
  browser_evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_app_builder_verifications_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_app_builder_verifications_actor_key UNIQUE (tenant_id, id, owner_actor_id),
  CONSTRAINT omni_app_builder_verifications_session_fkey FOREIGN KEY (tenant_id, session_id, owner_actor_id)
    REFERENCES public.omni_app_builder_sessions (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_verifications_checkpoint_fkey FOREIGN KEY (tenant_id, checkpoint_id, owner_actor_id)
    REFERENCES public.omni_app_builder_checkpoints (tenant_id, id, owner_actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_app_builder_verifications_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_verification_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND checkpoint_id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
    AND contract_version = 'app-builder-verification:1'
    AND workspace_sha256 ~ '^[a-f0-9]{64}$'
    AND status IN ('passed', 'failed', 'incomplete')
    AND jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) = 2 AND pg_column_size(checks) <= 16384
    AND jsonb_typeof(browser_evidence) = 'object' AND pg_column_size(browser_evidence) <= 16384
    AND created_at <= NOW() + INTERVAL '30 seconds'
  , FALSE))
);

CREATE INDEX omni_app_builder_verifications_owner_time_idx
ON public.omni_app_builder_verifications (tenant_id, owner_actor_id, session_id, created_at DESC, id);

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
      'app_builder.verification.completed', 'app_builder.sentinel.reviewed'
    )
    AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
    AND payload_sha256 ~ '^[a-f0-9]{64}$'
    AND occurred_at <= NOW() + INTERVAL '30 seconds'
  , FALSE));

ALTER TABLE public.omni_app_builder_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_app_builder_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_app_builder_verifications_actor_scope ON public.omni_app_builder_verifications
FOR ALL TO PUBLIC
USING (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
WITH CHECK (public.omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id));

REVOKE ALL ON public.omni_app_builder_verifications FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_verifications TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_app_builder_verifications TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_app_builder_verifications TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_app_builder_verifications'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.omni_app_builder_verifications'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder verification isolation boundary is invalid' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (169, 'app_builder_verification_v1', '42d9291da42daf9b4513f4fe9f3221bae4336d2d20074773a96db70135d9d176', clock_timestamp());

COMMIT;
