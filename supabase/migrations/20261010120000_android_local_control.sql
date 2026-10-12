BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 248 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 248
      AND name = 'personal_profiles_v1'
      AND checksum = '032b554dec2e7f1e7d811180e9e74aa5170ec1418b79136a3f152cf84ffa2cdd'
  ) <> 1 THEN
    RAISE EXCEPTION 'Android control predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- Preserve the existing owner/device/session foreign keys, RLS, leases and
-- uncertain-effect state machine. Android uses the same ledger, with its own
-- platform, contract floor and a closed action family; no terminal authority.
ALTER TABLE public.omni_local_computer_devices DROP CONSTRAINT omni_local_computer_devices_row_check;
ALTER TABLE public.omni_local_computer_devices
  ADD CONSTRAINT omni_local_computer_devices_row_check CHECK (COALESCE(
    schema_version = 1 AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> '' AND btrim(user_id) <> ''
    AND btrim(mobile_session_id) <> ''
    AND device_id ~ '^[A-Za-z0-9._:-]{8,200}$'
    AND ((platform = 'macos' AND native_contract_version >= 11) OR (platform = 'android' AND native_contract_version >= 53))
    AND helper_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND jsonb_typeof(permission_status) = 'object'
    AND pg_column_size(permission_status) <= 4096
    AND activity_state IN ('idle', 'active', 'stopped', 'error')
    AND lifecycle_revision >= 1
    AND last_seen_at <= updated_at + INTERVAL '30 seconds'
    AND lease_expires_at <= updated_at + INTERVAL '30 seconds'
    AND created_at <= updated_at
    AND ((enabled AND stopped_at IS NULL) OR (NOT enabled))
  , FALSE)) NOT VALID;
ALTER TABLE public.omni_local_computer_devices VALIDATE CONSTRAINT omni_local_computer_devices_row_check;

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
      'type', 'key', 'scroll', 'open_url', 'run_command',
      'open_app', 'tap', 'swipe', 'back', 'home'
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

CREATE FUNCTION public.omni_local_computer_platform_action_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE device_platform TEXT;
BEGIN
  SELECT device.platform INTO device_platform
  FROM public.omni_local_computer_sessions session
  JOIN public.omni_local_computer_devices device
    ON device.tenant_id = session.tenant_id AND device.owner_actor_id = session.owner_actor_id
    AND device.device_id = session.device_id AND device.mobile_session_id = session.mobile_session_id
  WHERE session.tenant_id = NEW.tenant_id AND session.id = NEW.session_id
    AND session.owner_actor_id = NEW.owner_actor_id AND session.device_id = NEW.device_id;
  IF device_platform IS NULL OR
    (device_platform = 'android' AND NEW.action NOT IN ('observe','list_apps','open_app','press','tap','type','scroll','swipe','back','home')) OR
    (device_platform = 'macos' AND NEW.action NOT IN ('observe','list_apps','activate_app','press','click','type','key','scroll','open_url','run_command')) THEN
    RAISE EXCEPTION 'Native command does not match its exact platform/session binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.omni_local_computer_platform_action_v1() FROM PUBLIC;
CREATE TRIGGER omni_local_computer_platform_action BEFORE INSERT OR UPDATE OF action, session_id, device_id, tenant_id, owner_actor_id
ON public.omni_local_computer_commands FOR EACH ROW EXECUTE FUNCTION public.omni_local_computer_platform_action_v1();

-- The queue retains an explicit phone target; it must never downgrade to Asael.
DO $queue_target$
DECLARE constraint_name TEXT; matches INTEGER := 0;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.omni_prompt_queue_items'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%executionTarget%'
      AND pg_get_constraintdef(oid) LIKE '%local_macos%'
  LOOP
    matches := matches + 1;
    EXECUTE format('ALTER TABLE public.omni_prompt_queue_items DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  IF matches <> 1 THEN RAISE EXCEPTION 'Prompt queue target constraint is not the expected predecessor'; END IF;
END
$queue_target$;
ALTER TABLE public.omni_prompt_queue_items ADD CONSTRAINT omni_prompt_queue_items_execution_target_v53
  CHECK (target ->> 'executionTarget' IN ('asael', 'local_macos', 'local_android')) NOT VALID;
ALTER TABLE public.omni_prompt_queue_items VALIDATE CONSTRAINT omni_prompt_queue_items_execution_target_v53;

INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (249, 'android_local_control_v1',
  '0078bbaccb6ea94da05a158220ddcca027e83cca776bbfd1375732362c7bd168', clock_timestamp());
COMMIT;
