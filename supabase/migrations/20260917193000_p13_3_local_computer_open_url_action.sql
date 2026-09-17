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

  IF latest_version IS DISTINCT FROM 181 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 181
      AND name = 'isolated_browser_runtime_retirement_v1'
      AND checksum = '2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d'
  ) <> 1 THEN
    RAISE EXCEPTION 'Local Computer Use open-URL predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Contract v13 added the governed open_url command after the original local
-- runtime table shipped. Replace only the action whitelist; every identity,
-- lifecycle, payload-size, digest, and timestamp invariant remains unchanged.
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
      'type', 'key', 'scroll', 'open_url'
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
    FROM pg_constraint
    WHERE conrelid = 'public.omni_local_computer_commands'::regclass
      AND conname = 'omni_local_computer_commands_row_check'
      AND contype = 'c'
      AND convalidated
      AND position(
        '''open_url''' IN pg_get_constraintdef(oid, true)
      ) > 0
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_local_computer_commands
    WHERE action NOT IN (
      'observe', 'list_apps', 'activate_app', 'press', 'click',
      'type', 'key', 'scroll', 'open_url'
    )
  ) THEN
    RAISE EXCEPTION 'Local Computer Use command action boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  182,
  'p13_3_local_computer_open_url_action_v1',
  '46a2975c9099d954bc7f7ff6aa537076f14f8dce274e53f33826a38471d1f5e4',
  clock_timestamp()
);

COMMIT;
