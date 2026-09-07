BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 133
      AND name = 'canonical_actor_scope_repair_v1'
      AND checksum = 'f700debf165e44134b59e46fdfc258a4fb9e51a7158adfb26760c77acff45678'
  ) <> 1 THEN
    RAISE EXCEPTION 'Meeting domain predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_meeting_revisions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  meeting_revision INTEGER NOT NULL,
  meeting_revision_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT,
  effective_access_class TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  consent_snapshot_sha256 TEXT NOT NULL,
  meeting_sha256 TEXT NOT NULL,
  meeting_snapshot JSONB NOT NULL,
  mutation_idempotency_sha256 TEXT NOT NULL,
  mutation_request_sha256 TEXT NOT NULL,
  revised_by_actor_id TEXT NOT NULL,
  revised_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, meeting_id, meeting_revision),
  UNIQUE (tenant_id, workspace_id, meeting_revision_id),
  UNIQUE (tenant_id, workspace_id, revised_by_actor_id, mutation_idempotency_sha256),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, project_id)
    REFERENCES omni_work_projects (tenant_id, workspace_id, project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (revised_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (meeting_revision >= 1),
  CHECK (meeting_revision_id = meeting_id || ':v' || meeting_revision::TEXT),
  CHECK (effective_access_class IN (
    'owner_private', 'project_members', 'workspace_members'
  )),
  CHECK (effective_access_class <> 'project_members' OR project_id IS NOT NULL),
  CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  CHECK (scheduled_end_at > scheduled_start_at),
  CHECK (consent_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (meeting_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (mutation_idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (mutation_request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((meeting_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (meeting_snapshot ->> 'tenantId' = tenant_id),
  CHECK (meeting_snapshot ->> 'workspaceId' = workspace_id),
  CHECK (meeting_snapshot ->> 'meetingId' = meeting_id),
  CHECK ((meeting_snapshot ->> 'revision')::INTEGER = meeting_revision),
  CHECK (meeting_snapshot ->> 'meetingRevisionId' = meeting_revision_id),
  CHECK (meeting_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (meeting_snapshot ->> 'effectiveAccessClass' = effective_access_class),
  CHECK (meeting_snapshot ->> 'status' = status),
  CHECK (meeting_snapshot ->> 'consentSnapshotSha256' = consent_snapshot_sha256),
  CHECK (meeting_snapshot ->> 'meetingSha256' = meeting_sha256),
  CHECK (meeting_snapshot ->> 'revisedByActorId' = revised_by_actor_id)
);

CREATE TABLE omni_meetings (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  project_id TEXT,
  effective_access_class TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  current_revision INTEGER NOT NULL,
  current_revision_id TEXT NOT NULL,
  consent_snapshot_sha256 TEXT NOT NULL,
  meeting_sha256 TEXT NOT NULL,
  meeting_snapshot JSONB NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, meeting_id),
  FOREIGN KEY (
    tenant_id, workspace_id, meeting_id, current_revision
  ) REFERENCES omni_meeting_revisions (
    tenant_id, workspace_id, meeting_id, meeting_revision
  ) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (tenant_id, workspace_id, project_id)
    REFERENCES omni_work_projects (tenant_id, workspace_id, project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (meeting_id ~ '^meeting:[0-9a-f-]{36}$'),
  CHECK (current_revision >= 1),
  CHECK (current_revision_id = meeting_id || ':v' || current_revision::TEXT),
  CHECK (effective_access_class IN (
    'owner_private', 'project_members', 'workspace_members'
  )),
  CHECK (effective_access_class <> 'project_members' OR project_id IS NOT NULL),
  CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  CHECK (scheduled_end_at > scheduled_start_at),
  CHECK (consent_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (meeting_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (updated_at >= created_at),
  CHECK (owner_actor_id = created_by_actor_id),
  CHECK ((meeting_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (meeting_snapshot ->> 'tenantId' = tenant_id),
  CHECK (meeting_snapshot ->> 'workspaceId' = workspace_id),
  CHECK (meeting_snapshot ->> 'meetingId' = meeting_id),
  CHECK ((meeting_snapshot ->> 'revision')::INTEGER = current_revision),
  CHECK (meeting_snapshot ->> 'meetingRevisionId' = current_revision_id),
  CHECK (meeting_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (meeting_snapshot ->> 'effectiveAccessClass' = effective_access_class),
  CHECK (meeting_snapshot ->> 'status' = status),
  CHECK (meeting_snapshot ->> 'consentSnapshotSha256' = consent_snapshot_sha256),
  CHECK (meeting_snapshot ->> 'meetingSha256' = meeting_sha256),
  CHECK (meeting_snapshot ->> 'revisedByActorId' = updated_by_actor_id)
);

CREATE INDEX omni_meetings_schedule_idx
  ON omni_meetings (tenant_id, workspace_id, scheduled_start_at DESC, meeting_id);
CREATE INDEX omni_meetings_project_idx
  ON omni_meetings (tenant_id, workspace_id, project_id, scheduled_start_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX omni_meeting_revisions_history_idx
  ON omni_meeting_revisions (
    tenant_id, workspace_id, meeting_id, meeting_revision DESC
  );

CREATE FUNCTION omni_meeting_access_v1_allows(
  row_tenant_id TEXT,
  row_workspace_id TEXT,
  row_project_id TEXT,
  row_owner_actor_id TEXT,
  row_access_class TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    public.omni_system_scope_enabled()
    OR CASE row_access_class
      WHEN 'owner_private' THEN
        public.omni_actor_scope_v1_allows_canonical(
          row_tenant_id, row_owner_actor_id
        )
      WHEN 'workspace_members' THEN EXISTS (
        SELECT 1
        FROM public.omni_tenant_workspace_memberships membership
        WHERE membership.tenant_id = row_tenant_id
          AND membership.workspace_id = row_workspace_id
          AND membership.subject_kind = 'user'
          AND membership.state = 'active'
          AND public.omni_actor_scope_v1_allows_canonical(
            membership.tenant_id, membership.subject_actor_id
          )
      )
      WHEN 'project_members' THEN EXISTS (
        SELECT 1
        FROM public.omni_work_project_memberships membership
        WHERE membership.tenant_id = row_tenant_id
          AND membership.workspace_id = row_workspace_id
          AND membership.project_id = row_project_id
          AND membership.state = 'active'
          AND public.omni_actor_scope_v1_allows_canonical(
            membership.tenant_id, membership.subject_actor_id
          )
      )
      ELSE FALSE
    END,
    FALSE
  )
$function$;

CREATE FUNCTION omni_meeting_write_v1_allows(
  row_tenant_id TEXT,
  row_workspace_id TEXT,
  row_project_id TEXT,
  row_owner_actor_id TEXT,
  row_access_class TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    public.omni_system_scope_enabled()
    OR (
      public.omni_actor_scope_v1_allows_canonical(
        row_tenant_id, row_owner_actor_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.omni_tenant_workspace_memberships membership
        WHERE membership.tenant_id = row_tenant_id
          AND membership.workspace_id = row_workspace_id
          AND membership.subject_kind = 'user'
          AND membership.subject_actor_id = row_owner_actor_id
          AND membership.access_level IN ('contributor', 'manager')
          AND membership.state = 'active'
      )
      AND (
        row_access_class <> 'project_members'
        OR EXISTS (
          SELECT 1
          FROM public.omni_work_project_memberships membership
          WHERE membership.tenant_id = row_tenant_id
            AND membership.workspace_id = row_workspace_id
            AND membership.project_id = row_project_id
            AND membership.subject_actor_id = row_owner_actor_id
            AND membership.access_level IN ('contributor', 'manager')
            AND membership.state = 'active'
        )
      )
    ),
    FALSE
  )
$function$;

REVOKE ALL ON FUNCTION omni_meeting_access_v1_allows(
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_meeting_write_v1_allows(
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

CREATE FUNCTION omni_protect_meeting_revision_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Meeting revisions are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_protect_meeting_projection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Meeting projections cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision <> 1
      OR NEW.owner_actor_id <> NEW.created_by_actor_id
      OR NEW.created_by_actor_id <> NEW.updated_by_actor_id
      OR NEW.created_at <> NEW.updated_at
    THEN
      RAISE EXCEPTION 'Initial meeting projection is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.meeting_id <> NEW.meeting_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.created_by_actor_id <> NEW.created_by_actor_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.current_revision <> OLD.current_revision + 1
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'Meeting projection transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_meeting_revisions_immutable
  BEFORE UPDATE OR DELETE ON omni_meeting_revisions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_meeting_revision_v1();
CREATE TRIGGER omni_meeting_revisions_no_truncate
  BEFORE TRUNCATE ON omni_meeting_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_meeting_revision_v1();
CREATE TRIGGER omni_meetings_protected
  BEFORE INSERT OR UPDATE OR DELETE ON omni_meetings
  FOR EACH ROW EXECUTE FUNCTION omni_protect_meeting_projection_v1();
CREATE TRIGGER omni_meetings_no_truncate
  BEFORE TRUNCATE ON omni_meetings
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_meeting_projection_v1();

ALTER TABLE omni_meeting_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_meeting_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE omni_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_meetings FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON omni_meeting_revisions
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON omni_meetings
  FOR ALL USING (omni_tenant_visible(tenant_id))
  WITH CHECK (omni_tenant_visible(tenant_id));

CREATE POLICY omni_meetings_read_scope ON omni_meetings
  AS RESTRICTIVE FOR SELECT
  USING (omni_meeting_access_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));
CREATE POLICY omni_meetings_insert_scope ON omni_meetings
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));
CREATE POLICY omni_meetings_update_scope ON omni_meetings
  AS RESTRICTIVE FOR UPDATE
  USING (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ))
  WITH CHECK (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));

CREATE POLICY omni_meeting_revisions_read_scope ON omni_meeting_revisions
  AS RESTRICTIVE FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM omni_meetings meeting
    WHERE meeting.tenant_id = omni_meeting_revisions.tenant_id
      AND meeting.workspace_id = omni_meeting_revisions.workspace_id
      AND meeting.meeting_id = omni_meeting_revisions.meeting_id
      AND omni_meeting_access_v1_allows(
        meeting.tenant_id, meeting.workspace_id, meeting.project_id,
        meeting.owner_actor_id, meeting.effective_access_class
      )
  ));
CREATE POLICY omni_meeting_revisions_insert_scope ON omni_meeting_revisions
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (omni_meeting_write_v1_allows(
    tenant_id, workspace_id, project_id, owner_actor_id,
    effective_access_class
  ));

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION omni_meeting_access_v1_allows(
      TEXT, TEXT, TEXT, TEXT, TEXT
    ) TO omni_runtime;
    GRANT EXECUTE ON FUNCTION omni_meeting_write_v1_allows(
      TEXT, TEXT, TEXT, TEXT, TEXT
    ) TO omni_runtime;
    REVOKE ALL ON TABLE omni_meeting_revisions, omni_meetings FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_meeting_revisions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_meetings TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_meeting_revisions TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_meetings TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_meeting_revisions, omni_meetings TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_meeting_revisions'::regclass
      AND tgname = 'omni_meeting_revisions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_meetings'::regclass
      AND polname = 'omni_meetings_read_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_meeting_revisions'::regclass
      AND polname = 'omni_meeting_revisions_read_scope'
      AND NOT polpermissive
  ) THEN
    RAISE EXCEPTION 'Meeting domain schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  134,
  'meeting_domain_v1',
  '2dd5db3415b794678d2dcfff211e0621623e66b814b8ac166058ab2737fb3c56',
  clock_timestamp()
);

COMMIT;
