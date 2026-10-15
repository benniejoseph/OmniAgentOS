BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 257 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 257
      AND name = 'responsibility_reviewed_recovery_v1'
      AND checksum = 'd233101cd24985d298426d8ea143aabea2ae4ae5d5cbf4167a2eb5b3ccd3f8c5'
  ) <> 1 THEN
    RAISE EXCEPTION 'Asael navigation predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- Add only fixed Asael screen navigation to the existing governed courier.
-- Preserve all tenant, actor, exact device/session, lease, replay and RLS fences.
-- No credentials, arbitrary URLs/routes or approval operations are introduced.
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
      'type', 'key', 'scroll', 'open_url', 'run_command', 'open_asael',
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


CREATE OR REPLACE FUNCTION public.omni_local_computer_platform_action_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE device_platform TEXT; device_contract INTEGER;
BEGIN
  SELECT device.platform, device.native_contract_version INTO device_platform, device_contract
  FROM public.omni_local_computer_sessions session
  JOIN public.omni_local_computer_devices device
    ON device.tenant_id = session.tenant_id AND device.owner_actor_id = session.owner_actor_id
    AND device.device_id = session.device_id AND device.mobile_session_id = session.mobile_session_id
  WHERE session.tenant_id = NEW.tenant_id AND session.id = NEW.session_id
    AND session.owner_actor_id = NEW.owner_actor_id AND session.device_id = NEW.device_id;
  IF device_platform IS NULL OR
    (device_platform = 'android' AND NEW.action NOT IN ('observe','list_apps','open_app','press','tap','type','scroll','swipe','back','home')) OR
    (device_platform = 'macos' AND NEW.action NOT IN ('observe','list_apps','activate_app','press','click','type','key','scroll','open_url','run_command','open_asael'))
    OR (NEW.action = 'open_asael' AND device_contract < 58) THEN
    RAISE EXCEPTION 'Native command does not match its exact platform/session binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
-- CREATE OR REPLACE preserves the existing private function ACL and trigger.
-- The native contract floor is checked again at enqueue and claim.
INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (258, 'local_asael_navigation_v1',
  'b260eca85260f4c22e8d205f1665029ee5c02bf407e53ecac600d85b2f05c3db', clock_timestamp());
COMMIT;
