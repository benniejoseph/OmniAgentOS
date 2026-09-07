BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 118
      AND name = 'a2a_task_mappings_v1'
      AND checksum = '79e1d6eab1184b8737e08f128ae49d6c966b53d7386d36c1e94efd5974085f8c'
  ) <> 1 THEN
    RAISE EXCEPTION 'A2A delegation safety predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_a2a_safety_reservations (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  safety_id TEXT NOT NULL,
  safety_sha256 TEXT NOT NULL,
  internal_task_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  parent_execution_id TEXT NOT NULL,
  parent_delegation_id TEXT,
  root_delegation_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  rollout_id TEXT NOT NULL,
  rollout_sha256 TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  recursion_depth SMALLINT NOT NULL,
  reserved_cost_microusd BIGINT NOT NULL,
  max_tool_calls INTEGER NOT NULL,
  progress_timeout_ms INTEGER NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  reservation JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tool_calls_used INTEGER NOT NULL DEFAULT 0,
  progress_revision BIGINT NOT NULL DEFAULT 0,
  last_progress_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, safety_id),
  UNIQUE (tenant_id, internal_task_id),
  UNIQUE (tenant_id, owner_actor_id, safety_id, internal_task_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (char_length(safety_id) BETWEEN 1 AND 240),
  CHECK (safety_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(internal_task_id) BETWEEN 1 AND 240),
  CHECK (char_length(delegation_id) BETWEEN 1 AND 240),
  CHECK (char_length(parent_execution_id) BETWEEN 1 AND 240),
  CHECK (parent_delegation_id IS NULL OR char_length(parent_delegation_id) BETWEEN 1 AND 240),
  CHECK (char_length(root_delegation_id) BETWEEN 1 AND 240),
  CHECK (char_length(peer_id) BETWEEN 1 AND 240),
  CHECK (char_length(rollout_id) BETWEEN 1 AND 240),
  CHECK (rollout_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (recursion_depth BETWEEN 0 AND 2),
  CHECK (reserved_cost_microusd BETWEEN 0 AND 500000),
  CHECK (max_tool_calls BETWEEN 0 AND 4),
  CHECK (progress_timeout_ms BETWEEN 1000 AND 300000),
  CHECK (status IN ('active', 'completed', 'challenged', 'canceled', 'expired')),
  CHECK (tool_calls_used BETWEEN 0 AND max_tool_calls),
  CHECK (progress_revision BETWEEN 0 AND 9007199254740991),
  CHECK ((status = 'active') = (terminal_at IS NULL)),
  CHECK (created_at <= last_progress_at),
  CHECK (created_at < deadline_at),
  CHECK (terminal_at IS NULL OR terminal_at >= created_at),
  CHECK (jsonb_typeof(reservation) = 'object'),
  CHECK (reservation->>'version' = 'p8.7-a2a-safety-reservation:1'),
  CHECK (reservation->>'safetyId' = safety_id),
  CHECK (reservation->>'safetySha256' = safety_sha256),
  CHECK (reservation->>'tenantId' = tenant_id),
  CHECK (reservation->>'ownerActorId' = owner_actor_id),
  CHECK (reservation->>'internalTaskId' = internal_task_id),
  CHECK (reservation->>'delegationId' = delegation_id),
  CHECK ((reservation->>'parentDelegationId') IS NOT DISTINCT FROM parent_delegation_id),
  CHECK (reservation->>'rootDelegationId' = root_delegation_id),
  CHECK (reservation->>'peerId' = peer_id),
  CHECK (reservation->>'rolloutId' = rollout_id),
  CHECK (reservation->>'rolloutSha256' = rollout_sha256),
  CHECK (reservation->>'contractSha256' = contract_sha256),
  CHECK ((reservation->>'recursionDepth')::SMALLINT = recursion_depth),
  CHECK ((reservation->'budgets'->>'costMicrousd')::BIGINT = reserved_cost_microusd),
  CHECK ((reservation->>'maxToolCalls')::INTEGER = max_tool_calls),
  CHECK ((reservation->>'progressTimeoutMs')::INTEGER = progress_timeout_ms),
  CHECK ((reservation->>'deadlineAt')::TIMESTAMPTZ = deadline_at),
  CHECK ((reservation->>'createdAt')::TIMESTAMPTZ = created_at),
  CHECK (reservation->>'trustTier' = 'external_untrusted'),
  CHECK ((reservation->>'forceMutationApproval')::BOOLEAN),
  CHECK (NOT (reservation->>'canRedelegate')::BOOLEAN),
  CHECK (jsonb_array_length(reservation->'ancestorDelegationIds') = recursion_depth),
  CHECK (jsonb_array_length(reservation->'peerTrail') = recursion_depth + 1),
  FOREIGN KEY (owner_actor_id)
    REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, internal_task_id)
    REFERENCES omni_delegation_tasks (tenant_id, task_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, rollout_id)
    REFERENCES omni_a2a_peer_rollouts (tenant_id, rollout_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS omni_a2a_safety_active_root_idx
ON omni_a2a_safety_reservations (
  tenant_id, owner_actor_id, root_delegation_id, parent_delegation_id
) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS omni_a2a_safety_abandoned_idx
ON omni_a2a_safety_reservations (
  tenant_id, status, deadline_at, last_progress_at
) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS omni_a2a_tool_call_claims (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_sha256 TEXT NOT NULL,
  safety_id TEXT NOT NULL,
  internal_task_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, claim_id),
  CHECK (schema_version = 1),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (char_length(claim_id) BETWEEN 1 AND 240),
  CHECK (claim_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(safety_id) BETWEEN 1 AND 240),
  CHECK (char_length(internal_task_id) BETWEEN 1 AND 240),
  CHECK (char_length(tool_id) BETWEEN 1 AND 240),
  FOREIGN KEY (tenant_id, owner_actor_id, safety_id, internal_task_id)
    REFERENCES omni_a2a_safety_reservations (
      tenant_id, owner_actor_id, safety_id, internal_task_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS omni_a2a_tool_claims_task_idx
ON omni_a2a_tool_call_claims (
  tenant_id, owner_actor_id, internal_task_id, created_at
);

CREATE OR REPLACE FUNCTION omni_protect_a2a_safety_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'A2A safety records cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'omni_a2a_tool_call_claims' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'A2A tool-call claims are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.tool_calls_used <> 0
      OR NEW.progress_revision <> 0 OR NEW.terminal_at IS NOT NULL
      OR NEW.last_progress_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'Initial A2A safety reservation is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active'
    OR NEW.status NOT IN ('active', 'completed', 'challenged', 'canceled', 'expired')
    OR NEW.progress_revision IS DISTINCT FROM OLD.progress_revision + 1
    OR NEW.last_progress_at < OLD.last_progress_at
    OR NEW.tool_calls_used NOT IN (OLD.tool_calls_used, OLD.tool_calls_used + 1)
    OR (NEW.tool_calls_used = OLD.tool_calls_used + 1 AND NEW.status <> 'active')
    OR ROW(
      NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id, NEW.safety_id,
      NEW.safety_sha256, NEW.internal_task_id, NEW.delegation_id,
      NEW.parent_execution_id, NEW.parent_delegation_id,
      NEW.root_delegation_id, NEW.peer_id, NEW.rollout_id,
      NEW.rollout_sha256, NEW.contract_sha256, NEW.recursion_depth,
      NEW.reserved_cost_microusd, NEW.max_tool_calls,
      NEW.progress_timeout_ms, NEW.deadline_at, NEW.reservation,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id, OLD.safety_id,
      OLD.safety_sha256, OLD.internal_task_id, OLD.delegation_id,
      OLD.parent_execution_id, OLD.parent_delegation_id,
      OLD.root_delegation_id, OLD.peer_id, OLD.rollout_id,
      OLD.rollout_sha256, OLD.contract_sha256, OLD.recursion_depth,
      OLD.reserved_cost_microusd, OLD.max_tool_calls,
      OLD.progress_timeout_ms, OLD.deadline_at, OLD.reservation,
      OLD.created_at
    )
  THEN
    RAISE EXCEPTION 'A2A safety lifecycle mutation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_a2a_safety_reservations', 'omni_a2a_tool_call_claims'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_a2a_safety_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_a2a_safety_v1()',
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

REVOKE ALL ON TABLE omni_a2a_safety_reservations FROM PUBLIC;
REVOKE ALL ON TABLE omni_a2a_tool_call_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_a2a_safety_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_a2a_safety_reservations FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE omni_a2a_tool_call_claims FROM omni_runtime';
    GRANT SELECT, INSERT ON omni_a2a_safety_reservations TO omni_runtime;
    GRANT UPDATE (
      status, tool_calls_used, progress_revision, last_progress_at, terminal_at
    ) ON omni_a2a_safety_reservations TO omni_runtime;
    GRANT SELECT, INSERT ON omni_a2a_tool_call_claims TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE omni_a2a_safety_reservations FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE omni_a2a_tool_call_claims FROM omni_maintenance';
    GRANT SELECT, INSERT ON omni_a2a_safety_reservations TO omni_maintenance;
    GRANT UPDATE (
      status, tool_calls_used, progress_revision, last_progress_at, terminal_at
    ) ON omni_a2a_safety_reservations TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_a2a_tool_call_claims TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name IN ('omni_a2a_safety_reservations', 'omni_a2a_tool_call_claims')
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema = current_schema()
      AND table_name = 'omni_a2a_safety_reservations'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
      AND column_name NOT IN (
        'status', 'tool_calls_used', 'progress_revision', 'last_progress_at', 'terminal_at'
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN ('omni_a2a_safety_reservations', 'omni_a2a_tool_call_claims')
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'omni_a2a_safety_reservations'::regclass,
      'omni_a2a_tool_call_claims'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 2 THEN
    RAISE EXCEPTION 'A2A delegation safety boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  119,
  'a2a_delegation_safety_v1',
  'fd3a418e621c8763c1d1850e287c098e69fa805f79a0ab00e399d67f4b3d76bc',
  NOW()
);

COMMIT;
