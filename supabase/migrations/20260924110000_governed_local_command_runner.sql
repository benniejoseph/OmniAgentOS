BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 204 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 204
      AND name = 'google_multi_account_connections_v1'
      AND checksum = '8c7ae456bdbcc92f00adb2f24728cf03dc2b082cae7880e0f87ce71d15314cd8'
  ) <> 1 THEN
    RAISE EXCEPTION 'Governed local command runner predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.omni_local_computer_command_runner_v1_is_valid(
  candidate JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  workspace JSONB;
  workspace_id TEXT;
  workspace_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF candidate IS NULL THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof(candidate) <> 'object'
    OR pg_column_size(candidate) > 16384
    OR NOT candidate ?& ARRAY['helperInstalled', 'helperVersion', 'workspaces']
    OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 3
    OR jsonb_typeof(candidate->'helperInstalled') <> 'boolean'
    OR jsonb_typeof(candidate->'helperVersion') <> 'string'
    OR candidate->>'helperVersion' !~ '^[0-9]+[.][0-9]+[.][0-9]+$'
    OR jsonb_typeof(candidate->'workspaces') <> 'array'
    OR jsonb_array_length(candidate->'workspaces') > 32
  THEN
    RETURN FALSE;
  END IF;
  IF NOT (candidate->>'helperInstalled')::BOOLEAN
    AND jsonb_array_length(candidate->'workspaces') <> 0
  THEN
    RETURN FALSE;
  END IF;
  FOR workspace IN
    SELECT item
    FROM jsonb_array_elements(candidate->'workspaces') AS entries(item)
  LOOP
    IF jsonb_typeof(workspace) <> 'object'
      OR NOT workspace ?& ARRAY['id', 'name']
      OR (SELECT count(*) FROM jsonb_object_keys(workspace)) <> 2
      OR jsonb_typeof(workspace->'id') <> 'string'
      OR workspace->>'id' !~ '^local_workspace_[a-f0-9]{32}$'
      OR jsonb_typeof(workspace->'name') <> 'string'
      OR char_length(workspace->>'name') NOT BETWEEN 1 AND 120
      OR workspace->>'name' <> btrim(workspace->>'name')
      OR workspace->>'name' ~ '[[:cntrl:]]'
    THEN
      RETURN FALSE;
    END IF;
    workspace_id := workspace->>'id';
    IF workspace_id = ANY(workspace_ids) THEN
      RETURN FALSE;
    END IF;
    workspace_ids := array_append(workspace_ids, workspace_id);
  END LOOP;
  RETURN TRUE;
END
$function$;

ALTER TABLE public.omni_local_computer_devices
  ADD COLUMN IF NOT EXISTS command_runner JSONB;
ALTER TABLE public.omni_local_computer_devices
  DROP CONSTRAINT IF EXISTS omni_local_computer_devices_command_runner_check;
ALTER TABLE public.omni_local_computer_devices
  ADD CONSTRAINT omni_local_computer_devices_command_runner_check
  CHECK (public.omni_local_computer_command_runner_v1_is_valid(command_runner))
  NOT VALID;
ALTER TABLE public.omni_local_computer_devices
  VALIDATE CONSTRAINT omni_local_computer_devices_command_runner_check;

-- Native contract v27 adds only the separately signed, workspace-scoped
-- direct-process action. Preserve every other command-row invariant verbatim.
ALTER TABLE public.omni_local_computer_commands
  DROP CONSTRAINT IF EXISTS omni_local_computer_commands_row_check;
ALTER TABLE public.omni_local_computer_commands
  ADD CONSTRAINT omni_local_computer_commands_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^local_computer_command_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND device_id ~ '^[A-Za-z0-9._:-]{8,200}$'
    AND char_length(btrim(execution_id)) BETWEEN 1 AND 240
    AND action IN (
      'observe', 'list_apps', 'activate_app', 'press', 'click',
      'type', 'key', 'scroll', 'open_url', 'run_command'
    )
    AND input_sha256 ~ '^[0-9a-f]{64}$'
    AND state IN (
      'queued', 'claimed', 'completed', 'failed', 'canceled',
      'expired', 'consumed'
    )
    AND claim_generation >= 0
    AND (
      (state = 'queued' AND claim_token_sha256 IS NULL)
      OR state <> 'queued'
    )
    AND (
      claim_token_sha256 IS NULL
      OR claim_token_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (
      (claimed_at IS NULL AND claim_expires_at IS NULL)
      OR (claimed_at IS NOT NULL AND claim_expires_at > claimed_at)
    )
    AND (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'canceled'))
    AND (result IS NULL OR (
      jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 2097152
    ))
    AND (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$')
    AND (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 160)
    AND expires_at > created_at
    AND created_at <= updated_at
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (consumed_at IS NULL OR completed_at IS NOT NULL)
  , FALSE)) NOT VALID;
ALTER TABLE public.omni_local_computer_commands
  VALIDATE CONSTRAINT omni_local_computer_commands_row_check;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_local_computer_devices'
      AND column_name = 'command_runner'
      AND data_type = 'jsonb'
      AND is_nullable = 'YES'
  ) OR to_regprocedure(
    'public.omni_local_computer_command_runner_v1_is_valid(jsonb)'
  ) IS NULL OR (
    SELECT count(*)
    FROM pg_constraint
    WHERE conname IN (
      'omni_local_computer_devices_command_runner_check',
      'omni_local_computer_commands_row_check'
    )
      AND contype = 'c'
      AND convalidated
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.omni_local_computer_commands'::regclass
      AND conname = 'omni_local_computer_commands_row_check'
      AND position('''run_command''' IN pg_get_constraintdef(oid, true)) > 0
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_local_computer_devices
    WHERE NOT public.omni_local_computer_command_runner_v1_is_valid(command_runner)
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_local_computer_commands
    WHERE action NOT IN (
      'observe', 'list_apps', 'activate_app', 'press', 'click',
      'type', 'key', 'scroll', 'open_url', 'run_command'
    )
  ) THEN
    RAISE EXCEPTION 'Governed local command runner storage boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  205,
  'governed_local_command_runner_v1',
  'a9c301b4ef3030962b2ae9f69b8df9c2cb2914e90b0d9c8a3c6032f91691015a',
  clock_timestamp()
);

COMMIT;
