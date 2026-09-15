BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 174 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 174 AND name = 'app_builder_repository_workspaces_v1'
      AND checksum = '30f4769a6fcccd41aa457882b6be2752583d7d5920be75597e3b2121e91604d0'
  ) <> 1 THEN
    RAISE EXCEPTION 'Tool execution retention redaction v2 predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.omni_reject_tool_execution_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  is_expired_approval_redaction BOOLEAN;
BEGIN
  is_expired_approval_redaction := COALESCE((
    OLD.input IS DISTINCT FROM NEW.input
    AND OLD.status = 'approval_required'
    AND OLD.approval_decision IS NULL
    AND OLD.effect_receipt IS NULL
    AND OLD.completed_at IS NULL
    AND NEW.status = 'rejected'
    AND NEW.input = '{"redacted":"expired approval"}'::JSONB
    AND NEW.output IS NULL
    AND NEW.reason = 'Approval expired before an operator decision.'
    AND NEW.approval_decision = 'rejected'
    AND NEW.approval_reason = 'Expired by retention policy.'
    AND NEW.effect_receipt IS NULL
    AND NEW.completed_at IS NOT NULL
    AND ROW(
      OLD.approvals,
      OLD.approved_by,
      OLD.approved_at
    ) IS NOT DISTINCT FROM ROW(
      NEW.approvals,
      NEW.approved_by,
      NEW.approved_at
    )
  ), FALSE);

  IF ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.actor_id,
    OLD.tool_id,
    OLD.tool_name,
    OLD.risk_level,
    OLD.dry_run,
    OLD.approval_required,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.actor_id,
    NEW.tool_id,
    NEW.tool_name,
    NEW.risk_level,
    NEW.dry_run,
    NEW.approval_required,
    NEW.created_at
  ) OR (
    OLD.input IS DISTINCT FROM NEW.input
    AND NOT is_expired_approval_redaction
  ) THEN
    RAISE EXCEPTION 'Governed tool execution identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DO $verify$
DECLARE function_definition TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'public.omni_reject_tool_execution_identity_change()'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL
    OR position('OLD.output IS NULL' IN function_definition) <> 0
    OR position('NEW.output IS NULL' IN function_definition) = 0
    OR position('OLD.approvals' IN function_definition) = 0
    OR position('Expired by retention policy.' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Tool execution retention redaction v2 verification failed' USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  175,
  'tool_execution_retention_redaction_v2',
  '300aff0f20a6d42ce84437c5ae8c45ac0c9e7fcd0f64b5b52fd5a291bd385e57',
  clock_timestamp()
);

COMMIT;
