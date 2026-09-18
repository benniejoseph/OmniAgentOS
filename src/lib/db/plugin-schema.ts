type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

/** Runtime equivalent of ordered migration v186 for non-production schema setup. */
export async function ensureDeclarativePluginsV1(sql: MigrationSql) {
  await sql.query(`
    CREATE TABLE omni_plugin_install_previews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      manifest_snapshot JSONB NOT NULL,
      preview_snapshot JSONB NOT NULL,
      preview_sha256 TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      UNIQUE (tenant_id, owner_actor_id, idempotency_key_sha256),
      CHECK (char_length(id) BETWEEN 16 AND 200),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
      CHECK (plugin_id ~ '^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$'),
      CHECK (char_length(plugin_version) BETWEEN 5 AND 80),
      CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (preview_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK ((manifest_snapshot->>'schemaVersion')::INTEGER = 1),
      CHECK (manifest_snapshot->>'pluginId' = plugin_id),
      CHECK (manifest_snapshot->>'version' = plugin_version),
      CHECK ((preview_snapshot->>'schemaVersion')::INTEGER = 1),
      CHECK (preview_snapshot->>'previewId' = id),
      CHECK (preview_snapshot->>'manifestSha256' = manifest_sha256),
      CHECK (expires_at > created_at),
      CHECK (pg_column_size(manifest_snapshot) <= 131072),
      CHECK (pg_column_size(preview_snapshot) <= 32768)
    );

    CREATE TABLE omni_plugin_installations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      manifest_snapshot JSONB NOT NULL,
      installation_snapshot JSONB NOT NULL,
      installation_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      lifecycle_revision INTEGER NOT NULL,
      source_preview_id TEXT NOT NULL,
      source_preview_sha256 TEXT NOT NULL,
      installed_by_actor_id TEXT NOT NULL,
      updated_by_actor_id TEXT NOT NULL,
      installed_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      UNIQUE (tenant_id, owner_actor_id, plugin_id),
      FOREIGN KEY (tenant_id, owner_actor_id, source_preview_id)
        REFERENCES omni_plugin_install_previews (tenant_id, owner_actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (char_length(id) BETWEEN 16 AND 200),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
      CHECK (plugin_id ~ '^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$'),
      CHECK (char_length(plugin_version) BETWEEN 5 AND 80),
      CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (installation_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (source_preview_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (state COLLATE "C" IN ('enabled', 'disabled', 'uninstalled')),
      CHECK (lifecycle_revision >= 1),
      CHECK (installed_by_actor_id = owner_actor_id),
      CHECK (updated_by_actor_id = owner_actor_id),
      CHECK ((manifest_snapshot->>'schemaVersion')::INTEGER = 1),
      CHECK (manifest_snapshot->>'pluginId' = plugin_id),
      CHECK (manifest_snapshot->>'version' = plugin_version),
      CHECK ((installation_snapshot->>'schemaVersion')::INTEGER = 1),
      CHECK (installation_snapshot->>'installationId' = id),
      CHECK (installation_snapshot->>'pluginId' = plugin_id),
      CHECK (installation_snapshot->>'pluginVersion' = plugin_version),
      CHECK (installation_snapshot->>'manifestSha256' = manifest_sha256),
      CHECK (installation_snapshot->>'installationSha256' = installation_sha256),
      CHECK (installation_snapshot->>'state' = state),
      CHECK ((installation_snapshot->>'revision')::INTEGER = lifecycle_revision),
      CHECK (updated_at >= installed_at),
      CHECK (pg_column_size(manifest_snapshot) <= 131072),
      CHECK (pg_column_size(installation_snapshot) <= 65536)
    );

    CREATE INDEX omni_plugin_installations_actor_state_idx
      ON omni_plugin_installations (tenant_id, owner_actor_id, state, updated_at DESC);
    CREATE INDEX omni_plugin_install_previews_expiry_idx
      ON omni_plugin_install_previews (expires_at);

    CREATE TABLE omni_plugin_mutation_receipts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      installation_snapshot JSONB NOT NULL,
      manifest_snapshot JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (tenant_id, owner_actor_id, installation_id)
        REFERENCES omni_plugin_installations (tenant_id, owner_actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      UNIQUE (tenant_id, owner_actor_id, operation, idempotency_key_sha256),
      CHECK (char_length(id) BETWEEN 16 AND 200),
      CHECK (operation COLLATE "C" IN ('install', 'enable', 'disable', 'uninstall')),
      CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (installation_snapshot->>'installationId' = installation_id),
      CHECK (installation_snapshot->>'installationSha256' = result_sha256),
      CHECK (pg_column_size(installation_snapshot) <= 65536),
      CHECK (pg_column_size(manifest_snapshot) <= 131072)
    );

    ALTER TABLE omni_custom_skills
      ADD COLUMN source_plugin_installation_id TEXT,
      ADD COLUMN source_plugin_id TEXT,
      ADD COLUMN source_plugin_version TEXT,
      ADD COLUMN source_plugin_skill_key TEXT,
      ADD COLUMN source_plugin_manifest_sha256 TEXT,
      ADD COLUMN source_plugin_skill_sha256 TEXT;
    ALTER TABLE omni_custom_skills
      ADD CONSTRAINT omni_custom_skills_plugin_source_complete CHECK (
        (source_plugin_installation_id IS NULL
          AND source_plugin_id IS NULL
          AND source_plugin_version IS NULL
          AND source_plugin_skill_key IS NULL
          AND source_plugin_manifest_sha256 IS NULL
          AND source_plugin_skill_sha256 IS NULL)
        OR
        (source_plugin_installation_id IS NOT NULL
          AND source_plugin_id IS NOT NULL
          AND source_plugin_version IS NOT NULL
          AND source_plugin_skill_key IS NOT NULL
          AND source_plugin_manifest_sha256 ~ '^[a-f0-9]{64}$'
          AND source_plugin_skill_sha256 ~ '^[a-f0-9]{64}$')
      );
    ALTER TABLE omni_custom_skills
      ADD CONSTRAINT omni_custom_skills_plugin_installation_fkey
      FOREIGN KEY (tenant_id, actor_id, source_plugin_installation_id)
      REFERENCES omni_plugin_installations (tenant_id, owner_actor_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
    CREATE UNIQUE INDEX omni_custom_skills_plugin_key_idx
      ON omni_custom_skills (
        tenant_id, actor_id, source_plugin_id, source_plugin_skill_key
      ) WHERE source_plugin_installation_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION omni_reject_plugin_immutable_mutation_v1()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public AS $function$
    BEGIN
      RAISE EXCEPTION 'Plugin preview and mutation receipts are immutable'
        USING ERRCODE = '55000';
    END $function$;
    CREATE TRIGGER omni_plugin_install_previews_immutable
      BEFORE UPDATE OR DELETE ON omni_plugin_install_previews
      FOR EACH ROW EXECUTE FUNCTION omni_reject_plugin_immutable_mutation_v1();
    CREATE TRIGGER omni_plugin_install_previews_no_truncate
      BEFORE TRUNCATE ON omni_plugin_install_previews
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_plugin_immutable_mutation_v1();
    CREATE TRIGGER omni_plugin_mutation_receipts_immutable
      BEFORE UPDATE OR DELETE ON omni_plugin_mutation_receipts
      FOR EACH ROW EXECUTE FUNCTION omni_reject_plugin_immutable_mutation_v1();
    CREATE TRIGGER omni_plugin_mutation_receipts_no_truncate
      BEFORE TRUNCATE ON omni_plugin_mutation_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_plugin_immutable_mutation_v1();

    CREATE OR REPLACE FUNCTION omni_protect_plugin_installation_identity_v1()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Plugin installations use reversible lifecycle state'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.plugin_id IS DISTINCT FROM OLD.plugin_id
        OR NEW.installed_by_actor_id IS DISTINCT FROM OLD.installed_by_actor_id
        OR NEW.installed_at IS DISTINCT FROM OLD.installed_at
      THEN
        RAISE EXCEPTION 'Plugin installation identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
        OR NEW.updated_at <= OLD.updated_at
        OR (OLD.state, NEW.state) NOT IN (
          ('enabled', 'disabled'),
          ('enabled', 'uninstalled'),
          ('disabled', 'enabled'),
          ('disabled', 'uninstalled'),
          ('uninstalled', 'enabled')
        )
      THEN
        RAISE EXCEPTION 'Plugin lifecycle transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.state = 'uninstalled'
        AND NEW.state = 'enabled'
        AND NEW.source_preview_id IS NOT DISTINCT FROM OLD.source_preview_id
      THEN
        RAISE EXCEPTION 'Plugin reinstall requires a fresh exact preview'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.plugin_version IS DISTINCT FROM OLD.plugin_version
        OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
        OR NEW.manifest_snapshot IS DISTINCT FROM OLD.manifest_snapshot
      THEN
        IF OLD.state IS DISTINCT FROM 'uninstalled'
          OR NEW.state IS DISTINCT FROM 'enabled'
          OR NEW.source_preview_id IS NOT DISTINCT FROM OLD.source_preview_id
        THEN
          RAISE EXCEPTION 'Plugin manifest replacement requires an exact reinstall preview'
            USING ERRCODE = '55000';
        END IF;
      ELSIF NEW.source_preview_id IS DISTINCT FROM OLD.source_preview_id
        AND (OLD.state IS DISTINCT FROM 'uninstalled' OR NEW.state IS DISTINCT FROM 'enabled')
      THEN
        RAISE EXCEPTION 'Plugin preview replacement requires reinstall'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $function$;
    CREATE TRIGGER omni_plugin_installations_protect_identity
      BEFORE UPDATE OR DELETE ON omni_plugin_installations
      FOR EACH ROW EXECUTE FUNCTION omni_protect_plugin_installation_identity_v1();
    CREATE TRIGGER omni_plugin_installations_no_truncate
      BEFORE TRUNCATE ON omni_plugin_installations
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_plugin_immutable_mutation_v1();
    REVOKE ALL ON FUNCTION omni_reject_plugin_immutable_mutation_v1() FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_plugin_installation_identity_v1() FROM PUBLIC;

    ALTER TABLE omni_plugin_install_previews ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_plugin_install_previews FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_plugin_installations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_plugin_installations FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_plugin_mutation_receipts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_plugin_mutation_receipts FORCE ROW LEVEL SECURITY;
    CREATE POLICY omni_tenant_isolation ON omni_plugin_install_previews
      AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id))
      WITH CHECK (omni_tenant_visible(tenant_id));
    CREATE POLICY omni_plugin_install_previews_actor ON omni_plugin_install_previews
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))
      WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id));
    CREATE POLICY omni_tenant_isolation ON omni_plugin_installations
      AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id))
      WITH CHECK (omni_tenant_visible(tenant_id));
    CREATE POLICY omni_plugin_installations_actor ON omni_plugin_installations
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))
      WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id));
    CREATE POLICY omni_tenant_isolation ON omni_plugin_mutation_receipts
      AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id))
      WITH CHECK (omni_tenant_visible(tenant_id));
    CREATE POLICY omni_plugin_mutation_receipts_actor ON omni_plugin_mutation_receipts
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))
      WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id));

    REVOKE ALL ON omni_plugin_install_previews FROM PUBLIC;
    REVOKE ALL ON omni_plugin_installations FROM PUBLIC;
    REVOKE ALL ON omni_plugin_mutation_receipts FROM PUBLIC;
    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT ON omni_plugin_install_previews TO omni_runtime;
        GRANT SELECT, INSERT ON omni_plugin_installations TO omni_runtime;
        GRANT UPDATE (
          plugin_version, manifest_sha256, manifest_snapshot,
          installation_snapshot, installation_sha256, state, lifecycle_revision,
          source_preview_id, source_preview_sha256, updated_by_actor_id, updated_at
        ) ON omni_plugin_installations TO omni_runtime;
        GRANT SELECT, INSERT ON omni_plugin_mutation_receipts TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT ON omni_plugin_install_previews TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_plugin_installations TO omni_maintenance;
        GRANT UPDATE (
          plugin_version, manifest_sha256, manifest_snapshot,
          installation_snapshot, installation_sha256, state, lifecycle_revision,
          source_preview_id, source_preview_sha256, updated_by_actor_id, updated_at
        ) ON omni_plugin_installations TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_plugin_mutation_receipts TO omni_maintenance;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
        GRANT SELECT ON omni_plugin_install_previews TO omni_backup;
        GRANT SELECT ON omni_plugin_installations TO omni_backup;
        GRANT SELECT ON omni_plugin_mutation_receipts TO omni_backup;
      END IF;
    END $grants$;
  `);
}
