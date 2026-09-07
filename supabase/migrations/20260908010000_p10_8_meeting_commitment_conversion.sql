BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 135
      AND name = 'resumable_capture_media_v1'
      AND checksum = '6504f48c638bb483fdbeb30a1a6efa72e8d97d2c7bdca4c7a266ff36fc9c7c1c'
  ) <> 1 THEN
    RAISE EXCEPTION 'Meeting commitment predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_meeting_commitment_proposals (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  effective_access_class TEXT NOT NULL,
  meeting_revision_id TEXT NOT NULL,
  media_revision_id TEXT NOT NULL,
  action_item_id TEXT NOT NULL,
  proposal_sha256 TEXT NOT NULL,
  proposal_snapshot JSONB NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, proposal_id),
  UNIQUE (tenant_id, workspace_id, meeting_id, media_revision_id, action_item_id),
  CHECK (meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (proposal_id ~ '^meeting-commitment-proposal:[a-f0-9]{64}$'),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 240),
  CHECK (char_length(project_id) BETWEEN 1 AND 240),
  CHECK (effective_access_class IN ('owner_private', 'project_members', 'workspace_members')),
  CHECK (action_item_id ~ '^media-action:[a-f0-9]{64}$'),
  CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((proposal_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (proposal_snapshot ->> 'tenantId' = tenant_id),
  CHECK (proposal_snapshot ->> 'workspaceId' = workspace_id),
  CHECK (proposal_snapshot ->> 'meetingId' = meeting_id),
  CHECK (proposal_snapshot ->> 'proposalId' = proposal_id),
  CHECK (proposal_snapshot ->> 'projectId' = project_id),
  CHECK (proposal_snapshot ->> 'meetingRevisionId' = meeting_revision_id),
  CHECK (proposal_snapshot ->> 'mediaRevisionId' = media_revision_id),
  CHECK (proposal_snapshot ->> 'actionItemId' = action_item_id),
  CHECK (proposal_snapshot ->> 'proposalSha256' = proposal_sha256),
  CHECK (proposal_snapshot ->> 'proposedByActorId' = owner_actor_id)
);

CREATE TABLE omni_meeting_commitment_resolutions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  resolution_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  effective_access_class TEXT NOT NULL,
  proposal_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL,
  work_item_id TEXT,
  draft_id TEXT,
  resolution_sha256 TEXT NOT NULL,
  resolution_snapshot JSONB NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, proposal_id),
  UNIQUE (tenant_id, workspace_id, resolution_id),
  FOREIGN KEY (tenant_id, workspace_id, proposal_id)
    REFERENCES omni_meeting_commitment_proposals (
      tenant_id, workspace_id, proposal_id
    ) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK (meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (proposal_id ~ '^meeting-commitment-proposal:[a-f0-9]{64}$'),
  CHECK (resolution_id ~ '^meeting-commitment-resolution:[a-f0-9]{64}$'),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 240),
  CHECK (char_length(project_id) BETWEEN 1 AND 240),
  CHECK (effective_access_class IN ('owner_private', 'project_members', 'workspace_members')),
  CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (decision IN ('confirmed', 'dismissed')),
  CHECK ((decision = 'confirmed') = (work_item_id IS NOT NULL)),
  CHECK (draft_id IS NULL OR draft_id ~ '^message_draft:[0-9a-f-]{36}$'),
  CHECK (resolution_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((resolution_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (resolution_snapshot ->> 'proposalId' = proposal_id),
  CHECK (resolution_snapshot ->> 'resolutionId' = resolution_id),
  CHECK (resolution_snapshot ->> 'proposalSha256' = proposal_sha256),
  CHECK (resolution_snapshot ->> 'decision' = decision),
  CHECK (resolution_snapshot ->> 'resolutionSha256' = resolution_sha256),
  CHECK (resolution_snapshot ->> 'resolvedByActorId' = owner_actor_id),
  CHECK (resolution_snapshot ->> 'workItemId' IS NOT DISTINCT FROM work_item_id),
  CHECK (resolution_snapshot ->> 'draftId' IS NOT DISTINCT FROM draft_id)
);

CREATE INDEX omni_meeting_commitment_proposals_meeting_idx
  ON omni_meeting_commitment_proposals (
    tenant_id, workspace_id, meeting_id, proposed_at, proposal_id
  );
CREATE INDEX omni_meeting_commitment_resolutions_effect_idx
  ON omni_meeting_commitment_resolutions (
    tenant_id, work_item_id, draft_id
  ) WHERE decision = 'confirmed';

CREATE FUNCTION omni_protect_meeting_commitment_evidence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Meeting commitment evidence is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER omni_meeting_commitment_proposals_immutable
  BEFORE UPDATE OR DELETE ON omni_meeting_commitment_proposals
  FOR EACH ROW EXECUTE FUNCTION omni_protect_meeting_commitment_evidence_v1();
CREATE TRIGGER omni_meeting_commitment_proposals_no_truncate
  BEFORE TRUNCATE ON omni_meeting_commitment_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_meeting_commitment_evidence_v1();
CREATE TRIGGER omni_meeting_commitment_resolutions_immutable
  BEFORE UPDATE OR DELETE ON omni_meeting_commitment_resolutions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_meeting_commitment_evidence_v1();
CREATE TRIGGER omni_meeting_commitment_resolutions_no_truncate
  BEFORE TRUNCATE ON omni_meeting_commitment_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_meeting_commitment_evidence_v1();

ALTER TABLE omni_meeting_commitment_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_meeting_commitment_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_meeting_commitment_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_meeting_commitment_resolutions FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_meeting_commitment_proposals
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_meeting_commitment_resolutions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_meeting_commitment_proposals_read_scope
  ON omni_meeting_commitment_proposals AS RESTRICTIVE FOR SELECT
  USING (omni_meeting_access_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));
CREATE POLICY omni_meeting_commitment_proposals_insert_scope
  ON omni_meeting_commitment_proposals AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));
CREATE POLICY omni_meeting_commitment_resolutions_read_scope
  ON omni_meeting_commitment_resolutions AS RESTRICTIVE FOR SELECT
  USING (omni_meeting_access_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));
CREATE POLICY omni_meeting_commitment_resolutions_insert_scope
  ON omni_meeting_commitment_resolutions AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));

REVOKE ALL ON FUNCTION omni_protect_meeting_commitment_evidence_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_meeting_commitment_proposals,
      omni_meeting_commitment_resolutions FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_meeting_commitment_proposals,
      omni_meeting_commitment_resolutions TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_meeting_commitment_proposals,
      omni_meeting_commitment_resolutions TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_meeting_commitment_proposals,
      omni_meeting_commitment_resolutions TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_meeting_commitment_proposals'::regclass
      AND tgname = 'omni_meeting_commitment_proposals_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_meeting_commitment_proposals'::regclass
      AND polname = 'omni_meeting_commitment_proposals_read_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_meeting_commitment_resolutions'::regclass
      AND polname = 'omni_meeting_commitment_resolutions_insert_scope'
      AND NOT polpermissive
  ) THEN
    RAISE EXCEPTION 'Meeting commitment conversion schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  136,
  'meeting_commitment_conversion_v1',
  'ab838fcbc59a03d497e77b256e2d7f0e85bd5576ac4fa9980434b764fb9765be',
  clock_timestamp()
);

COMMIT;
