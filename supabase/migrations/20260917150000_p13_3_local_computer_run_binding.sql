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

  IF latest_version IS DISTINCT FROM 179 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 179
      AND name = 'p13_3_local_computer_runtime_v1'
      AND checksum = '68dcf5260d23b7f8e6eb2f14be43e8150a4ca747676b73e6ae27da6502f1fd68'
  ) <> 1 THEN
    RAISE EXCEPTION 'Local Computer Use run-binding predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_local_computer_sessions
  ADD COLUMN IF NOT EXISTS run_id TEXT;

WITH unique_bindings AS (
  SELECT
    event.tenant_id,
    event.actor_id AS owner_actor_id,
    event.correlation_id,
    min(substr(event.stream_id, char_length('run:') + 1)) AS run_id
  FROM public.omni_events event
  JOIN public.omni_agent_runs run
    ON run.tenant_id = event.tenant_id
   AND run.owner_actor_id = event.actor_id
   AND event.stream_id = 'run:' || run.id
  WHERE event.type = 'run.scope_bound'
    AND event.correlation_id IS NOT NULL
  GROUP BY event.tenant_id, event.actor_id, event.correlation_id
  HAVING count(DISTINCT event.stream_id) = 1
)
UPDATE public.omni_local_computer_sessions session
SET run_id = binding.run_id
FROM unique_bindings binding
WHERE session.run_id IS NULL
  AND binding.tenant_id = session.tenant_id
  AND binding.owner_actor_id = session.owner_actor_id
  AND binding.correlation_id = session.correlation_id;

ALTER TABLE public.omni_local_computer_sessions
  DROP CONSTRAINT IF EXISTS omni_local_computer_sessions_run_id_check;
ALTER TABLE public.omni_local_computer_sessions
  ADD CONSTRAINT omni_local_computer_sessions_run_id_check CHECK (
    run_id IS NULL OR (
      run_id = btrim(run_id)
      AND char_length(run_id) BETWEEN 1 AND 240
      AND run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
    )
  ) NOT VALID;
ALTER TABLE public.omni_local_computer_sessions
  VALIDATE CONSTRAINT omni_local_computer_sessions_run_id_check;

-- A device row follows the current native login, while a local session keeps
-- the login that created it. Keep those two lifecycles independently
-- referentially intact so a same-device sign-in never rewrites provenance or
-- blocks the next heartbeat.
ALTER TABLE public.omni_local_computer_sessions
  DROP CONSTRAINT IF EXISTS omni_local_computer_sessions_device_fkey;
ALTER TABLE public.omni_local_computer_sessions
  DROP CONSTRAINT IF EXISTS omni_local_computer_sessions_mobile_session_fkey;
ALTER TABLE public.omni_local_computer_sessions
  ADD CONSTRAINT omni_local_computer_sessions_device_fkey FOREIGN KEY (
    tenant_id, owner_actor_id, device_id
  ) REFERENCES public.omni_local_computer_devices (
    tenant_id, owner_actor_id, device_id
  ) ON UPDATE RESTRICT ON DELETE CASCADE NOT VALID;
ALTER TABLE public.omni_local_computer_sessions
  ADD CONSTRAINT omni_local_computer_sessions_mobile_session_fkey
  FOREIGN KEY (mobile_session_id) REFERENCES public.omni_mobile_sessions (id)
  ON UPDATE RESTRICT ON DELETE CASCADE NOT VALID;
ALTER TABLE public.omni_local_computer_sessions
  VALIDATE CONSTRAINT omni_local_computer_sessions_device_fkey;
ALTER TABLE public.omni_local_computer_sessions
  VALIDATE CONSTRAINT omni_local_computer_sessions_mobile_session_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS omni_local_computer_sessions_run_idx
  ON public.omni_local_computer_sessions (tenant_id, owner_actor_id, run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS omni_local_computer_commands_observation_expiry_idx
  ON public.omni_local_computer_commands (completed_at, tenant_id, id)
  WHERE result ? 'observation';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.omni_local_computer_sessions'::regclass
      AND attname = 'run_id'
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.omni_local_computer_sessions'::regclass
      AND conname = 'omni_local_computer_sessions_run_id_check'
      AND contype = 'c'
      AND convalidated
  ) OR (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'public.omni_local_computer_sessions'::regclass
      AND conname IN (
        'omni_local_computer_sessions_device_fkey',
        'omni_local_computer_sessions_mobile_session_fkey'
      )
      AND contype = 'f'
      AND convalidated
  ) <> 2 OR to_regclass('public.omni_local_computer_sessions_run_idx') IS NULL
    OR to_regclass(
      'public.omni_local_computer_commands_observation_expiry_idx'
    ) IS NULL THEN
    RAISE EXCEPTION 'Local Computer Use run binding is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  180,
  'p13_3_local_computer_run_binding_v1',
  'ff0d067e14965b75e45532f9ee534480fd237ef514c735282652d36a779000b4',
  clock_timestamp()
);

COMMIT;
