BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 121
      AND name = 'approval_grants_v1'
      AND checksum = '74a51bdd87e583b6380533d34571455ba717829e390de8ef0806b2a818f37bd6'
  ) <> 1 THEN
    RAISE EXCEPTION 'Browser profile predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_browser_profiles (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  allowed_domains TEXT[] NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  consented_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, profile_id),
  UNIQUE (tenant_id, owner_actor_id, profile_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (profile_id ~ '^browser_profile:[0-9a-f-]{36}$'),
  CHECK (char_length(name) BETWEEN 1 AND 120),
  CHECK (cardinality(allowed_domains) BETWEEN 1 AND 20),
  CHECK (state IN ('active', 'revoked')),
  CHECK (lifecycle_revision BETWEEN 1 AND 9007199254740991),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (consented_at <= updated_at),
  CHECK (created_at <= updated_at),
  CHECK (last_used_at IS NULL OR last_used_at >= consented_at)
);

CREATE INDEX IF NOT EXISTS omni_browser_profiles_owner_state_idx
ON omni_browser_profiles (tenant_id, owner_actor_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS omni_browser_profile_bindings (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision BIGINT NOT NULL,
  allowed_domains TEXT[] NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, owner_actor_id, execution_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (char_length(execution_id) BETWEEN 1 AND 320),
  CHECK (profile_id ~ '^browser_profile:[0-9a-f-]{36}$'),
  CHECK (profile_revision BETWEEN 1 AND 9007199254740991),
  CHECK (cardinality(allowed_domains) BETWEEN 1 AND 20),
  FOREIGN KEY (tenant_id, owner_actor_id, profile_id)
    REFERENCES omni_browser_profiles (tenant_id, owner_actor_id, profile_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS omni_browser_profile_bindings_profile_idx
ON omni_browser_profile_bindings (
  tenant_id, owner_actor_id, profile_id, bound_at DESC
);

CREATE TABLE IF NOT EXISTS omni_browser_takeovers (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  takeover_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  profile_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  action_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_action_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, takeover_id),
  UNIQUE (tenant_id, owner_actor_id, takeover_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (takeover_id ~ '^browser_takeover:[0-9a-f-]{36}$'),
  CHECK (char_length(run_id) BETWEEN 1 AND 240),
  CHECK (char_length(execution_id) BETWEEN 1 AND 240),
  CHECK (profile_id IS NULL OR profile_id ~ '^browser_profile:[0-9a-f-]{36}$'),
  CHECK (state IN ('active', 'released', 'expired', 'revoked')),
  CHECK (action_count BETWEEN 0 AND 10000),
  CHECK (started_at < expires_at),
  CHECK (expires_at <= started_at + INTERVAL '10 minutes'),
  CHECK ((state = 'active') = (released_at IS NULL)),
  CHECK (last_action_at IS NULL OR last_action_at >= started_at),
  FOREIGN KEY (tenant_id, owner_actor_id, profile_id)
    REFERENCES omni_browser_profiles (tenant_id, owner_actor_id, profile_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS omni_browser_takeovers_one_active_run_idx
ON omni_browser_takeovers (tenant_id, owner_actor_id, run_id)
WHERE state = 'active';

CREATE INDEX IF NOT EXISTS omni_browser_takeovers_expiry_idx
ON omni_browser_takeovers (tenant_id, expires_at)
WHERE state = 'active';

CREATE OR REPLACE FUNCTION omni_protect_browser_profiles_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Browser profile records cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'omni_browser_profile_bindings' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Browser profile bindings are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'omni_browser_takeovers' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state <> 'active' OR NEW.action_count <> 0
        OR NEW.last_action_at IS NOT NULL OR NEW.released_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Initial browser takeover is invalid'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF ROW(
      NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.takeover_id,
      NEW.run_id, NEW.execution_id, NEW.profile_id, NEW.started_at, NEW.expires_at
    ) IS DISTINCT FROM ROW(
      OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.takeover_id,
      OLD.run_id, OLD.execution_id, OLD.profile_id, OLD.started_at, OLD.expires_at
    ) OR NOT (
      (OLD.state = 'active' AND NEW.state = 'active'
        AND NEW.action_count = OLD.action_count + 1
        AND NEW.last_action_at IS NOT NULL
        AND NEW.released_at IS NULL)
      OR (OLD.state = 'active' AND NEW.state IN ('released', 'expired', 'revoked')
        AND NEW.action_count = OLD.action_count
        AND NEW.last_action_at IS NOT DISTINCT FROM OLD.last_action_at
        AND NEW.released_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Browser takeover lifecycle mutation is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.lifecycle_revision <> 1
      OR NEW.revoked_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Initial browser profile is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.profile_id,
    NEW.consented_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.profile_id,
    OLD.consented_at, OLD.created_at
  ) OR NOT (
    (OLD.state = 'active' AND NEW.state = 'active'
      AND NEW.lifecycle_revision = OLD.lifecycle_revision
      AND NEW.name = OLD.name
      AND NEW.allowed_domains = OLD.allowed_domains
      AND NEW.last_used_at IS NOT NULL
      AND (OLD.last_used_at IS NULL OR NEW.last_used_at >= OLD.last_used_at)
      AND NEW.revoked_at IS NULL)
    OR (OLD.state = 'active' AND NEW.state = 'active'
      AND NEW.lifecycle_revision = OLD.lifecycle_revision + 1
      AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
      AND NEW.revoked_at IS NULL)
    OR (OLD.state = 'active' AND NEW.state = 'revoked'
      AND NEW.lifecycle_revision = OLD.lifecycle_revision + 1
      AND NEW.name = OLD.name
      AND NEW.allowed_domains = OLD.allowed_domains
      AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
      AND NEW.revoked_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Browser profile lifecycle mutation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_browser_profiles',
    'omni_browser_profile_bindings',
    'omni_browser_takeovers'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_browser_profiles_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_browser_profiles_v1()',
      table_name || '_no_truncate', table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_actor', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE omni_browser_profiles FROM PUBLIC;
REVOKE ALL ON TABLE omni_browser_profile_bindings FROM PUBLIC;
REVOKE ALL ON TABLE omni_browser_takeovers FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_browser_profiles_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_browser_profiles FROM omni_runtime;
    REVOKE ALL ON TABLE omni_browser_profile_bindings FROM omni_runtime;
    REVOKE ALL ON TABLE omni_browser_takeovers FROM omni_runtime;
    GRANT SELECT, INSERT ON omni_browser_profiles TO omni_runtime;
    GRANT UPDATE (
      name, allowed_domains, state, lifecycle_revision,
      last_used_at, revoked_at, updated_at
    ) ON omni_browser_profiles TO omni_runtime;
    GRANT SELECT, INSERT ON omni_browser_profile_bindings TO omni_runtime;
    GRANT SELECT, INSERT ON omni_browser_takeovers TO omni_runtime;
    GRANT UPDATE (
      state, action_count, last_action_at, released_at
    ) ON omni_browser_takeovers TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE omni_browser_profiles FROM omni_maintenance;
    REVOKE ALL ON TABLE omni_browser_profile_bindings FROM omni_maintenance;
    REVOKE ALL ON TABLE omni_browser_takeovers FROM omni_maintenance;
    GRANT SELECT ON omni_browser_profiles TO omni_maintenance;
    GRANT SELECT ON omni_browser_profile_bindings TO omni_maintenance;
    GRANT SELECT ON omni_browser_takeovers TO omni_maintenance;
    GRANT UPDATE (state, released_at) ON omni_browser_takeovers TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN (
      'omni_browser_profiles',
      'omni_browser_profile_bindings',
      'omni_browser_takeovers'
    ) AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'omni_browser_profiles'::regclass,
      'omni_browser_profile_bindings'::regclass,
      'omni_browser_takeovers'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 3 THEN
    RAISE EXCEPTION 'Browser profile boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  122,
  'browser_takeover_profiles_v1',
  'ee32a9191756e79b13799f8e5bbf0768a962f7501194c222bb481ef9fa2e47d4',
  NOW()
);

COMMIT;
