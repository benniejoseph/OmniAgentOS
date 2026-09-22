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

  IF latest_version IS DISTINCT FROM 200 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 200
      AND name = 'notification_disposition_runtime_v1'
      AND checksum = '99af5ab52a824c435e19e46f918755bfa549a1fecda22f9061940f9030c97c2b'
  ) <> 1 THEN
    RAISE EXCEPTION 'Prompt queue runtime predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Actor-private queued command text is sealed at rest. The queue retains only
-- exact behavior/runtime/target pins and never carries execution authority.
CREATE TABLE public.omni_prompt_queue_items (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id UUID NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  last_modified_session_id TEXT NOT NULL,
  client_correlation_id TEXT NOT NULL,
  sealed_prompt JSONB,
  prompt_sha256 TEXT NOT NULL,
  prompt_characters INTEGER NOT NULL,
  mode TEXT NOT NULL,
  strategy TEXT NOT NULL,
  target JSONB NOT NULL,
  target_sha256 TEXT NOT NULL,
  agent_pin JSONB NOT NULL,
  model_pin JSONB NOT NULL,
  state TEXT NOT NULL,
  position_key BIGINT NOT NULL,
  lifecycle_revision BIGINT NOT NULL DEFAULT 0,
  dispatch_token_sha256 TEXT,
  dispatch_lease_expires_at TIMESTAMPTZ,
  run_id TEXT,
  result_thread_id TEXT,
  progress_label TEXT,
  failure_code TEXT,
  queue_grants_authority BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  UNIQUE (tenant_id, owner_actor_id, client_correlation_id),
  CHECK (schema_version = 1),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (char_length(origin_session_id) BETWEEN 1 AND 240),
  CHECK (char_length(last_modified_session_id) BETWEEN 1 AND 240),
  CHECK (client_correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'),
  CHECK (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (prompt_characters BETWEEN 1 AND 20000),
  CHECK (mode IN ('orchestrate', 'research', 'execute', 'learn')),
  CHECK (strategy IN ('direct', 'auto')),
  CHECK (jsonb_typeof(target) = 'object' AND pg_column_size(target) <= 4096),
  CHECK (target ?& ARRAY['threadId', 'missionId', 'projectId', 'executionTarget']),
  CHECK (target ->> 'executionTarget' IN ('asael', 'local_macos')),
  CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(agent_pin) = 'object' AND pg_column_size(agent_pin) <= 16384),
  CHECK (agent_pin ?& ARRAY[
    'logicalAgentId', 'definitionId', 'definitionVersion',
    'definitionVersionId', 'definitionSha256', 'principalId',
    'principalGeneration', 'principalVersionId', 'principalSha256'
  ]),
  CHECK (jsonb_typeof(model_pin) = 'object' AND pg_column_size(model_pin) <= 8192),
  CHECK (model_pin ?& ARRAY[
    'providerId', 'modelId', 'tier', 'assignmentId',
    'assignmentRevision', 'assignmentConfigurationSha256',
    'routingPolicySha256'
  ]),
  CHECK (state IN ('queued', 'paused', 'dispatching', 'completed', 'failed', 'deleted')),
  CHECK (position_key BETWEEN 1 AND 9007199254740991),
  CHECK (lifecycle_revision BETWEEN 0 AND 9007199254740991),
  CHECK (dispatch_token_sha256 IS NULL OR dispatch_token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (run_id IS NULL OR char_length(run_id) BETWEEN 1 AND 240),
  CHECK (progress_label IS NULL OR char_length(progress_label) BETWEEN 1 AND 160),
  CHECK (failure_code IS NULL OR failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'),
  CHECK (NOT queue_grants_authority),
  CHECK (created_at <= updated_at),
  CHECK (
    (state = 'deleted' AND sealed_prompt IS NULL)
    OR (state <> 'deleted' AND jsonb_typeof(sealed_prompt) = 'object'
      AND pg_column_size(sealed_prompt) <= 131072)
  ),
  CHECK (
    (state = 'dispatching' AND dispatch_token_sha256 IS NOT NULL
      AND dispatch_lease_expires_at IS NOT NULL
      AND dispatched_at IS NOT NULL AND terminal_at IS NULL)
    OR
    (state <> 'dispatching' AND dispatch_token_sha256 IS NULL
      AND dispatch_lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('completed', 'failed', 'deleted') AND terminal_at IS NOT NULL)
    OR (state NOT IN ('completed', 'failed', 'deleted') AND terminal_at IS NULL)
  ),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (result_thread_id)
    REFERENCES public.omni_threads(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_prompt_queue_items_actor_order_idx
ON public.omni_prompt_queue_items (
  tenant_id, owner_actor_id, position_key, created_at, id
)
WHERE state IN ('queued', 'paused', 'dispatching');

CREATE INDEX omni_prompt_queue_items_dispatch_lease_idx
ON public.omni_prompt_queue_items (
  tenant_id, owner_actor_id, dispatch_lease_expires_at, id
)
WHERE state = 'dispatching';

CREATE OR REPLACE FUNCTION public.omni_protect_prompt_queue_item_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Prompt queue rows cannot be physically removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.lifecycle_revision <> 0
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
      OR NEW.queue_grants_authority
      OR NEW.sealed_prompt IS NULL
    THEN
      RAISE EXCEPTION 'Initial prompt queue state is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.schema_version, NEW.id, NEW.tenant_id, NEW.owner_actor_id,
    NEW.origin_session_id, NEW.client_correlation_id,
    NEW.created_at, NEW.queue_grants_authority
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.id, OLD.tenant_id, OLD.owner_actor_id,
    OLD.origin_session_id, OLD.client_correlation_id,
    OLD.created_at, OLD.queue_grants_authority
  ) OR OLD.state = 'deleted'
    OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Prompt queue identity or revision is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('queued', 'paused', 'dispatching', 'deleted')) OR
    (OLD.state = 'paused' AND NEW.state IN ('paused', 'queued', 'dispatching', 'deleted')) OR
    (OLD.state = 'dispatching' AND NEW.state IN ('dispatching', 'completed', 'failed')) OR
    (OLD.state = 'failed' AND NEW.state IN ('failed', 'queued', 'deleted')) OR
    (OLD.state = 'completed' AND NEW.state IN ('completed', 'deleted'))
  ) THEN
    RAISE EXCEPTION 'Prompt queue lifecycle transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sealed_prompt, NEW.prompt_sha256, NEW.prompt_characters,
    NEW.agent_pin, NEW.model_pin
  ) IS DISTINCT FROM ROW(
    OLD.sealed_prompt, OLD.prompt_sha256, OLD.prompt_characters,
    OLD.agent_pin, OLD.model_pin
  ) AND NOT (
    (
      OLD.state IN ('queued', 'paused', 'failed')
      AND NEW.state IN ('queued', 'paused')
    ) OR (
      NEW.state = 'deleted'
      AND NEW.sealed_prompt IS NULL
      AND ROW(
        NEW.prompt_sha256, NEW.prompt_characters,
        NEW.agent_pin, NEW.model_pin
      ) IS NOT DISTINCT FROM ROW(
        OLD.prompt_sha256, OLD.prompt_characters,
        OLD.agent_pin, OLD.model_pin
      )
    )
  ) THEN
    RAISE EXCEPTION 'Queued command content can change only before dispatch'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.target IS DISTINCT FROM NEW.target
    OR OLD.target_sha256 IS DISTINCT FROM NEW.target_sha256
    OR OLD.mode IS DISTINCT FROM NEW.mode
    OR OLD.strategy IS DISTINCT FROM NEW.strategy
  THEN
    RAISE EXCEPTION 'Queued command target is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_prompt_queue_items_protect
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_prompt_queue_items
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_prompt_queue_item_v1();
CREATE TRIGGER omni_prompt_queue_items_no_truncate
BEFORE TRUNCATE ON public.omni_prompt_queue_items
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_prompt_queue_item_v1();

ALTER TABLE public.omni_prompt_queue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_prompt_queue_items FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_prompt_queue_items AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));

CREATE POLICY omni_prompt_queue_items_actor
ON public.omni_prompt_queue_items AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_prompt_queue_items FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_prompt_queue_item_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_prompt_queue_items TO omni_runtime;
    GRANT UPDATE (
      last_modified_session_id, sealed_prompt, prompt_sha256,
      prompt_characters, agent_pin, model_pin, state, position_key,
      lifecycle_revision, dispatch_token_sha256,
      dispatch_lease_expires_at, run_id, result_thread_id,
      progress_label, failure_code, updated_at, dispatched_at, terminal_at
    ) ON public.omni_prompt_queue_items TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_prompt_queue_items TO omni_maintenance;
    GRANT UPDATE (
      last_modified_session_id, sealed_prompt, prompt_sha256,
      prompt_characters, agent_pin, model_pin, state, position_key,
      lifecycle_revision, dispatch_token_sha256,
      dispatch_lease_expires_at, run_id, result_thread_id,
      progress_label, failure_code, updated_at, dispatched_at, terminal_at
    ) ON public.omni_prompt_queue_items TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_prompt_queue_items TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class relation
    WHERE relation.oid = 'public.omni_prompt_queue_items'::regclass
      AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.omni_prompt_queue_items'::regclass
      AND NOT polpermissive AND polcmd = '*'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_prompt_queue_items'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_prompt_queue_items'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
      AND column_name NOT IN (
        'last_modified_session_id', 'sealed_prompt', 'prompt_sha256',
        'prompt_characters', 'agent_pin', 'model_pin', 'state',
        'position_key', 'lifecycle_revision', 'dispatch_token_sha256',
        'dispatch_lease_expires_at', 'run_id', 'result_thread_id',
        'progress_label', 'failure_code', 'updated_at', 'dispatched_at',
        'terminal_at'
      )
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('omni_runtime'), ('omni_maintenance')) expected(role_name)
    WHERE EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = expected.role_name
    ) AND (
      SELECT count(DISTINCT grant_row.column_name)
      FROM information_schema.role_column_grants grant_row
      WHERE grant_row.table_schema = 'public'
        AND grant_row.table_name = 'omni_prompt_queue_items'
        AND grant_row.grantee = expected.role_name
        AND grant_row.privilege_type = 'UPDATE'
    ) <> 18
  ) THEN
    RAISE EXCEPTION 'Prompt queue runtime boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  201,
  'prompt_queue_runtime_v1',
  'e9cd14ec6c526fbd0fbed097cbc8a535e92b60cfd6bae0785a0a0a6c3b584567',
  clock_timestamp()
);

COMMIT;
