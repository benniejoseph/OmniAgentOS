BEGIN;

DO $migration$
    BEGIN
      IF (
        SELECT count(*) FROM omni_schema_version
        WHERE version = 127
          AND name = 'ap2_receipt_reconciliation_v1'
          AND checksum = 'b85bf6d553f897caa31d67ec907d5abf308572652dd45524da150e4ec4a60acb'
      ) <> 1 THEN
        RAISE EXCEPTION 'Canonical work model predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

    ALTER TABLE omni_tenant_workspaces
      ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT 'Workspace';
    ALTER TABLE omni_tenant_workspaces
      ADD COLUMN IF NOT EXISTS owner_actor_id TEXT;
    UPDATE omni_tenant_workspaces
    SET owner_actor_id = created_by_actor_id
    WHERE owner_actor_id IS NULL;
    ALTER TABLE omni_tenant_workspaces
      ALTER COLUMN owner_actor_id SET NOT NULL;
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_workspaces'::regclass
          AND conname = 'omni_workspace_owner_actor_fkey'
      ) THEN
        ALTER TABLE omni_tenant_workspaces
          ADD CONSTRAINT omni_workspace_owner_actor_fkey
          FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT;
      END IF;
    END
    $migration$;
    ALTER TABLE omni_tenant_workspaces
      DROP CONSTRAINT IF EXISTS omni_workspace_activation_hold_check;
    ALTER TABLE omni_tenant_workspace_memberships
      DROP CONSTRAINT IF EXISTS omni_workspace_membership_activation_hold_check;
    DROP TRIGGER IF EXISTS omni_workspace_validate_insert
      ON omni_tenant_workspaces;
    DROP TRIGGER IF EXISTS omni_workspace_mutation_hold
      ON omni_tenant_workspaces;
    DROP TRIGGER IF EXISTS omni_workspace_membership_validate_insert
      ON omni_tenant_workspace_memberships;
    DROP TRIGGER IF EXISTS omni_workspace_membership_mutation_hold
      ON omni_tenant_workspace_memberships;

    CREATE OR REPLACE FUNCTION omni_protect_workspace_authority_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Workspace authority cannot be deleted or truncated'
          USING ERRCODE = '55000';
      END IF;
      IF TG_TABLE_NAME = 'omni_tenant_workspaces' THEN
        IF TG_OP = 'INSERT' THEN
          IF NEW.owner_actor_id <> NEW.created_by_actor_id
            OR NOT public.omni_actor_has_active_tenant_membership(
              NEW.tenant_id, NEW.created_by_actor_id
            )
            OR NOT (
              (NEW.state = 'held' AND NEW.lifecycle_revision = 0
                AND NEW.activated_by_actor_id IS NULL AND NEW.activated_at IS NULL)
              OR
              (NEW.state = 'active' AND NEW.lifecycle_revision = 1
                AND NEW.activated_by_actor_id = NEW.created_by_actor_id
                AND NEW.activated_at IS NOT NULL)
            )
          THEN
            RAISE EXCEPTION 'Workspace creation authority is invalid'
              USING ERRCODE = '42501';
          END IF;
        ELSIF OLD.tenant_id <> NEW.tenant_id
          OR OLD.workspace_id <> NEW.workspace_id
          OR OLD.owner_actor_id <> NEW.owner_actor_id
          OR OLD.created_by_actor_id <> NEW.created_by_actor_id
          OR OLD.created_at <> NEW.created_at
          OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
          OR NOT (
            (OLD.state = 'held' AND NEW.state = 'active'
              AND NEW.activated_by_actor_id IS NOT NULL
              AND NEW.activated_at IS NOT NULL)
            OR
            (OLD.state = 'active' AND NEW.state = 'archived'
              AND NEW.archived_by_actor_id IS NOT NULL
              AND NEW.archived_at IS NOT NULL)
          )
        THEN
          RAISE EXCEPTION 'Workspace lifecycle transition is invalid'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        IF TG_OP = 'INSERT' THEN
          IF NOT public.omni_actor_has_active_tenant_membership(
              NEW.tenant_id, NEW.created_by_actor_id
            ) OR NOT (
              (NEW.state = 'held' AND NEW.lifecycle_revision = 0
                AND NEW.activated_by_actor_id IS NULL AND NEW.activated_at IS NULL)
              OR
              (NEW.state = 'active' AND NEW.lifecycle_revision = 1
                AND NEW.activated_by_actor_id = NEW.created_by_actor_id
                AND NEW.activated_at IS NOT NULL)
            )
          THEN
            RAISE EXCEPTION 'Workspace membership creation authority is invalid'
              USING ERRCODE = '42501';
          END IF;
        ELSIF OLD.tenant_id <> NEW.tenant_id
          OR OLD.workspace_id <> NEW.workspace_id
          OR OLD.subject_key <> NEW.subject_key
          OR OLD.membership_generation <> NEW.membership_generation
          OR OLD.created_by_actor_id <> NEW.created_by_actor_id
          OR OLD.created_at <> NEW.created_at
          OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
          OR NOT (
            (OLD.state = 'held' AND NEW.state = 'active'
              AND NEW.activated_by_actor_id IS NOT NULL
              AND NEW.activated_at IS NOT NULL)
            OR
            (OLD.state = 'active' AND NEW.state = 'revoked'
              AND NEW.revoked_by_actor_id IS NOT NULL
              AND NEW.revoked_at IS NOT NULL)
          )
        THEN
          RAISE EXCEPTION 'Workspace membership transition is invalid'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$;

    DROP TRIGGER IF EXISTS omni_workspace_no_truncate
      ON omni_tenant_workspaces;
    CREATE TRIGGER omni_workspace_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_tenant_workspaces
      FOR EACH ROW EXECUTE FUNCTION omni_protect_workspace_authority_v1();
    CREATE TRIGGER omni_workspace_no_truncate
      BEFORE TRUNCATE ON omni_tenant_workspaces
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_workspace_authority_v1();
    DROP TRIGGER IF EXISTS omni_workspace_membership_no_truncate
      ON omni_tenant_workspace_memberships;
    CREATE TRIGGER omni_workspace_membership_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_tenant_workspace_memberships
      FOR EACH ROW EXECUTE FUNCTION omni_protect_workspace_authority_v1();
    CREATE TRIGGER omni_workspace_membership_no_truncate
      BEFORE TRUNCATE ON omni_tenant_workspace_memberships
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_workspace_authority_v1();

    CREATE OR REPLACE FUNCTION omni_actor_scope_v1_allows_canonical(
      candidate_tenant_id TEXT,
      candidate_canonical_actor_id TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_tenant_id = NULLIF(current_setting('omni.tenant_id', TRUE), '')
        AND EXISTS (
          SELECT 1
          FROM public.omni_auth_user_actor_identifiers identifier
          JOIN public.omni_auth_users auth_user
            ON auth_user.actor_id = identifier.canonical_actor_id
          JOIN public.omni_auth_memberships membership
            ON membership.user_id = auth_user.id
          WHERE identifier.canonical_actor_id = candidate_canonical_actor_id
            AND membership.tenant_id = candidate_tenant_id
            AND auth_user.status = 'active'
            AND membership.status = 'active'
            AND public.omni_actor_scope_v1_allows(
              candidate_tenant_id, identifier.actor_identifier
            )
        ),
        FALSE
      )
    $function$;

    CREATE OR REPLACE FUNCTION omni_ensure_personal_workspace_v1(
      candidate_tenant_id TEXT,
      candidate_actor_identifier TEXT
    )
    RETURNS TABLE (workspace_id TEXT, owner_actor_id TEXT)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      canonical_actor_id TEXT;
      personal_workspace_id TEXT;
      now_at TIMESTAMPTZ := clock_timestamp();
    BEGIN
      IF candidate_tenant_id IS DISTINCT FROM
          NULLIF(current_setting('omni.tenant_id', TRUE), '')
        OR NOT public.omni_actor_scope_v1_allows(
          candidate_tenant_id, candidate_actor_identifier
        )
      THEN
        RAISE EXCEPTION 'Personal Workspace request is outside actor scope'
          USING ERRCODE = '42501';
      END IF;
      SELECT identifier.canonical_actor_id
      INTO STRICT canonical_actor_id
      FROM public.omni_auth_user_actor_identifiers identifier
      JOIN public.omni_auth_users auth_user
        ON auth_user.actor_id = identifier.canonical_actor_id
      JOIN public.omni_auth_memberships membership
        ON membership.user_id = auth_user.id
      WHERE identifier.actor_identifier = candidate_actor_identifier
        AND membership.tenant_id = candidate_tenant_id
        AND auth_user.status = 'active'
        AND membership.status = 'active';
      personal_workspace_id := 'workspace:personal:' ||
        substring(canonical_actor_id FROM 7);

      INSERT INTO public.omni_tenant_workspaces (
        schema_version, tenant_id, workspace_id, display_name, owner_actor_id,
        state, lifecycle_revision, created_by_actor_id,
        activated_by_actor_id, created_at, activated_at, updated_at
      ) VALUES (
        1, candidate_tenant_id, personal_workspace_id, 'Personal workspace',
        canonical_actor_id, 'active', 1, canonical_actor_id,
        canonical_actor_id, now_at, now_at, now_at
      ) ON CONFLICT (tenant_id, workspace_id) DO NOTHING;

      INSERT INTO public.omni_tenant_workspace_memberships (
        schema_version, tenant_id, workspace_id, subject_kind, subject_key,
        subject_actor_id, subject_execution_principal_id,
        subject_execution_principal_generation, membership_generation,
        access_level, state, lifecycle_revision, created_by_actor_id,
        activated_by_actor_id, created_at, activated_at, updated_at
      ) VALUES (
        1, candidate_tenant_id, personal_workspace_id, 'user',
        canonical_actor_id, canonical_actor_id, NULL, NULL, 1, 'manager',
        'active', 1, canonical_actor_id, canonical_actor_id,
        now_at, now_at, now_at
      ) ON CONFLICT (
        tenant_id, workspace_id, subject_key, membership_generation
      ) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1 FROM public.omni_tenant_workspaces workspace
        JOIN public.omni_tenant_workspace_memberships membership
          ON membership.tenant_id = workspace.tenant_id
          AND membership.workspace_id = workspace.workspace_id
        WHERE workspace.tenant_id = candidate_tenant_id
          AND workspace.workspace_id = personal_workspace_id
          AND workspace.owner_actor_id = canonical_actor_id
          AND workspace.state = 'active'
          AND membership.subject_kind = 'user'
          AND membership.subject_actor_id = canonical_actor_id
          AND membership.access_level = 'manager'
          AND membership.state = 'active'
      ) THEN
        RAISE EXCEPTION 'Personal Workspace authority is unavailable'
          USING ERRCODE = '55000';
      END IF;
      RETURN QUERY SELECT personal_workspace_id, canonical_actor_id;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'Actor does not resolve to one active tenant member'
        USING ERRCODE = '42501';
    END
    $function$;

    CREATE TABLE IF NOT EXISTS omni_work_projects (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL,
      source_authority TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_owner_actor_id TEXT NOT NULL,
      target_date TIMESTAMPTZ,
      lifecycle_revision BIGINT NOT NULL,
      source_revision_sha256 TEXT NOT NULL,
      projection_sha256 TEXT NOT NULL,
      projection JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, workspace_id, project_id),
      UNIQUE (tenant_id, source_authority, source_id),
      FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES omni_tenant_workspaces (tenant_id, workspace_id),
      FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id),
      CHECK (schema_version = 1),
      CHECK (lifecycle_status IN ('draft', 'active', 'completed', 'archived')),
      CHECK (source_authority IN ('legacy_project', 'legacy_mission')),
      CHECK (lifecycle_revision >= 1),
      CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (projection_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (char_length(title) BETWEEN 1 AND 180),
      CHECK (char_length(objective) <= 2000)
    );

    CREATE TABLE IF NOT EXISTS omni_work_project_memberships (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      subject_actor_id TEXT NOT NULL,
      access_level TEXT NOT NULL,
      state TEXT NOT NULL,
      membership_revision BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, project_id, subject_actor_id),
      FOREIGN KEY (tenant_id, workspace_id, project_id)
        REFERENCES omni_work_projects (tenant_id, workspace_id, project_id),
      FOREIGN KEY (subject_actor_id) REFERENCES omni_auth_users (actor_id),
      CHECK (access_level IN ('reader', 'contributor', 'manager')),
      CHECK (state IN ('active', 'revoked')),
      CHECK (membership_revision >= 1)
    );

    CREATE TABLE IF NOT EXISTS omni_work_items (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      parent_work_item_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL,
      canonical_status TEXT NOT NULL,
      source_status TEXT NOT NULL,
      status_revision BIGINT NOT NULL,
      source_authority TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_owner_actor_id TEXT NOT NULL,
      dependency_work_item_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
      owner_actor_ids JSONB NOT NULL,
      assigned_agents JSONB NOT NULL DEFAULT '[]'::JSONB,
      schedule JSONB NOT NULL,
      recurrence JSONB,
      risks JSONB NOT NULL DEFAULT '[]'::JSONB,
      decisions JSONB NOT NULL DEFAULT '[]'::JSONB,
      artifacts JSONB NOT NULL DEFAULT '[]'::JSONB,
      source_revision_sha256 TEXT NOT NULL,
      projection_sha256 TEXT NOT NULL,
      projection JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      terminal_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, workspace_id, project_id, work_item_id),
      UNIQUE (tenant_id, source_authority, source_id),
      FOREIGN KEY (tenant_id, workspace_id, project_id)
        REFERENCES omni_work_projects (tenant_id, workspace_id, project_id),
      CHECK (schema_version = 1),
      CHECK (kind IN ('task', 'milestone')),
      CHECK (priority IN ('low', 'normal', 'medium', 'high', 'urgent')),
      CHECK (canonical_status IN (
        'preview', 'running', 'waiting', 'blocked', 'partial', 'unverified',
        'failed', 'canceled', 'succeeded'
      )),
      CHECK (source_authority IN (
        'legacy_project_task', 'legacy_mission', 'legacy_mission_task'
      )),
      CHECK (status_revision >= 1),
      CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (projection_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (jsonb_typeof(dependency_work_item_ids) = 'array'),
      CHECK (jsonb_typeof(owner_actor_ids) = 'array' AND jsonb_array_length(owner_actor_ids) >= 1),
      CHECK (jsonb_typeof(assigned_agents) = 'array'),
      CHECK (jsonb_typeof(schedule) = 'object'),
      CHECK (recurrence IS NULL OR jsonb_typeof(recurrence) = 'object'),
      CHECK (jsonb_typeof(risks) = 'array'),
      CHECK (jsonb_typeof(decisions) = 'array'),
      CHECK (jsonb_typeof(artifacts) = 'array'),
      CHECK (char_length(title) BETWEEN 1 AND 240),
      CHECK (char_length(detail) <= 4000),
      CHECK (work_item_id <> COALESCE(parent_work_item_id, ''))
    );

    CREATE TABLE IF NOT EXISTS omni_work_item_status_history (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      status_revision BIGINT NOT NULL,
      canonical_status TEXT NOT NULL,
      source_status TEXT NOT NULL,
      source_revision_sha256 TEXT NOT NULL,
      event_sha256 TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (
        tenant_id, workspace_id, project_id, work_item_id, status_revision
      ),
      FOREIGN KEY (tenant_id, workspace_id, project_id, work_item_id)
        REFERENCES omni_work_items (
          tenant_id, workspace_id, project_id, work_item_id
        ),
      CHECK (canonical_status IN (
        'preview', 'running', 'waiting', 'blocked', 'partial', 'unverified',
        'failed', 'canceled', 'succeeded'
      )),
      CHECK (status_revision >= 1),
      CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (event_sha256 ~ '^[a-f0-9]{64}$')
    );

    CREATE TABLE IF NOT EXISTS omni_work_compatibility_mappings (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      mapping_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_owner_actor_id TEXT NOT NULL,
      canonical_owner_actor_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      work_item_id TEXT,
      state TEXT NOT NULL,
      quarantine_code TEXT,
      source_revision_sha256 TEXT NOT NULL,
      mapping_revision BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, mapping_id),
      UNIQUE (tenant_id, source_kind, source_id),
      CHECK (schema_version = 1),
      CHECK (source_kind IN (
        'legacy_project', 'legacy_project_task',
        'legacy_mission', 'legacy_mission_task'
      )),
      CHECK (state IN ('active', 'quarantined')),
      CHECK (quarantine_code IS NULL OR quarantine_code IN (
        'actor_unmapped', 'tenant_membership_missing', 'scope_ambiguous',
        'parent_mapping_missing', 'status_conflict'
      )),
      CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (mapping_revision >= 1),
      CHECK (
        (state = 'active' AND quarantine_code IS NULL
          AND canonical_owner_actor_id IS NOT NULL
          AND workspace_id IS NOT NULL AND project_id IS NOT NULL)
        OR
        (state = 'quarantined' AND quarantine_code IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS omni_work_backfill_checkpoints (
      tenant_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      cursor_id TEXT,
      processed_count BIGINT NOT NULL DEFAULT 0,
      quarantined_count BIGINT NOT NULL DEFAULT 0,
      checkpoint_revision BIGINT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, scope_kind),
      CHECK (scope_kind IN ('legacy_projects', 'legacy_missions')),
      CHECK (state IN ('running', 'completed', 'failed')),
      CHECK (processed_count >= 0 AND quarantined_count >= 0),
      CHECK (checkpoint_revision >= 1)
    );

    CREATE INDEX IF NOT EXISTS omni_work_projects_owner_updated_idx
      ON omni_work_projects (tenant_id, owner_actor_id, updated_at DESC, project_id);
    CREATE INDEX IF NOT EXISTS omni_work_project_memberships_actor_idx
      ON omni_work_project_memberships
      (tenant_id, subject_actor_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS omni_work_items_project_status_idx
      ON omni_work_items
      (tenant_id, workspace_id, project_id, canonical_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS omni_work_items_owner_gin_idx
      ON omni_work_items USING GIN (owner_actor_ids);
    CREATE INDEX IF NOT EXISTS omni_work_item_status_history_time_idx
      ON omni_work_item_status_history
      (tenant_id, workspace_id, project_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS omni_work_compatibility_target_idx
      ON omni_work_compatibility_mappings
      (tenant_id, workspace_id, project_id, work_item_id);

    CREATE OR REPLACE FUNCTION omni_protect_canonical_work_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Canonical work records cannot be deleted or truncated'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF TG_TABLE_NAME = 'omni_work_item_status_history' THEN
          RAISE EXCEPTION 'Canonical WorkItem status history is append-only'
            USING ERRCODE = '55000';
        ELSIF TG_TABLE_NAME = 'omni_work_projects' AND (
          NEW.tenant_id <> OLD.tenant_id
          OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.project_id <> OLD.project_id
          OR NEW.owner_actor_id <> OLD.owner_actor_id
          OR NEW.source_authority <> OLD.source_authority
          OR NEW.source_id <> OLD.source_id
          OR NEW.source_owner_actor_id <> OLD.source_owner_actor_id
          OR NEW.created_at <> OLD.created_at
          OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
          OR NEW.updated_at <= OLD.updated_at
        ) THEN
          RAISE EXCEPTION 'Canonical Project update is invalid'
            USING ERRCODE = '55000';
        ELSIF TG_TABLE_NAME = 'omni_work_items' AND (
          NEW.tenant_id <> OLD.tenant_id
          OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.project_id <> OLD.project_id
          OR NEW.work_item_id <> OLD.work_item_id
          OR NEW.source_authority <> OLD.source_authority
          OR NEW.source_id <> OLD.source_id
          OR NEW.source_owner_actor_id <> OLD.source_owner_actor_id
          OR NEW.created_at <> OLD.created_at
          OR NEW.status_revision <> OLD.status_revision + 1
          OR NEW.updated_at <= OLD.updated_at
        ) THEN
          RAISE EXCEPTION 'Canonical WorkItem update is invalid'
            USING ERRCODE = '55000';
        ELSIF TG_TABLE_NAME = 'omni_work_compatibility_mappings' AND (
          NEW.tenant_id <> OLD.tenant_id
          OR NEW.mapping_id <> OLD.mapping_id
          OR NEW.source_kind <> OLD.source_kind
          OR NEW.source_id <> OLD.source_id
          OR NEW.source_owner_actor_id <> OLD.source_owner_actor_id
          OR NEW.created_at <> OLD.created_at
          OR NEW.mapping_revision <> OLD.mapping_revision + 1
          OR NEW.updated_at <= OLD.updated_at
        ) THEN
          RAISE EXCEPTION 'Canonical compatibility mapping update is invalid'
            USING ERRCODE = '55000';
        ELSIF TG_TABLE_NAME = 'omni_work_project_memberships' AND (
          NEW.tenant_id <> OLD.tenant_id
          OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.project_id <> OLD.project_id
          OR NEW.subject_actor_id <> OLD.subject_actor_id
          OR NEW.created_at <> OLD.created_at
          OR NEW.membership_revision <> OLD.membership_revision + 1
          OR NEW.updated_at <= OLD.updated_at
          OR NOT (OLD.state = 'active' AND NEW.state = 'revoked')
        ) THEN
          RAISE EXCEPTION 'Canonical Project membership update is invalid'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$;

    DO $migration$
    DECLARE table_name TEXT;
    DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
      'omni_work_projects', 'omni_work_project_memberships', 'omni_work_items',
      'omni_work_item_status_history', 'omni_work_compatibility_mappings'
    ];
    BEGIN
      FOREACH table_name IN ARRAY expected_tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
          table_name || '_protect', table_name);
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_canonical_work_v1()',
          table_name || '_protect', table_name
        );
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
          table_name || '_no_truncate', table_name);
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_canonical_work_v1()',
          table_name || '_no_truncate', table_name
        );
      END LOOP;
    END
    $migration$;

    WITH exact_owners AS (
      SELECT DISTINCT source.tenant_id, identifier.canonical_actor_id
      FROM (
        SELECT tenant_id, actor_id FROM omni_projects
        UNION ALL
        SELECT tenant_id, actor_id FROM omni_missions
      ) source
      JOIN omni_auth_user_actor_identifiers identifier
        ON identifier.actor_identifier = source.actor_id
      JOIN omni_auth_users auth_user
        ON auth_user.actor_id = identifier.canonical_actor_id
      JOIN omni_auth_memberships membership
        ON membership.user_id = auth_user.id
        AND membership.tenant_id = source.tenant_id
      WHERE auth_user.status = 'active' AND membership.status = 'active'
    )
    INSERT INTO omni_tenant_workspaces (
      schema_version, tenant_id, workspace_id, display_name, owner_actor_id,
      state, lifecycle_revision, created_by_actor_id, activated_by_actor_id,
      created_at, activated_at, updated_at
    )
    SELECT 1, tenant_id,
      'workspace:personal:' || substring(canonical_actor_id FROM 7),
      'Personal workspace', canonical_actor_id, 'active', 1,
      canonical_actor_id, canonical_actor_id,
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    FROM exact_owners
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING;

    INSERT INTO omni_tenant_workspace_memberships (
      schema_version, tenant_id, workspace_id, subject_kind, subject_key,
      subject_actor_id, subject_execution_principal_id,
      subject_execution_principal_generation, membership_generation,
      access_level, state, lifecycle_revision, created_by_actor_id,
      activated_by_actor_id, created_at, activated_at, updated_at
    )
    SELECT 1, workspace.tenant_id, workspace.workspace_id, 'user',
      workspace.owner_actor_id, workspace.owner_actor_id, NULL, NULL, 1,
      'manager', 'active', 1, workspace.owner_actor_id,
      workspace.owner_actor_id, workspace.created_at,
      workspace.activated_at, workspace.updated_at
    FROM omni_tenant_workspaces workspace
    WHERE workspace.state = 'active'
      AND workspace.workspace_id LIKE 'workspace:personal:%'
    ON CONFLICT (
      tenant_id, workspace_id, subject_key, membership_generation
    ) DO NOTHING;

    WITH project_sources AS (
      SELECT project.*, identifier.canonical_actor_id,
        'workspace:personal:' || substring(identifier.canonical_actor_id FROM 7)
          AS canonical_workspace_id,
        encode(sha256(convert_to(jsonb_build_object(
          'id', project.id, 'actorId', project.actor_id,
          'title', project.title, 'objective', project.objective,
          'status', project.status, 'targetDate', project.target_date,
          'completedAt', project.completed_at, 'updatedAt', project.updated_at
        )::TEXT, 'UTF8')), 'hex') AS source_sha256
      FROM omni_projects project
      JOIN omni_auth_user_actor_identifiers identifier
        ON identifier.actor_identifier = project.actor_id
    ), inserted_projects AS (
      INSERT INTO omni_work_projects (
        schema_version, tenant_id, workspace_id, project_id, owner_actor_id,
        title, objective, lifecycle_status, source_authority, source_id,
        source_owner_actor_id, target_date, lifecycle_revision,
        source_revision_sha256, projection_sha256, projection,
        created_at, updated_at, completed_at
      )
      SELECT 1, tenant_id, canonical_workspace_id, id, canonical_actor_id,
        title, objective, status, 'legacy_project', id, actor_id, target_date, 1,
        source_sha256, source_sha256,
        jsonb_build_object(
          'schemaVersion', 1, 'tenantId', tenant_id,
          'workspaceId', canonical_workspace_id, 'projectId', id,
          'ownerActorId', canonical_actor_id, 'title', title,
          'objective', objective, 'lifecycleStatus', status,
          'sourceAuthority', 'legacy_project', 'lifecycleRevision', 1,
          'targetDate', target_date, 'createdAt', created_at,
          'updatedAt', updated_at, 'completedAt', completed_at
        ), created_at, updated_at, completed_at
      FROM project_sources
      ON CONFLICT (tenant_id, source_authority, source_id) DO NOTHING
      RETURNING tenant_id, workspace_id, project_id, owner_actor_id,
        created_at, updated_at
    )
    INSERT INTO omni_work_project_memberships (
      tenant_id, workspace_id, project_id, subject_actor_id, access_level,
      state, membership_revision, created_at, updated_at
    )
    SELECT tenant_id, workspace_id, project_id, owner_actor_id, 'manager',
      'active', 1, created_at, updated_at
    FROM inserted_projects
    ON CONFLICT DO NOTHING;

    WITH mission_sources AS (
      SELECT mission.*, identifier.canonical_actor_id,
        'workspace:personal:' || substring(identifier.canonical_actor_id FROM 7)
          AS canonical_workspace_id,
        'mission_project:' || mission.id AS canonical_project_id,
        encode(sha256(convert_to(jsonb_build_object(
          'id', mission.id, 'actorId', mission.actor_id,
          'title', mission.title, 'objective', mission.objective,
          'status', mission.status, 'updatedAt', mission.updated_at
        )::TEXT, 'UTF8')), 'hex') AS source_sha256
      FROM omni_missions mission
      JOIN omni_auth_user_actor_identifiers identifier
        ON identifier.actor_identifier = mission.actor_id
    ), inserted_projects AS (
      INSERT INTO omni_work_projects (
        schema_version, tenant_id, workspace_id, project_id, owner_actor_id,
        title, objective, lifecycle_status, source_authority, source_id,
        source_owner_actor_id, target_date, lifecycle_revision,
        source_revision_sha256, projection_sha256, projection,
        created_at, updated_at, completed_at
      )
      SELECT 1, tenant_id, canonical_workspace_id, canonical_project_id,
        canonical_actor_id, title, objective,
        CASE status WHEN 'draft' THEN 'draft' WHEN 'archived' THEN 'archived'
          WHEN 'succeeded' THEN 'completed' WHEN 'failed' THEN 'completed'
          WHEN 'canceled' THEN 'completed' ELSE 'active' END,
        'legacy_mission', id, actor_id, NULL, 1, source_sha256, source_sha256,
        jsonb_build_object(
          'schemaVersion', 1, 'tenantId', tenant_id,
          'workspaceId', canonical_workspace_id,
          'projectId', canonical_project_id, 'ownerActorId', canonical_actor_id,
          'title', title, 'objective', objective,
          'lifecycleStatus', CASE status WHEN 'draft' THEN 'draft'
            WHEN 'archived' THEN 'archived' WHEN 'succeeded' THEN 'completed'
            WHEN 'failed' THEN 'completed' WHEN 'canceled' THEN 'completed'
            ELSE 'active' END,
          'sourceAuthority', 'legacy_mission', 'lifecycleRevision', 1,
          'targetDate', NULL, 'createdAt', created_at,
          'updatedAt', updated_at,
          'completedAt', CASE WHEN status IN ('succeeded', 'failed', 'canceled')
            THEN COALESCE(terminal_at, updated_at) ELSE NULL END
        ), created_at, updated_at,
        CASE WHEN status IN ('succeeded', 'failed', 'canceled')
          THEN COALESCE(terminal_at, updated_at) ELSE NULL END
      FROM mission_sources
      ON CONFLICT (tenant_id, source_authority, source_id) DO NOTHING
      RETURNING tenant_id, workspace_id, project_id, owner_actor_id,
        created_at, updated_at
    )
    INSERT INTO omni_work_project_memberships (
      tenant_id, workspace_id, project_id, subject_actor_id, access_level,
      state, membership_revision, created_at, updated_at
    )
    SELECT tenant_id, workspace_id, project_id, owner_actor_id, 'manager',
      'active', 1, created_at, updated_at
    FROM inserted_projects
    ON CONFLICT DO NOTHING;

    WITH task_sources AS (
      SELECT task.*, project.actor_id,
        canonical_project.workspace_id, canonical_project.owner_actor_id,
        CASE
          WHEN task.workflow_status IN ('dispatching', 'running') THEN 'running'
          WHEN task.workflow_status IN ('queued', 'waiting_approval', 'paused') THEN 'waiting'
          WHEN task.workflow_status = 'failed' THEN 'failed'
          WHEN task.workflow_status = 'canceled' THEN 'canceled'
          WHEN task.workflow_status = 'completed' AND task.status <> 'done' THEN 'partial'
          WHEN task.workflow_status = 'completed' THEN 'unverified'
          WHEN task.workflow_status IS NOT NULL THEN 'unverified'
          WHEN task.status = 'doing' THEN 'running'
          WHEN task.status = 'done' THEN 'unverified'
          ELSE 'waiting'
        END AS projected_status,
        encode(sha256(convert_to(jsonb_build_object(
          'id', task.id, 'status', task.status,
          'workflowStatus', task.workflow_status, 'title', task.title,
          'detail', task.detail, 'priority', task.priority,
          'agentId', task.agent_id, 'dueAt', task.due_at,
          'dependencies', task.dependency_ids, 'updatedAt', task.updated_at
        )::TEXT, 'UTF8')), 'hex') AS source_sha256
      FROM omni_project_tasks task
      JOIN omni_projects project
        ON project.tenant_id = task.tenant_id AND project.id = task.project_id
      JOIN omni_work_projects canonical_project
        ON canonical_project.tenant_id = task.tenant_id
        AND canonical_project.source_authority = 'legacy_project'
        AND canonical_project.source_id = task.project_id
    )
    INSERT INTO omni_work_items (
      schema_version, tenant_id, workspace_id, project_id, work_item_id,
      parent_work_item_id, kind, title, detail, priority, canonical_status,
      source_status, status_revision, source_authority, source_id,
      source_owner_actor_id, dependency_work_item_ids, owner_actor_ids,
      assigned_agents, schedule, recurrence, risks, decisions, artifacts,
      source_revision_sha256, projection_sha256, projection,
      created_at, updated_at, terminal_at
    )
    SELECT 1, source.tenant_id, source.workspace_id, source.project_id,
      source.id, NULL, 'task', source.title, source.detail, source.priority,
      source.projected_status,
      source.status || COALESCE(':' || source.workflow_status, ''), 1,
      'legacy_project_task', source.id, source.actor_id,
      COALESCE((SELECT jsonb_agg(value ORDER BY value)
        FROM (SELECT DISTINCT item #>> '{}' AS value
          FROM jsonb_array_elements(source.dependency_ids) item
          WHERE jsonb_typeof(item) = 'string') dependencies), '[]'::JSONB),
      jsonb_build_array(source.owner_actor_id),
      jsonb_build_array(jsonb_build_object(
        'agentId', source.agent_id, 'principalId', NULL,
        'principalGeneration', NULL
      )),
      jsonb_build_object('startsAt', NULL, 'dueAt', source.due_at, 'timeZone', NULL),
      NULL, '[]'::JSONB, '[]'::JSONB,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'artifactId', artifact.id, 'kind', 'project_artifact',
          'evidenceRefIds', to_jsonb(artifact.evidence_refs)
        ) ORDER BY artifact.id)
        FROM omni_project_artifacts artifact
        WHERE artifact.tenant_id = source.tenant_id
          AND artifact.task_id = source.id), '[]'::JSONB),
      source.source_sha256, source.source_sha256,
      jsonb_build_object(
        'schemaVersion', 1, 'tenantId', source.tenant_id,
        'workspaceId', source.workspace_id, 'projectId', source.project_id,
        'workItemId', source.id, 'parentWorkItemId', NULL, 'kind', 'task',
        'title', source.title, 'detail', source.detail,
        'priority', source.priority, 'canonicalStatus', source.projected_status,
        'sourceStatus', source.status || COALESCE(':' || source.workflow_status, ''),
        'statusRevision', 1, 'sourceAuthority', 'legacy_project_task'
      ), source.created_at, source.updated_at,
      CASE WHEN source.projected_status IN ('unverified', 'failed', 'canceled')
        THEN COALESCE(source.completed_at, source.updated_at) ELSE NULL END
    FROM task_sources source
    ON CONFLICT (tenant_id, source_authority, source_id) DO NOTHING;

    WITH mission_sources AS (
      SELECT mission.*, canonical_project.workspace_id,
        canonical_project.project_id AS canonical_project_id,
        canonical_project.owner_actor_id,
        CASE status WHEN 'draft' THEN 'preview' WHEN 'queued' THEN 'waiting'
          WHEN 'running' THEN 'running' WHEN 'waiting' THEN 'waiting'
          WHEN 'succeeded' THEN 'unverified' WHEN 'failed' THEN 'failed'
          WHEN 'canceled' THEN 'canceled' ELSE 'unverified' END AS projected_status,
        encode(sha256(convert_to(jsonb_build_object(
          'id', mission.id, 'status', mission.status,
          'title', mission.title, 'objective', mission.objective,
          'updatedAt', mission.updated_at
        )::TEXT, 'UTF8')), 'hex') AS source_sha256
      FROM omni_missions mission
      JOIN omni_work_projects canonical_project
        ON canonical_project.tenant_id = mission.tenant_id
        AND canonical_project.source_authority = 'legacy_mission'
        AND canonical_project.source_id = mission.id
    )
    INSERT INTO omni_work_items (
      schema_version, tenant_id, workspace_id, project_id, work_item_id,
      parent_work_item_id, kind, title, detail, priority, canonical_status,
      source_status, status_revision, source_authority, source_id,
      source_owner_actor_id, dependency_work_item_ids, owner_actor_ids,
      assigned_agents, schedule, recurrence, risks, decisions, artifacts,
      source_revision_sha256, projection_sha256, projection,
      created_at, updated_at, terminal_at
    )
    SELECT 1, tenant_id, workspace_id, canonical_project_id,
      'mission_root:' || id, NULL, 'milestone', title, objective, priority,
      projected_status, status, 1, 'legacy_mission', id, actor_id,
      '[]'::JSONB, jsonb_build_array(owner_actor_id), '[]'::JSONB,
      jsonb_build_object('startsAt', started_at, 'dueAt', NULL, 'timeZone', NULL),
      NULL, '[]'::JSONB, '[]'::JSONB, '[]'::JSONB,
      source_sha256, source_sha256,
      jsonb_build_object(
        'schemaVersion', 1, 'tenantId', tenant_id,
        'workspaceId', workspace_id, 'projectId', canonical_project_id,
        'workItemId', 'mission_root:' || id, 'parentWorkItemId', NULL,
        'kind', 'milestone', 'title', title, 'detail', objective,
        'priority', priority, 'canonicalStatus', projected_status,
        'sourceStatus', status, 'statusRevision', 1,
        'sourceAuthority', 'legacy_mission'
      ), created_at, updated_at,
      CASE WHEN projected_status IN ('unverified', 'failed', 'canceled')
        THEN COALESCE(terminal_at, updated_at) ELSE NULL END
    FROM mission_sources
    ON CONFLICT (tenant_id, source_authority, source_id) DO NOTHING;

    WITH task_sources AS (
      SELECT task.*, canonical_project.workspace_id,
        canonical_project.project_id AS canonical_project_id,
        canonical_project.owner_actor_id,
        CASE task.status WHEN 'triage' THEN 'waiting'
          WHEN 'pending' THEN 'waiting' WHEN 'running' THEN 'running'
          WHEN 'blocked' THEN 'blocked' WHEN 'review' THEN 'waiting'
          WHEN 'succeeded' THEN 'unverified' WHEN 'failed' THEN 'failed'
          WHEN 'canceled' THEN 'canceled' ELSE 'unverified' END AS projected_status,
        encode(sha256(convert_to(jsonb_build_object(
          'id', task.id, 'status', task.status, 'title', task.title,
          'instructions', task.instructions, 'priority', task.priority,
          'dependencies', task.dependency_ids, 'metadata', task.metadata,
          'updatedAt', task.updated_at
        )::TEXT, 'UTF8')), 'hex') AS source_sha256
      FROM omni_mission_tasks task
      JOIN omni_work_projects canonical_project
        ON canonical_project.tenant_id = task.tenant_id
        AND canonical_project.source_authority = 'legacy_mission'
        AND canonical_project.source_id = task.mission_id
    )
    INSERT INTO omni_work_items (
      schema_version, tenant_id, workspace_id, project_id, work_item_id,
      parent_work_item_id, kind, title, detail, priority, canonical_status,
      source_status, status_revision, source_authority, source_id,
      source_owner_actor_id, dependency_work_item_ids, owner_actor_ids,
      assigned_agents, schedule, recurrence, risks, decisions, artifacts,
      source_revision_sha256, projection_sha256, projection,
      created_at, updated_at, terminal_at
    )
    SELECT 1, source.tenant_id, source.workspace_id,
      source.canonical_project_id, source.id,
      COALESCE(source.parent_task_id, 'mission_root:' || source.mission_id),
      'task', source.title, source.instructions, source.priority,
      source.projected_status, source.status, 1, 'legacy_mission_task',
      source.id, source.actor_id,
      COALESCE((SELECT jsonb_agg(dependency ORDER BY dependency)
        FROM (SELECT DISTINCT unnest(source.dependency_ids) AS dependency)
          dependencies), '[]'::JSONB),
      jsonb_build_array(source.owner_actor_id),
      CASE WHEN NULLIF(source.metadata ->> 'assigneeKey', '') IS NULL
        THEN '[]'::JSONB ELSE jsonb_build_array(jsonb_build_object(
          'agentId', source.metadata ->> 'assigneeKey', 'principalId', NULL,
          'principalGeneration', NULL
        )) END,
      jsonb_build_object(
        'startsAt', source.started_at,
        'dueAt', CASE WHEN pg_input_is_valid(
          NULLIF(source.metadata ->> 'scheduledAt', ''), 'timestamptz'
        ) THEN (source.metadata ->> 'scheduledAt')::TIMESTAMPTZ ELSE NULL END,
        'timeZone', NULL
      ), NULL, '[]'::JSONB, '[]'::JSONB,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'artifactId', artifact.id, 'kind', artifact.kind,
          'evidenceRefIds', '[]'::JSONB
        ) ORDER BY artifact.id)
        FROM omni_mission_artifacts artifact
        WHERE artifact.tenant_id = source.tenant_id
          AND artifact.task_id = source.id), '[]'::JSONB),
      source.source_sha256, source.source_sha256,
      jsonb_build_object(
        'schemaVersion', 1, 'tenantId', source.tenant_id,
        'workspaceId', source.workspace_id,
        'projectId', source.canonical_project_id,
        'workItemId', source.id,
        'parentWorkItemId', COALESCE(
          source.parent_task_id, 'mission_root:' || source.mission_id
        ), 'kind', 'task', 'title', source.title,
        'detail', source.instructions, 'priority', source.priority,
        'canonicalStatus', source.projected_status,
        'sourceStatus', source.status, 'statusRevision', 1,
        'sourceAuthority', 'legacy_mission_task'
      ), source.created_at, source.updated_at,
      CASE WHEN source.projected_status IN ('unverified', 'failed', 'canceled')
        THEN COALESCE(source.terminal_at, source.updated_at) ELSE NULL END
    FROM task_sources source
    ON CONFLICT (tenant_id, source_authority, source_id) DO NOTHING;

    INSERT INTO omni_work_item_status_history (
      tenant_id, workspace_id, project_id, work_item_id, status_revision,
      canonical_status, source_status, source_revision_sha256,
      event_sha256, occurred_at
    )
    SELECT tenant_id, workspace_id, project_id, work_item_id, status_revision,
      canonical_status, source_status, source_revision_sha256,
      encode(sha256(convert_to(jsonb_build_object(
        'tenantId', tenant_id, 'workspaceId', workspace_id,
        'projectId', project_id, 'workItemId', work_item_id,
        'statusRevision', status_revision, 'canonicalStatus', canonical_status,
        'sourceStatus', source_status,
        'sourceRevisionSha256', source_revision_sha256
      )::TEXT, 'UTF8')), 'hex'), updated_at
    FROM omni_work_items
    ON CONFLICT DO NOTHING;

    INSERT INTO omni_work_compatibility_mappings (
      schema_version, tenant_id, mapping_id, source_kind, source_id,
      source_owner_actor_id, canonical_owner_actor_id, workspace_id,
      project_id, work_item_id, state, quarantine_code,
      source_revision_sha256, mapping_revision, created_at, updated_at
    )
    SELECT 1, project.tenant_id,
      'work_compat:' || left(encode(sha256(convert_to(
        'legacy_project:' || project.tenant_id || ':' || project.source_id,
        'UTF8')), 'hex'), 40),
      'legacy_project', project.source_id, project.source_owner_actor_id,
      project.owner_actor_id, project.workspace_id, project.project_id,
      NULL, 'active', NULL, project.source_revision_sha256, 1,
      project.created_at, project.updated_at
    FROM omni_work_projects project
    WHERE project.source_authority = 'legacy_project'
    ON CONFLICT (tenant_id, source_kind, source_id) DO NOTHING;

    INSERT INTO omni_work_compatibility_mappings (
      schema_version, tenant_id, mapping_id, source_kind, source_id,
      source_owner_actor_id, canonical_owner_actor_id, workspace_id,
      project_id, work_item_id, state, quarantine_code,
      source_revision_sha256, mapping_revision, created_at, updated_at
    )
    SELECT 1, item.tenant_id,
      'work_compat:' || left(encode(sha256(convert_to(
        item.source_authority || ':' || item.tenant_id || ':' || item.source_id,
        'UTF8')), 'hex'), 40),
      item.source_authority, item.source_id, item.source_owner_actor_id,
      project.owner_actor_id, item.workspace_id, item.project_id,
      item.work_item_id, 'active', NULL, item.source_revision_sha256, 1,
      item.created_at, item.updated_at
    FROM omni_work_items item
    JOIN omni_work_projects project
      ON project.tenant_id = item.tenant_id
      AND project.workspace_id = item.workspace_id
      AND project.project_id = item.project_id
    ON CONFLICT (tenant_id, source_kind, source_id) DO NOTHING;

    INSERT INTO omni_work_compatibility_mappings (
      schema_version, tenant_id, mapping_id, source_kind, source_id,
      source_owner_actor_id, canonical_owner_actor_id, workspace_id,
      project_id, work_item_id, state, quarantine_code,
      source_revision_sha256, mapping_revision, created_at, updated_at
    )
    SELECT 1, source.tenant_id,
      'work_compat:' || left(encode(sha256(convert_to(
        source.source_kind || ':' || source.tenant_id || ':' || source.id,
        'UTF8')), 'hex'), 40),
      source.source_kind, source.id, source.actor_id,
      NULL, NULL, NULL, NULL, 'quarantined', 'actor_unmapped',
      encode(sha256(convert_to(jsonb_build_object(
        'sourceKind', source.source_kind, 'id', source.id,
        'actorId', source.actor_id, 'updatedAt', source.updated_at
      )::TEXT, 'UTF8')), 'hex'), 1, source.created_at, source.updated_at
    FROM (
      SELECT tenant_id, id, actor_id, created_at, updated_at,
        'legacy_project'::TEXT AS source_kind FROM omni_projects
      UNION ALL
      SELECT task.tenant_id, task.id, project.actor_id,
        task.created_at, task.updated_at, 'legacy_project_task'::TEXT
      FROM omni_project_tasks task
      JOIN omni_projects project
        ON project.tenant_id = task.tenant_id AND project.id = task.project_id
      UNION ALL
      SELECT tenant_id, id, actor_id, created_at, updated_at,
        'legacy_mission'::TEXT FROM omni_missions
      UNION ALL
      SELECT tenant_id, id, actor_id, created_at, updated_at,
        'legacy_mission_task'::TEXT FROM omni_mission_tasks
    ) source
    WHERE NOT EXISTS (
      SELECT 1 FROM omni_work_compatibility_mappings mapping
      WHERE mapping.tenant_id = source.tenant_id
        AND mapping.source_kind = source.source_kind
        AND mapping.source_id = source.id
    )
    ON CONFLICT (tenant_id, source_kind, source_id) DO NOTHING;

    INSERT INTO omni_work_backfill_checkpoints (
      tenant_id, scope_kind, state, cursor_id, processed_count,
      quarantined_count, checkpoint_revision, started_at, updated_at, completed_at
    )
    SELECT tenant_id, scope_kind, 'completed', max(id), count(*),
      count(*) FILTER (WHERE mapping_state = 'quarantined'), 1,
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    FROM (
      SELECT project.tenant_id, 'legacy_projects'::TEXT AS scope_kind,
        project.id, mapping.state AS mapping_state
      FROM omni_projects project
      LEFT JOIN omni_work_compatibility_mappings mapping
        ON mapping.tenant_id = project.tenant_id
        AND mapping.source_kind = 'legacy_project'
        AND mapping.source_id = project.id
      UNION ALL
      SELECT mission.tenant_id, 'legacy_missions'::TEXT,
        mission.id, mapping.state
      FROM omni_missions mission
      LEFT JOIN omni_work_compatibility_mappings mapping
        ON mapping.tenant_id = mission.tenant_id
        AND mapping.source_kind = 'legacy_mission'
        AND mapping.source_id = mission.id
    ) source
    GROUP BY tenant_id, scope_kind
    ON CONFLICT (tenant_id, scope_kind) DO NOTHING;

    REVOKE ALL ON FUNCTION omni_actor_scope_v1_allows_canonical(TEXT, TEXT)
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_ensure_personal_workspace_v1(TEXT, TEXT)
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_workspace_authority_v1()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_protect_canonical_work_v1()
      FROM PUBLIC;
    REVOKE ALL ON TABLE omni_work_projects,
      omni_work_project_memberships, omni_work_items,
      omni_work_item_status_history, omni_work_compatibility_mappings,
      omni_work_backfill_checkpoints FROM PUBLIC;

    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT EXECUTE ON FUNCTION omni_actor_scope_v1_allows_canonical(TEXT, TEXT)
          TO omni_runtime;
        GRANT EXECUTE ON FUNCTION omni_ensure_personal_workspace_v1(TEXT, TEXT)
          TO omni_runtime;
        GRANT SELECT ON omni_tenant_workspaces,
          omni_tenant_workspace_memberships TO omni_runtime;
        GRANT SELECT, INSERT, UPDATE ON omni_work_projects,
          omni_work_items, omni_work_compatibility_mappings TO omni_runtime;
        GRANT SELECT, INSERT ON omni_work_project_memberships,
          omni_work_item_status_history TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT ON omni_tenant_workspaces,
          omni_tenant_workspace_memberships, omni_work_projects,
          omni_work_project_memberships, omni_work_items,
          omni_work_item_status_history, omni_work_compatibility_mappings,
          omni_work_backfill_checkpoints TO omni_maintenance;
      END IF;
    END
    $migration$;

DO $migration$
DECLARE policy_table TEXT;
BEGIN
  FOREACH policy_table IN ARRAY ARRAY[
    'omni_work_projects',
    'omni_work_project_memberships',
    'omni_work_items',
    'omni_work_item_status_history',
    'omni_work_compatibility_mappings',
    'omni_work_backfill_checkpoints'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', policy_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', policy_table);
    IF EXISTS (
      SELECT 1 FROM pg_policy policy
      WHERE policy.polrelid = to_regclass(policy_table)
        AND policy.polname = 'omni_tenant_isolation'
    ) THEN
      EXECUTE format(
        'ALTER POLICY omni_tenant_isolation ON %I USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
        policy_table
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY omni_tenant_isolation ON %I FOR ALL USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
        policy_table
      );
    END IF;
  END LOOP;
END
$migration$;

DROP POLICY IF EXISTS omni_workspace_authority_holdback
      ON omni_tenant_workspaces;
    DROP POLICY IF EXISTS omni_workspace_membership_holdback
      ON omni_tenant_workspace_memberships;
    DROP POLICY IF EXISTS omni_workspace_member_scope
      ON omni_tenant_workspaces;
    CREATE POLICY omni_workspace_member_scope
      ON omni_tenant_workspaces AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled() OR EXISTS (
          SELECT 1 FROM omni_tenant_workspace_memberships membership
          WHERE membership.tenant_id = omni_tenant_workspaces.tenant_id
            AND membership.workspace_id = omni_tenant_workspaces.workspace_id
            AND membership.subject_kind = 'user'
            AND membership.state = 'active'
            AND omni_actor_scope_v1_allows_canonical(
              membership.tenant_id, membership.subject_actor_id
            )
        )
      )
      WITH CHECK (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );
    DROP POLICY IF EXISTS omni_workspace_membership_subject_scope
      ON omni_tenant_workspace_memberships;
    CREATE POLICY omni_workspace_membership_subject_scope
      ON omni_tenant_workspace_memberships AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled() OR (
          subject_kind = 'user' AND
          omni_actor_scope_v1_allows_canonical(tenant_id, subject_actor_id)
        )
      )
      WITH CHECK (
        omni_system_scope_enabled() OR (
          subject_kind = 'user' AND
          omni_actor_scope_v1_allows_canonical(tenant_id, subject_actor_id)
        )
      );

    DROP POLICY IF EXISTS omni_work_project_member_actor_scope
      ON omni_work_project_memberships;
    CREATE POLICY omni_work_project_member_actor_scope
      ON omni_work_project_memberships AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(tenant_id, subject_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(tenant_id, subject_actor_id)
      );

    DROP POLICY IF EXISTS omni_work_project_explicit_scope
      ON omni_work_projects;
    CREATE POLICY omni_work_project_explicit_scope
      ON omni_work_projects AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled() OR EXISTS (
          SELECT 1 FROM omni_work_project_memberships membership
          WHERE membership.tenant_id = omni_work_projects.tenant_id
            AND membership.workspace_id = omni_work_projects.workspace_id
            AND membership.project_id = omni_work_projects.project_id
            AND membership.state = 'active'
        )
      )
      WITH CHECK (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );

    DO $migration$
    DECLARE table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'omni_work_items', 'omni_work_item_status_history'
      ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
          table_name || '_project_scope', table_name);
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (omni_system_scope_enabled() OR EXISTS (SELECT 1 FROM omni_work_project_memberships membership WHERE membership.tenant_id = %I.tenant_id AND membership.workspace_id = %I.workspace_id AND membership.project_id = %I.project_id AND membership.state = ''active'')) WITH CHECK (omni_system_scope_enabled() OR EXISTS (SELECT 1 FROM omni_work_project_memberships membership WHERE membership.tenant_id = %I.tenant_id AND membership.workspace_id = %I.workspace_id AND membership.project_id = %I.project_id AND membership.state = ''active''))',
          table_name || '_project_scope', table_name,
          table_name, table_name, table_name, table_name, table_name, table_name
        );
      END LOOP;
    END
    $migration$;

    DROP POLICY IF EXISTS omni_work_compatibility_mapping_scope
      ON omni_work_compatibility_mappings;
    CREATE POLICY omni_work_compatibility_mapping_scope
      ON omni_work_compatibility_mappings AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(
          tenant_id, canonical_owner_actor_id
        )
      )
      WITH CHECK (
        omni_system_scope_enabled() OR
        omni_actor_scope_v1_allows_canonical(
          tenant_id, canonical_owner_actor_id
        )
      );

    DROP POLICY IF EXISTS omni_work_backfill_system_scope
      ON omni_work_backfill_checkpoints;
    CREATE POLICY omni_work_backfill_system_scope
      ON omni_work_backfill_checkpoints AS RESTRICTIVE FOR ALL
      USING (omni_system_scope_enabled())
      WITH CHECK (omni_system_scope_enabled());

    DO $migration$
    DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
      'omni_work_projects', 'omni_work_project_memberships', 'omni_work_items',
      'omni_work_item_status_history', 'omni_work_compatibility_mappings',
      'omni_work_backfill_checkpoints'
    ];
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class relation
        WHERE relation.relname = ANY(expected_tables)
          AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
      ) OR (
        SELECT count(*) FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        WHERE relation.relname = ANY(expected_tables)
          AND NOT policy.polpermissive AND policy.polcmd = '*'
      ) <> cardinality(expected_tables) THEN
        RAISE EXCEPTION 'Canonical work RLS boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  128,
  'canonical_work_model_v1',
  '04e10243d48983a00192987e1a2cb0f4b7dc00a1609a13d172495e911c85c59c',
  clock_timestamp()
);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 128
      AND name = 'canonical_work_model_v1'
      AND checksum = '04e10243d48983a00192987e1a2cb0f4b7dc00a1609a13d172495e911c85c59c'
  ) <> 1 THEN
    RAISE EXCEPTION 'Canonical work model migration integrity check failed'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

COMMIT;

