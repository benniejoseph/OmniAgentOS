BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 188 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 188
      AND name = 'builtin_skill_catalog_v3'
      AND checksum = '4c206314533b7812aff807d551f1b1514987582b64c21e1c17378ac0c592deb1'
  ) <> 1 THEN
    RAISE EXCEPTION 'Generated artifact persistence predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

    CREATE OR REPLACE FUNCTION omni_generated_artifact_refs_are_canonical_v1(
      values_to_check TEXT[], maximum_entries INTEGER
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SET search_path = pg_catalog, public
    AS $function$
      SELECT values_to_check IS NOT NULL
        AND maximum_entries > 0
        AND cardinality(values_to_check) BETWEEN 0 AND maximum_entries
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT value,
              lag(value) OVER (ORDER BY ordinal_position) AS previous_value
            FROM unnest(values_to_check)
              WITH ORDINALITY AS entry(value, ordinal_position)
          ) ordered_values
          WHERE NOT omni_source_contract_id_is_valid(value)
            OR (
              previous_value IS NOT NULL
              AND value COLLATE "C" <= previous_value COLLATE "C"
            )
        )
    $function$;

    CREATE TABLE IF NOT EXISTS omni_generated_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      current_version_id TEXT NOT NULL,
      project_id TEXT,
      mission_id TEXT,
      work_item_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      CHECK (id ~ '^generated_artifact_[a-f0-9]{48}$'),
      CHECK (char_length(tenant_id) BETWEEN 1 AND 160),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (kind IN ('document', 'presentation', 'spreadsheet', 'pdf')),
      CHECK (char_length(title) BETWEEN 1 AND 240 AND title = btrim(title)),
      CHECK (current_version >= 1),
      CHECK (current_version_id = id || ':v' || current_version::TEXT),
      CHECK (project_id IS NULL OR omni_source_contract_id_is_valid(project_id)),
      CHECK (mission_id IS NULL OR omni_source_contract_id_is_valid(mission_id)),
      CHECK (work_item_id IS NULL OR omni_source_contract_id_is_valid(work_item_id)),
      CHECK (updated_at >= created_at)
    );

    CREATE TABLE IF NOT EXISTS omni_generated_artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      artifact_version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      render_status TEXT NOT NULL,
      spec_snapshot JSONB NOT NULL,
      spec_sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      content_sha256 TEXT,
      byte_count BIGINT,
      content_bytes BYTEA,
      lineage_refs TEXT[] NOT NULL DEFAULT '{}',
      evidence_refs TEXT[] NOT NULL DEFAULT '{}',
      project_id TEXT,
      mission_id TEXT,
      work_item_id TEXT,
      google_resource_ref JSONB,
      failure_code TEXT,
      creation_idempotency_key_sha256 TEXT NOT NULL,
      creation_request_sha256 TEXT NOT NULL,
      execution_scope JSONB NOT NULL,
      queued_at TIMESTAMPTZ NOT NULL,
      rendering_started_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, id),
      UNIQUE (tenant_id, owner_actor_id, artifact_id, artifact_version),
      UNIQUE (tenant_id, owner_actor_id, creation_idempotency_key_sha256),
      FOREIGN KEY (tenant_id, owner_actor_id, artifact_id)
        REFERENCES omni_generated_artifacts (tenant_id, owner_actor_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (artifact_id ~ '^generated_artifact_[a-f0-9]{48}$'),
      CHECK (id = artifact_id || ':v' || artifact_version::TEXT),
      CHECK (artifact_version >= 1),
      CHECK (kind IN ('document', 'presentation', 'spreadsheet', 'pdf')),
      CHECK (char_length(title) BETWEEN 1 AND 240 AND title = btrim(title)),
      CHECK (render_status IN ('queued', 'rendering', 'ready', 'failed')),
      CHECK (jsonb_typeof(spec_snapshot) = 'object'),
      CHECK (pg_column_size(spec_snapshot) <= 524288),
      CHECK (spec_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (
        char_length(media_type) BETWEEN 3 AND 200
        AND media_type = lower(media_type)
        AND media_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
      ),
      CHECK (
        (render_status = 'ready'
          AND content_sha256 ~ '^[a-f0-9]{64}$'
          AND byte_count > 0
          AND content_bytes IS NOT NULL
          AND octet_length(content_bytes) = byte_count
          AND ready_at IS NOT NULL
          AND failure_code IS NULL
          AND failed_at IS NULL)
        OR
        (render_status <> 'ready'
          AND content_sha256 IS NULL
          AND byte_count IS NULL
          AND content_bytes IS NULL
          AND ready_at IS NULL)
      ),
      CHECK (omni_generated_artifact_refs_are_canonical_v1(lineage_refs, 64)),
      CHECK (omni_generated_artifact_refs_are_canonical_v1(evidence_refs, 64)),
      CHECK (project_id IS NULL OR omni_source_contract_id_is_valid(project_id)),
      CHECK (mission_id IS NULL OR omni_source_contract_id_is_valid(mission_id)),
      CHECK (work_item_id IS NULL OR omni_source_contract_id_is_valid(work_item_id)),
      CHECK (
        google_resource_ref IS NULL OR (
          jsonb_typeof(google_resource_ref) = 'object'
          AND google_resource_ref ?& ARRAY[
            'provider', 'resourceType', 'resourceId', 'revisionId'
          ]
          AND google_resource_ref - ARRAY[
            'provider', 'resourceType', 'resourceId', 'revisionId'
          ] = '{}'::JSONB
          AND google_resource_ref ->> 'provider' = 'google_workspace'
          AND google_resource_ref ->> 'resourceType' IN (
            'document', 'presentation', 'spreadsheet'
          )
          AND omni_source_contract_id_is_valid(
            google_resource_ref ->> 'resourceId'
          )
          AND (
            google_resource_ref -> 'revisionId' = 'null'::JSONB
            OR omni_source_contract_id_is_valid(
              google_resource_ref ->> 'revisionId'
            )
          )
        )
      ),
      CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$'),
      CHECK (
        (render_status = 'failed' AND failure_code IS NOT NULL AND failed_at IS NOT NULL)
        OR (render_status <> 'failed' AND failure_code IS NULL AND failed_at IS NULL)
      ),
      CHECK (creation_idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (creation_request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (
        jsonb_typeof(execution_scope) = 'object'
        AND execution_scope ->> 'version' = '1'
        AND execution_scope ->> 'tenantId' = tenant_id
        AND execution_scope ->> 'initiatingActorId' = owner_actor_id
        AND COALESCE(execution_scope ->> 'projectId', '') = COALESCE(project_id, '')
        AND COALESCE(execution_scope ->> 'missionId', '') = COALESCE(mission_id, '')
      ),
      CHECK (queued_at = created_at),
      CHECK (rendering_started_at IS NULL OR rendering_started_at >= queued_at),
      CHECK (ready_at IS NULL OR ready_at >= queued_at),
      CHECK (failed_at IS NULL OR failed_at >= queued_at),
      CHECK (updated_at >= created_at)
    );

    CREATE TABLE IF NOT EXISTS omni_generated_artifact_mutations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      artifact_version_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      result_status TEXT NOT NULL,
      event_id TEXT NOT NULL,
      execution_scope JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, owner_actor_id, operation, idempotency_key_sha256),
      FOREIGN KEY (tenant_id, owner_actor_id, artifact_version_id)
        REFERENCES omni_generated_artifact_versions (
          tenant_id, owner_actor_id, id
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES omni_events (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (id ~ '^generated_artifact_mutation_[a-f0-9]{48}$'),
      CHECK (artifact_id ~ '^generated_artifact_[a-f0-9]{48}$'),
      CHECK (artifact_version_id ~ '^generated_artifact_[a-f0-9]{48}:v[1-9][0-9]*$'),
      CHECK (operation IN ('queue', 'start', 'ready', 'fail')),
      CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (result_status IN ('queued', 'rendering', 'ready', 'failed')),
      CHECK (char_length(event_id) BETWEEN 1 AND 240),
      CHECK (
        jsonb_typeof(execution_scope) = 'object'
        AND execution_scope ->> 'version' = '1'
        AND execution_scope ->> 'tenantId' = tenant_id
        AND execution_scope ->> 'initiatingActorId' = owner_actor_id
      )
    );

    CREATE INDEX IF NOT EXISTS omni_generated_artifacts_owner_updated_idx
      ON omni_generated_artifacts (
        tenant_id, owner_actor_id, updated_at DESC, id
      );
    CREATE INDEX IF NOT EXISTS omni_generated_artifact_versions_lifecycle_idx
      ON omni_generated_artifact_versions (
        tenant_id, owner_actor_id, render_status, updated_at DESC, id
      );
    CREATE INDEX IF NOT EXISTS omni_generated_artifact_versions_project_idx
      ON omni_generated_artifact_versions (
        tenant_id, owner_actor_id, project_id, updated_at DESC, id
      ) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS omni_generated_artifact_mutations_version_idx
      ON omni_generated_artifact_mutations (
        tenant_id, owner_actor_id, artifact_version_id, created_at, id
      );

    CREATE OR REPLACE FUNCTION omni_protect_generated_artifact_head_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Generated artifact heads cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR NEW.current_version IS DISTINCT FROM OLD.current_version + 1
        OR NEW.current_version_id IS DISTINCT FROM
          NEW.id || ':v' || NEW.current_version::TEXT
        OR NEW.updated_at <= OLD.updated_at
      THEN
        RAISE EXCEPTION 'Generated artifact head transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE OR REPLACE FUNCTION omni_protect_generated_artifact_version_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Generated artifact versions are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR OLD.artifact_version IS DISTINCT FROM NEW.artifact_version
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.title IS DISTINCT FROM NEW.title
        OR OLD.spec_snapshot IS DISTINCT FROM NEW.spec_snapshot
        OR OLD.spec_sha256 IS DISTINCT FROM NEW.spec_sha256
        OR OLD.media_type IS DISTINCT FROM NEW.media_type
        OR OLD.lineage_refs IS DISTINCT FROM NEW.lineage_refs
        OR OLD.evidence_refs IS DISTINCT FROM NEW.evidence_refs
        OR OLD.project_id IS DISTINCT FROM NEW.project_id
        OR OLD.mission_id IS DISTINCT FROM NEW.mission_id
        OR OLD.work_item_id IS DISTINCT FROM NEW.work_item_id
        OR OLD.creation_idempotency_key_sha256 IS DISTINCT FROM
          NEW.creation_idempotency_key_sha256
        OR OLD.creation_request_sha256 IS DISTINCT FROM NEW.creation_request_sha256
        OR OLD.execution_scope IS DISTINCT FROM NEW.execution_scope
        OR OLD.queued_at IS DISTINCT FROM NEW.queued_at
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR NEW.updated_at <= OLD.updated_at
      THEN
        RAISE EXCEPTION 'Generated artifact version identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.render_status = 'queued' AND NEW.render_status = 'rendering' THEN
        IF NEW.rendering_started_at IS NULL
          OR NEW.content_sha256 IS NOT NULL
          OR NEW.byte_count IS NOT NULL
          OR NEW.content_bytes IS NOT NULL
          OR NEW.google_resource_ref IS NOT NULL
          OR NEW.failure_code IS NOT NULL
          OR NEW.ready_at IS NOT NULL
          OR NEW.failed_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Generated artifact rendering transition is invalid'
            USING ERRCODE = '55000';
        END IF;
      ELSIF OLD.render_status = 'rendering' AND NEW.render_status = 'ready' THEN
        IF NEW.rendering_started_at IS DISTINCT FROM OLD.rendering_started_at
          OR NEW.content_sha256 IS NULL
          OR NEW.byte_count IS NULL
          OR NEW.content_bytes IS NULL
          OR NEW.ready_at IS NULL
          OR NEW.failure_code IS NOT NULL
          OR NEW.failed_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Generated artifact ready transition is invalid'
            USING ERRCODE = '55000';
        END IF;
      ELSIF OLD.render_status IN ('queued', 'rendering')
        AND NEW.render_status = 'failed'
      THEN
        IF NEW.rendering_started_at IS DISTINCT FROM OLD.rendering_started_at
          OR NEW.content_sha256 IS NOT NULL
          OR NEW.byte_count IS NOT NULL
          OR NEW.content_bytes IS NOT NULL
          OR NEW.google_resource_ref IS NOT NULL
          OR NEW.ready_at IS NOT NULL
          OR NEW.failure_code IS NULL
          OR NEW.failed_at IS NULL
        THEN
          RAISE EXCEPTION 'Generated artifact failed transition is invalid'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        RAISE EXCEPTION 'Generated artifact lifecycle transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE OR REPLACE FUNCTION omni_reject_generated_artifact_mutation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Generated artifact mutation receipts are immutable'
        USING ERRCODE = '55000';
    END
    $function$;

    DROP TRIGGER IF EXISTS omni_generated_artifacts_protect_head
      ON omni_generated_artifacts;
    CREATE TRIGGER omni_generated_artifacts_protect_head
      BEFORE UPDATE OR DELETE ON omni_generated_artifacts
      FOR EACH ROW EXECUTE FUNCTION omni_protect_generated_artifact_head_v1();
    DROP TRIGGER IF EXISTS omni_generated_artifacts_no_truncate
      ON omni_generated_artifacts;
    CREATE TRIGGER omni_generated_artifacts_no_truncate
      BEFORE TRUNCATE ON omni_generated_artifacts
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_generated_artifact_head_v1();

    DROP TRIGGER IF EXISTS omni_generated_artifact_versions_protect
      ON omni_generated_artifact_versions;
    CREATE TRIGGER omni_generated_artifact_versions_protect
      BEFORE UPDATE OR DELETE ON omni_generated_artifact_versions
      FOR EACH ROW EXECUTE FUNCTION omni_protect_generated_artifact_version_v1();
    DROP TRIGGER IF EXISTS omni_generated_artifact_versions_no_truncate
      ON omni_generated_artifact_versions;
    CREATE TRIGGER omni_generated_artifact_versions_no_truncate
      BEFORE TRUNCATE ON omni_generated_artifact_versions
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_generated_artifact_version_v1();

    DROP TRIGGER IF EXISTS omni_generated_artifact_mutations_immutable
      ON omni_generated_artifact_mutations;
    CREATE TRIGGER omni_generated_artifact_mutations_immutable
      BEFORE UPDATE OR DELETE ON omni_generated_artifact_mutations
      FOR EACH ROW EXECUTE FUNCTION omni_reject_generated_artifact_mutation_v1();
    DROP TRIGGER IF EXISTS omni_generated_artifact_mutations_no_truncate
      ON omni_generated_artifact_mutations;
    CREATE TRIGGER omni_generated_artifact_mutations_no_truncate
      BEFORE TRUNCATE ON omni_generated_artifact_mutations
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_generated_artifact_mutation_v1();

    ALTER TABLE omni_generated_artifacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_generated_artifacts FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_generated_artifact_versions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_generated_artifact_versions FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_generated_artifact_mutations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_generated_artifact_mutations FORCE ROW LEVEL SECURITY;

    DO $policies$
    DECLARE table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'omni_generated_artifacts',
        'omni_generated_artifact_versions',
        'omni_generated_artifact_mutations'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS omni_tenant_isolation ON %I', table_name
        );
        EXECUTE format(
          'CREATE POLICY omni_tenant_isolation ON %I AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
          table_name
        );
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON %I', table_name || '_actor', table_name
        );
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
          table_name || '_actor', table_name
        );
      END LOOP;
    END
    $policies$;

    REVOKE ALL ON omni_generated_artifacts FROM PUBLIC;
    REVOKE ALL ON omni_generated_artifact_versions FROM PUBLIC;
    REVOKE ALL ON omni_generated_artifact_mutations FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_generated_artifact_refs_are_canonical_v1(TEXT[], INTEGER) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_generated_artifact_head_v1() FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_generated_artifact_version_v1() FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_generated_artifact_mutation_v1() FROM PUBLIC;

    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT EXECUTE ON FUNCTION omni_generated_artifact_refs_are_canonical_v1(TEXT[], INTEGER)
          TO omni_runtime;
        GRANT SELECT, INSERT ON omni_generated_artifacts TO omni_runtime;
        GRANT UPDATE (
          title, current_version, current_version_id, project_id, mission_id,
          work_item_id, updated_at
        ) ON omni_generated_artifacts TO omni_runtime;
        GRANT SELECT, INSERT ON omni_generated_artifact_versions TO omni_runtime;
        GRANT UPDATE (
          render_status, content_sha256, byte_count, content_bytes,
          google_resource_ref, failure_code, rendering_started_at, ready_at,
          failed_at, updated_at
        ) ON omni_generated_artifact_versions TO omni_runtime;
        GRANT SELECT, INSERT ON omni_generated_artifact_mutations TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT EXECUTE ON FUNCTION omni_generated_artifact_refs_are_canonical_v1(TEXT[], INTEGER)
          TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_generated_artifacts TO omni_maintenance;
        GRANT UPDATE (
          title, current_version, current_version_id, project_id, mission_id,
          work_item_id, updated_at
        ) ON omni_generated_artifacts TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_generated_artifact_versions TO omni_maintenance;
        GRANT UPDATE (
          render_status, content_sha256, byte_count, content_bytes,
          google_resource_ref, failure_code, rendering_started_at, ready_at,
          failed_at, updated_at
        ) ON omni_generated_artifact_versions TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_generated_artifact_mutations TO omni_maintenance;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
        GRANT SELECT ON omni_generated_artifacts TO omni_backup;
        GRANT SELECT ON omni_generated_artifact_versions TO omni_backup;
        GRANT SELECT ON omni_generated_artifact_mutations TO omni_backup;
      END IF;
    END
    $grants$;

    ALTER TABLE omni_asset_objects
      DROP CONSTRAINT IF EXISTS omni_asset_objects_source_kind_check;
    ALTER TABLE omni_asset_objects
      ADD CONSTRAINT omni_asset_objects_source_kind_check CHECK (
        source_kind IN ('capture_asset', 'capture_segment', 'generated_artifact')
      );
    ALTER TABLE omni_asset_objects
      DROP CONSTRAINT IF EXISTS omni_asset_objects_integrity_check;
    ALTER TABLE omni_asset_objects
      ADD CONSTRAINT omni_asset_objects_integrity_check CHECK (
        content_sha256 ~ '^[a-f0-9]{64}$'
        AND byte_count > 0
        AND length(media_type) BETWEEN 1 AND 200
        AND storage_locator ~ '^v1/[a-f0-9]{32}/[a-f0-9]{32}/(capture_asset|capture_segment|generated_artifact)/[a-f0-9]{48}/v[1-9][0-9]*/[a-f0-9]{64}\.bin$'
      );

    DO $verify$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_class relation
        WHERE relation.oid IN (
          'omni_generated_artifacts'::regclass,
          'omni_generated_artifact_versions'::regclass,
          'omni_generated_artifact_mutations'::regclass
        )
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
      ) <> 3 OR (
        SELECT count(*)
        FROM pg_policy policy
        WHERE policy.polrelid IN (
          'omni_generated_artifacts'::regclass,
          'omni_generated_artifact_versions'::regclass,
          'omni_generated_artifact_mutations'::regclass
        )
          AND NOT policy.polpermissive
          AND policy.polcmd = '*'
          AND policy.polname LIKE '%_actor'
      ) <> 3 OR (
        SELECT count(*)
        FROM pg_policy policy
        WHERE policy.polrelid IN (
          'omni_generated_artifacts'::regclass,
          'omni_generated_artifact_versions'::regclass,
          'omni_generated_artifact_mutations'::regclass
        )
          AND policy.polpermissive
          AND policy.polcmd = '*'
          AND policy.polname = 'omni_tenant_isolation'
      ) <> 3 THEN
        RAISE EXCEPTION 'Generated artifact actor boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  189,
  'generated_artifact_persistence_v1',
  '4065c615c77bf4baf5921d5dcd468359ed8113bc49ba5291908bdfc3b9f36ebf',
  clock_timestamp()
);

COMMIT;
