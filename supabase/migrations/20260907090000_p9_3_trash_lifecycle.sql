BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 119
      AND name = 'a2a_delegation_safety_v1'
      AND checksum = 'fd3a418e621c8763c1d1850e287c098e69fa805f79a0ab00e399d67f4b3d76bc'
  ) <> 1 THEN
    RAISE EXCEPTION 'Trash lifecycle predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_trash_items (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  trash_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  target_sha256 TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'retained',
  lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  item JSONB NOT NULL,
  snapshot JSONB,
  trashed_at TIMESTAMPTZ NOT NULL,
  restore_until TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, trash_id),
  UNIQUE (tenant_id, owner_actor_id, trash_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (trash_id ~ '^trash:[0-9a-f-]{36}$'),
  CHECK (resource_type IN (
    'custom_agent', 'agent_skill', 'mcp_connector', 'openapi_connector'
  )),
  CHECK (char_length(resource_id) BETWEEN 1 AND 240),
  CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state IN ('retained', 'restored', 'purged', 'expired')),
  CHECK (lifecycle_revision BETWEEN 1 AND 9007199254740991),
  CHECK (trashed_at < restore_until),
  CHECK ((state = 'retained') = (snapshot IS NOT NULL)),
  CHECK ((state = 'retained') = (terminal_at IS NULL)),
  CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'),
  CHECK (octet_length(COALESCE(snapshot::TEXT, '')) <= 1000000),
  CHECK (jsonb_typeof(item) = 'object'),
  CHECK (item->>'version' = 'p9.3-trash-item:1'),
  CHECK (item->>'trashId' = trash_id),
  CHECK (item->>'tenantId' = tenant_id),
  CHECK (item->>'ownerActorId' = owner_actor_id),
  CHECK (item->>'resourceType' = resource_type),
  CHECK (item->>'resourceId' = resource_id),
  CHECK (item->>'targetSha256' = target_sha256),
  CHECK (item->>'snapshotSha256' = snapshot_sha256),
  CHECK (item->>'state' = state),
  CHECK ((item->>'lifecycleRevision')::BIGINT = lifecycle_revision),
  CHECK ((item->>'trashedAt')::TIMESTAMPTZ = trashed_at),
  CHECK ((item->>'restoreUntil')::TIMESTAMPTZ = restore_until),
  CHECK (
    (state = 'retained'
      AND item->'restoredAt' = 'null'::JSONB
      AND item->'purgedAt' = 'null'::JSONB)
    OR (state = 'restored'
      AND (item->>'restoredAt')::TIMESTAMPTZ = terminal_at
      AND item->'purgedAt' = 'null'::JSONB)
    OR (state IN ('purged', 'expired')
      AND item->'restoredAt' = 'null'::JSONB
      AND (item->>'purgedAt')::TIMESTAMPTZ = terminal_at)
  ),
  FOREIGN KEY (owner_actor_id)
    REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS omni_trash_retained_resource_idx
ON omni_trash_items (tenant_id, owner_actor_id, resource_type, resource_id)
WHERE state = 'retained';

CREATE INDEX IF NOT EXISTS omni_trash_actor_lifecycle_idx
ON omni_trash_items (
  tenant_id, owner_actor_id, state, restore_until, trashed_at DESC
);

CREATE TABLE IF NOT EXISTS omni_trash_effect_receipts (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  preview_sha256 TEXT NOT NULL,
  trash_id TEXT NOT NULL,
  action TEXT NOT NULL,
  receipt JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, receipt_sha256),
  UNIQUE (tenant_id, owner_actor_id, preview_sha256),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (preview_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (trash_id ~ '^trash:[0-9a-f-]{36}$'),
  CHECK (action IN ('trash', 'restore', 'purge', 'expire', 'compensate')),
  CHECK (jsonb_typeof(receipt) = 'object'),
  CHECK (receipt->>'version' = 'p9.3-trash-effect-receipt:1'),
  CHECK (receipt->>'receiptSha256' = receipt_sha256),
  CHECK (receipt->>'previewSha256' = preview_sha256),
  CHECK (receipt->>'trashId' = trash_id),
  CHECK (receipt->>'action' = action),
  CHECK ((receipt->>'occurredAt')::TIMESTAMPTZ = occurred_at),
  FOREIGN KEY (tenant_id, owner_actor_id, trash_id)
    REFERENCES omni_trash_items (tenant_id, owner_actor_id, trash_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS omni_trash_receipts_item_idx
ON omni_trash_effect_receipts (
  tenant_id, owner_actor_id, trash_id, occurred_at DESC
);

CREATE OR REPLACE FUNCTION omni_protect_trash_lifecycle_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Trash audit records cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'omni_trash_effect_receipts' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Trash effect receipts are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'retained' OR NEW.lifecycle_revision <> 1
      OR NEW.snapshot IS NULL OR NEW.terminal_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Initial trash item is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'retained'
    OR NEW.state NOT IN ('restored', 'purged', 'expired')
    OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
    OR NEW.snapshot IS NOT NULL
    OR NEW.terminal_at IS NULL
    OR ROW(
      NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.trash_id,
      NEW.resource_type, NEW.resource_id, NEW.target_sha256,
      NEW.snapshot_sha256, NEW.trashed_at, NEW.restore_until
    ) IS DISTINCT FROM ROW(
      OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.trash_id,
      OLD.resource_type, OLD.resource_id, OLD.target_sha256,
      OLD.snapshot_sha256, OLD.trashed_at, OLD.restore_until
    )
  THEN
    RAISE EXCEPTION 'Trash lifecycle mutation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_trash_items', 'omni_trash_effect_receipts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_trash_lifecycle_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_trash_lifecycle_v1()',
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

REVOKE ALL ON TABLE omni_trash_items FROM PUBLIC;
REVOKE ALL ON TABLE omni_trash_effect_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_trash_lifecycle_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_trash_items FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE omni_trash_effect_receipts FROM omni_runtime';
    GRANT SELECT, INSERT ON omni_trash_items TO omni_runtime;
    GRANT UPDATE (
      state, lifecycle_revision, item, snapshot, terminal_at
    ) ON omni_trash_items TO omni_runtime;
    GRANT SELECT, INSERT ON omni_trash_effect_receipts TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_trash_items FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE omni_trash_effect_receipts FROM omni_maintenance';
    GRANT SELECT, INSERT ON omni_trash_items TO omni_maintenance;
    GRANT UPDATE (
      state, lifecycle_revision, item, snapshot, terminal_at
    ) ON omni_trash_items TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_trash_effect_receipts TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name IN ('omni_trash_items', 'omni_trash_effect_receipts')
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema = current_schema()
      AND table_name = 'omni_trash_items'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
      AND column_name NOT IN (
        'state', 'lifecycle_revision', 'item', 'snapshot', 'terminal_at'
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN ('omni_trash_items', 'omni_trash_effect_receipts')
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'omni_trash_items'::regclass,
      'omni_trash_effect_receipts'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 2 THEN
    RAISE EXCEPTION 'Trash lifecycle boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  120,
  'trash_lifecycle_v1',
  'fadd7e5f0dd81375f49a4d1ddf641efb586a9094884cbee426ec4aa6c22ca44e',
  NOW()
);

COMMIT;
