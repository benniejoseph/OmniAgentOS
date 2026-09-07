BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 131
      AND name = 'canonical_workspace_resolver_repair_v1'
      AND checksum = '6975f3e4024004198a867620cb5fde2415e031c3b76b9d8e0c7bde24c29998af'
  ) <> 1 THEN
    RAISE EXCEPTION 'Workspace template predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE omni_workspace_template_versions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  template_version_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  template_sha256 TEXT NOT NULL,
  template_snapshot JSONB NOT NULL,
  publish_idempotency_sha256 TEXT NOT NULL,
  publish_request_sha256 TEXT NOT NULL,
  published_by_actor_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, template_id, template_version),
  UNIQUE (tenant_id, workspace_id, template_version_id),
  UNIQUE (tenant_id, workspace_id, owner_actor_id, publish_idempotency_sha256),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (workspace_id ~ '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'),
  CHECK (template_id ~ '^workspace-template:[0-9a-f-]{36}$'),
  CHECK (template_version >= 1),
  CHECK (template_version_id = template_id || ':v' || template_version::TEXT),
  CHECK (length(name) BETWEEN 1 AND 120),
  CHECK (length(description) <= 1000),
  CHECK (template_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (publish_idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (publish_request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((template_snapshot ->> 'schemaVersion')::INTEGER = 1),
  CHECK (template_snapshot ->> 'tenantId' = tenant_id),
  CHECK (template_snapshot ->> 'workspaceId' = workspace_id),
  CHECK (template_snapshot ->> 'templateId' = template_id),
  CHECK ((template_snapshot ->> 'version')::INTEGER = template_version),
  CHECK (template_snapshot ->> 'templateVersionId' = template_version_id),
  CHECK (template_snapshot ->> 'ownerActorId' = owner_actor_id),
  CHECK (template_snapshot ->> 'name' = name),
  CHECK (template_snapshot ->> 'description' = description),
  CHECK (template_snapshot ->> 'templateSha256' = template_sha256),
  CHECK (template_snapshot ->> 'publishedByActorId' = published_by_actor_id)
);

CREATE TABLE omni_workspace_template_channels (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  active_template_version INTEGER NOT NULL,
  active_template_version_id TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, template_id),
  FOREIGN KEY (
    tenant_id, workspace_id, template_id, active_template_version
  ) REFERENCES omni_workspace_template_versions (
    tenant_id, workspace_id, template_id, template_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (active_template_version >= 1),
  CHECK (active_template_version_id = template_id || ':v' || active_template_version::TEXT),
  CHECK (lifecycle_revision = active_template_version),
  CHECK (updated_at >= created_at)
);

CREATE TABLE omni_workspace_template_instantiations (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  instantiation_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  template_version_id TEXT NOT NULL,
  template_sha256 TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_snapshot_sha256 TEXT NOT NULL,
  template_snapshot JSONB NOT NULL,
  project_snapshot JSONB NOT NULL,
  instantiate_idempotency_sha256 TEXT NOT NULL,
  instantiate_request_sha256 TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  instantiated_by_actor_id TEXT NOT NULL,
  instantiated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, instantiation_id),
  UNIQUE (tenant_id, workspace_id, instantiated_by_actor_id, instantiate_idempotency_sha256),
  UNIQUE (tenant_id, workspace_id, project_id),
  FOREIGN KEY (
    tenant_id, workspace_id, template_id, template_version
  ) REFERENCES omni_workspace_template_versions (
    tenant_id, workspace_id, template_id, template_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, project_id)
    REFERENCES omni_work_projects (tenant_id, workspace_id, project_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (instantiated_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (instantiation_id ~ '^workspace-template-instantiation:[0-9a-f-]{36}$'),
  CHECK (template_version >= 1),
  CHECK (template_version_id = template_id || ':v' || template_version::TEXT),
  CHECK (template_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (project_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (instantiate_idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (instantiate_request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (owner_actor_id = instantiated_by_actor_id),
  CHECK (template_snapshot ->> 'templateVersionId' = template_version_id),
  CHECK (template_snapshot ->> 'templateSha256' = template_sha256),
  CHECK (project_snapshot ->> 'projectId' = project_id)
);

CREATE INDEX omni_workspace_template_versions_active_idx
  ON omni_workspace_template_versions (
    tenant_id, workspace_id, template_id, template_version DESC
  );
CREATE INDEX omni_workspace_template_instantiations_template_idx
  ON omni_workspace_template_instantiations (
    tenant_id, workspace_id, template_id, template_version, instantiated_at DESC
  );

CREATE FUNCTION omni_protect_workspace_template_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Published template versions and instantiations are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_protect_workspace_template_channel_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Workspace template channels cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.active_template_version <> 1 OR NEW.lifecycle_revision <> 1
      OR NEW.owner_actor_id <> NEW.updated_by_actor_id
      OR NEW.created_at <> NEW.updated_at
    THEN
      RAISE EXCEPTION 'Initial workspace template channel is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.tenant_id <> NEW.tenant_id
    OR OLD.workspace_id <> NEW.workspace_id
    OR OLD.template_id <> NEW.template_id
    OR OLD.owner_actor_id <> NEW.owner_actor_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.active_template_version <> OLD.active_template_version + 1
    OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'Workspace template channel transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_workspace_template_versions_immutable
  BEFORE UPDATE OR DELETE ON omni_workspace_template_versions
  FOR EACH ROW EXECUTE FUNCTION omni_protect_workspace_template_immutable_v1();
CREATE TRIGGER omni_workspace_template_versions_no_truncate
  BEFORE TRUNCATE ON omni_workspace_template_versions
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_workspace_template_immutable_v1();
CREATE TRIGGER omni_workspace_template_instantiations_immutable
  BEFORE UPDATE OR DELETE ON omni_workspace_template_instantiations
  FOR EACH ROW EXECUTE FUNCTION omni_protect_workspace_template_immutable_v1();
CREATE TRIGGER omni_workspace_template_instantiations_no_truncate
  BEFORE TRUNCATE ON omni_workspace_template_instantiations
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_workspace_template_immutable_v1();
CREATE TRIGGER omni_workspace_template_channels_protect
  BEFORE INSERT OR UPDATE OR DELETE ON omni_workspace_template_channels
  FOR EACH ROW EXECUTE FUNCTION omni_protect_workspace_template_channel_v1();
CREATE TRIGGER omni_workspace_template_channels_no_truncate
  BEFORE TRUNCATE ON omni_workspace_template_channels
  FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_workspace_template_channel_v1();

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_workspace_template_versions',
    'omni_workspace_template_channels',
    'omni_workspace_template_instantiations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY omni_tenant_isolation ON %I FOR ALL USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (omni_system_scope_enabled() OR EXISTS (SELECT 1 FROM omni_tenant_workspace_memberships membership WHERE membership.tenant_id = %I.tenant_id AND membership.workspace_id = %I.workspace_id AND membership.subject_kind = ''user'' AND membership.state = ''active'' AND omni_actor_scope_v1_allows_canonical(membership.tenant_id, membership.subject_actor_id))) WITH CHECK (omni_system_scope_enabled() OR (omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id) AND EXISTS (SELECT 1 FROM omni_tenant_workspace_memberships membership WHERE membership.tenant_id = %I.tenant_id AND membership.workspace_id = %I.workspace_id AND membership.subject_kind = ''user'' AND membership.subject_actor_id = %I.owner_actor_id AND membership.access_level IN (''contributor'', ''manager'') AND membership.state = ''active'')))',
      table_name || '_workspace_scope', table_name,
      table_name, table_name, table_name, table_name, table_name
    );
  END LOOP;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_workspace_template_versions,
      omni_workspace_template_channels,
      omni_workspace_template_instantiations FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_workspace_template_versions TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_workspace_template_channels TO omni_runtime;
    GRANT SELECT, INSERT ON omni_workspace_template_instantiations TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_workspace_template_versions TO omni_maintenance;
    GRANT SELECT, INSERT, UPDATE ON omni_workspace_template_channels TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_workspace_template_instantiations TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_workspace_template_versions,
      omni_workspace_template_channels,
      omni_workspace_template_instantiations TO omni_backup;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'omni_workspace_template_versions'::regclass
      AND tgname = 'omni_workspace_template_versions_immutable'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_workspace_template_versions'::regclass
      AND polname = 'omni_workspace_template_versions_workspace_scope'
      AND NOT polpermissive
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_workspace_template_instantiations'::regclass
      AND contype = 'f'
      AND confrelid = 'omni_work_projects'::regclass
  ) THEN
    RAISE EXCEPTION 'Workspace template schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  132,
  'workspace_templates_v1',
  'f750197534c0c4854c424130fe566c34c431481bbe561526361067baaaeb0643',
  NOW()
);

COMMIT;
