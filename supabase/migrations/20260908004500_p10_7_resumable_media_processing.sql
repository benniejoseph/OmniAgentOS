BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 134
      AND name = 'meeting_domain_v1'
      AND checksum = '2dd5db3415b794678d2dcfff211e0621623e66b814b8ac166058ab2737fb3c56'
  ) <> 1 THEN
    RAISE EXCEPTION 'Media processing predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_capture_segments
  ALTER COLUMN audio_data DROP NOT NULL,
  ADD COLUMN media_transcript JSONB,
  ADD COLUMN media_transcript_sha256 TEXT,
  ADD COLUMN detected_language_tags TEXT[],
  ADD COLUMN media_transcribed_at TIMESTAMPTZ,
  ADD COLUMN raw_audio_deleted_at TIMESTAMPTZ;

ALTER TABLE omni_capture_segments
  ADD CONSTRAINT omni_capture_segments_media_transcript_check CHECK (
    (media_transcript IS NULL) = (media_transcript_sha256 IS NULL)
    AND (media_transcript IS NULL) = (detected_language_tags IS NULL)
    AND (media_transcript IS NULL) = (media_transcribed_at IS NULL)
    AND (
      media_transcript IS NULL
      OR (
        media_transcript_sha256 ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(media_transcript) = 'object'
        AND jsonb_typeof(media_transcript -> 'turns') = 'array'
        AND cardinality(detected_language_tags) BETWEEN 1 AND 24
      )
    )
  ),
  ADD CONSTRAINT omni_capture_segments_raw_audio_check CHECK (
    (audio_data IS NULL) = (raw_audio_deleted_at IS NOT NULL)
  );

CREATE TABLE omni_capture_media_revisions (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  media_revision INTEGER NOT NULL,
  media_revision_id TEXT NOT NULL,
  meeting_id TEXT,
  source_audio_manifest_sha256 TEXT NOT NULL,
  output_sha256 TEXT NOT NULL,
  output_snapshot JSONB NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, recording_id, media_revision),
  UNIQUE (tenant_id, owner_actor_id, media_revision_id),
  CHECK (char_length(recording_id) BETWEEN 1 AND 200),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (media_revision >= 1),
  CHECK (media_revision_id = recording_id || ':media:v' || media_revision::TEXT),
  CHECK (meeting_id IS NULL OR meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (source_audio_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (output_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((output_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (output_snapshot ->> 'tenantId' = tenant_id),
  CHECK (output_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (output_snapshot ->> 'recordingId' = recording_id),
  CHECK ((output_snapshot ->> 'mediaRevision')::INTEGER = media_revision),
  CHECK (output_snapshot ->> 'mediaRevisionId' = media_revision_id),
  CHECK (output_snapshot ->> 'sourceAudioManifestSha256' = source_audio_manifest_sha256),
  CHECK (output_snapshot ->> 'outputSha256' = output_sha256),
  CHECK (owner_actor_id = created_by_actor_id)
);

CREATE TABLE omni_capture_media_heads (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  meeting_id TEXT,
  processing_status TEXT NOT NULL,
  processing_generation BIGINT NOT NULL,
  operation_job_id TEXT NOT NULL,
  current_media_revision INTEGER,
  current_media_revision_id TEXT,
  source_audio_manifest_sha256 TEXT,
  output_sha256 TEXT,
  output_snapshot JSONB,
  raw_audio_retention_mode TEXT NOT NULL,
  raw_audio_retain_until TIMESTAMPTZ,
  raw_audio_deleted_at TIMESTAMPTZ,
  last_error_sha256 TEXT,
  created_by_actor_id TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, recording_id),
  FOREIGN KEY (
    tenant_id, owner_actor_id, recording_id, current_media_revision
  ) REFERENCES omni_capture_media_revisions (
    tenant_id, owner_actor_id, recording_id, media_revision
  ) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK (char_length(recording_id) BETWEEN 1 AND 200),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (meeting_id IS NULL OR meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (processing_status IN ('queued', 'processing', 'waiting', 'ready', 'failed')),
  CHECK (processing_generation >= 1),
  CHECK (char_length(operation_job_id) BETWEEN 1 AND 200),
  CHECK (
    (current_media_revision IS NULL) = (current_media_revision_id IS NULL)
    AND (current_media_revision IS NULL) = (source_audio_manifest_sha256 IS NULL)
    AND (current_media_revision IS NULL) = (output_sha256 IS NULL)
    AND (current_media_revision IS NULL) = (output_snapshot IS NULL)
    AND (
      current_media_revision IS NULL
      OR (
        current_media_revision >= 1
        AND current_media_revision_id = recording_id || ':media:v' || current_media_revision::TEXT
        AND source_audio_manifest_sha256 ~ '^[a-f0-9]{64}$'
        AND output_sha256 ~ '^[a-f0-9]{64}$'
        AND output_snapshot ->> 'outputSha256' = output_sha256
      )
    )
  ),
  CHECK (processing_status <> 'ready' OR current_media_revision IS NOT NULL),
  CHECK (raw_audio_retention_mode IN ('retain', 'delete_after_processing')),
  CHECK (
    (raw_audio_retention_mode = 'delete_after_processing' AND raw_audio_retain_until IS NULL)
    OR raw_audio_retention_mode = 'retain'
  ),
  CHECK (last_error_sha256 IS NULL OR last_error_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (owner_actor_id = created_by_actor_id),
  CHECK (created_at <= updated_at)
);

CREATE INDEX omni_capture_media_revisions_recording_idx
  ON omni_capture_media_revisions (
    tenant_id, owner_actor_id, recording_id, media_revision DESC
  );
CREATE INDEX omni_capture_media_heads_status_idx
  ON omni_capture_media_heads (
    tenant_id, processing_status, updated_at, recording_id
  );

CREATE FUNCTION omni_protect_capture_media_revision_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Capture media revisions are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_protect_capture_media_head_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Capture media processing heads cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_generation <> 1
      OR NEW.owner_actor_id <> NEW.created_by_actor_id
      OR NEW.created_by_actor_id <> NEW.updated_by_actor_id
      OR NEW.created_at <> NEW.updated_at
    THEN
      RAISE EXCEPTION 'Initial capture media processing head is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.tenant_id <> NEW.tenant_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.recording_id <> NEW.recording_id
    OR OLD.created_by_actor_id <> NEW.created_by_actor_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.processing_generation <> OLD.processing_generation + 1
    OR COALESCE(NEW.current_media_revision, 0) < COALESCE(OLD.current_media_revision, 0)
    OR (OLD.raw_audio_deleted_at IS NOT NULL AND NEW.raw_audio_deleted_at <> OLD.raw_audio_deleted_at)
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'Capture media processing transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_capture_media_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_capture_media_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_capture_media_revision_v1();
CREATE TRIGGER omni_capture_media_revisions_no_truncate
  BEFORE TRUNCATE ON omni_capture_media_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_capture_media_revision_v1();
CREATE TRIGGER omni_capture_media_heads_protected
  BEFORE INSERT OR UPDATE OR DELETE ON omni_capture_media_heads
  FOR EACH ROW EXECUTE FUNCTION omni_protect_capture_media_head_v1();
CREATE TRIGGER omni_capture_media_heads_no_truncate
  BEFORE TRUNCATE ON omni_capture_media_heads
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_capture_media_head_v1();

ALTER TABLE omni_capture_media_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_capture_media_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_capture_media_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_capture_media_heads FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_capture_media_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_capture_media_heads
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_capture_media_revisions_actor_scope
  ON omni_capture_media_revisions AS RESTRICTIVE FOR ALL
  USING (
    omni_system_scope_enabled()
    OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  )
  WITH CHECK (
    omni_system_scope_enabled()
    OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  );
CREATE POLICY omni_capture_media_heads_actor_scope
  ON omni_capture_media_heads AS RESTRICTIVE FOR ALL
  USING (
    omni_system_scope_enabled()
    OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  )
  WITH CHECK (
    omni_system_scope_enabled()
    OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
  );

REVOKE ALL ON FUNCTION omni_protect_capture_media_revision_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_capture_media_head_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_capture_media_revisions,
      omni_capture_media_heads FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_capture_media_revisions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_capture_media_heads TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_capture_media_revisions TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_capture_media_heads TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_capture_media_revisions,
      omni_capture_media_heads TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_capture_media_revisions'::regclass
      AND tgname = 'omni_capture_media_revisions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_capture_media_heads'::regclass
      AND polname = 'omni_capture_media_heads_actor_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_capture_segments'::regclass
      AND conname = 'omni_capture_segments_raw_audio_check'
  ) THEN
    RAISE EXCEPTION 'Resumable capture media schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  135,
  'resumable_capture_media_v1',
  '6504f48c638bb483fdbeb30a1a6efa72e8d97d2c7bdca4c7a266ff36fc9c7c1c',
  clock_timestamp()
);

COMMIT;
