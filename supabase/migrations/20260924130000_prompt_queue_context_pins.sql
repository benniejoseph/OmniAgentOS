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

  IF latest_version IS DISTINCT FROM 205 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 205
      AND name = 'governed_local_command_runner_v1'
      AND checksum = 'a9c301b4ef3030962b2ae9f69b8df9c2cb2914e90b0d9c8a3c6032f91691015a'
  ) <> 1 THEN
    RAISE EXCEPTION 'Prompt queue context predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Exact references are sealed separately from the prompt. Only content-free
-- selection/context/receipt digests and a bounded count remain queryable.
ALTER TABLE public.omni_prompt_queue_items
  ADD COLUMN sealed_context_references JSONB,
  ADD COLUMN context_selection_sha256 TEXT,
  ADD COLUMN context_block_sha256 TEXT,
  ADD COLUMN context_receipt_sha256 TEXT,
  ADD COLUMN context_reference_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE public.omni_prompt_queue_items
  ADD CONSTRAINT omni_prompt_queue_context_pin_valid CHECK (
    (
      context_reference_count = 0
      AND sealed_context_references IS NULL
      AND context_selection_sha256 IS NULL
      AND context_block_sha256 IS NULL
      AND context_receipt_sha256 IS NULL
    ) OR (
      context_reference_count BETWEEN 1 AND 20
      AND context_selection_sha256 ~ '^[a-f0-9]{64}$'
      AND context_block_sha256 ~ '^[a-f0-9]{64}$'
      AND context_receipt_sha256 ~ '^[a-f0-9]{64}$'
      AND (
        (state = 'deleted' AND sealed_context_references IS NULL)
        OR (
          state <> 'deleted'
          AND jsonb_typeof(sealed_context_references) = 'object'
          AND pg_column_size(sealed_context_references) <= 65536
        )
      )
    )
  );

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
    NEW.agent_pin, NEW.model_pin, NEW.sealed_context_references,
    NEW.context_selection_sha256, NEW.context_block_sha256,
    NEW.context_receipt_sha256, NEW.context_reference_count
  ) IS DISTINCT FROM ROW(
    OLD.sealed_prompt, OLD.prompt_sha256, OLD.prompt_characters,
    OLD.agent_pin, OLD.model_pin, OLD.sealed_context_references,
    OLD.context_selection_sha256, OLD.context_block_sha256,
    OLD.context_receipt_sha256, OLD.context_reference_count
  ) AND NOT (
    (
      OLD.state IN ('queued', 'paused', 'failed')
      AND NEW.state IN ('queued', 'paused')
    ) OR (
      NEW.state = 'deleted'
      AND NEW.sealed_prompt IS NULL
      AND NEW.sealed_context_references IS NULL
      AND ROW(
        NEW.prompt_sha256, NEW.prompt_characters,
        NEW.agent_pin, NEW.model_pin,
        NEW.context_selection_sha256, NEW.context_block_sha256,
        NEW.context_receipt_sha256, NEW.context_reference_count
      ) IS NOT DISTINCT FROM ROW(
        OLD.prompt_sha256, OLD.prompt_characters,
        OLD.agent_pin, OLD.model_pin,
        OLD.context_selection_sha256, OLD.context_block_sha256,
        OLD.context_receipt_sha256, OLD.context_reference_count
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

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_prompt_queue_items FROM omni_runtime';
    GRANT SELECT, INSERT ON public.omni_prompt_queue_items TO omni_runtime;
    GRANT UPDATE (
      last_modified_session_id, sealed_prompt, prompt_sha256,
      prompt_characters, agent_pin, model_pin, sealed_context_references,
      context_selection_sha256, context_block_sha256,
      context_receipt_sha256, context_reference_count, state, position_key,
      lifecycle_revision, dispatch_token_sha256,
      dispatch_lease_expires_at, run_id, result_thread_id,
      progress_label, failure_code, updated_at, dispatched_at, terminal_at
    ) ON public.omni_prompt_queue_items TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_prompt_queue_items FROM omni_maintenance';
    GRANT SELECT, INSERT ON public.omni_prompt_queue_items TO omni_maintenance;
    GRANT UPDATE (
      last_modified_session_id, sealed_prompt, prompt_sha256,
      prompt_characters, agent_pin, model_pin, sealed_context_references,
      context_selection_sha256, context_block_sha256,
      context_receipt_sha256, context_reference_count, state, position_key,
      lifecycle_revision, dispatch_token_sha256,
      dispatch_lease_expires_at, run_id, result_thread_id,
      progress_label, failure_code, updated_at, dispatched_at, terminal_at
    ) ON public.omni_prompt_queue_items TO omni_maintenance;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_prompt_queue_items'::regclass
      AND conname = 'omni_prompt_queue_context_pin_valid'
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
        'prompt_characters', 'agent_pin', 'model_pin',
        'sealed_context_references', 'context_selection_sha256',
        'context_block_sha256', 'context_receipt_sha256',
        'context_reference_count', 'state', 'position_key',
        'lifecycle_revision', 'dispatch_token_sha256',
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
    ) <> 23
  ) THEN
    RAISE EXCEPTION 'Prompt queue context storage boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  206,
  'prompt_queue_context_pins_v1',
  '5de8d38921e0d4d0f7e79bcfe4745f780ce973b009c874a519d09bfd8f3ff777',
  clock_timestamp()
);

COMMIT;
