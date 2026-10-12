BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 245 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 245 AND name = 'native_provider_function_acl_repair_v1'
      AND checksum = '3d1e2f480d424d4f6da66008744928f883ee06745e32b147a26953c73c7c09f0'
  ) <> 1 THEN RAISE EXCEPTION 'Work-item follow-through predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Two closed lanes share existing runtime, fencing, receipts, and in-app
-- delivery. Existing configurations stay immutable. Work-item completion is
-- observed, never a stop or a claim of independent outcome verification.
CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_runtime_head_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE draft JSONB; config JSONB; budget JSONB; dimension TEXT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility runtime heads cannot be removed' USING ERRCODE = '23514'; END IF;
  config := NEW.snapshot->'configuration'; budget := NEW.snapshot->'budget';
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->>'contract' = 'asael-responsibility-runtime:1'
    AND NEW.snapshot->>'tenantId' = NEW.tenant_id AND NEW.snapshot->>'actorId' = NEW.actor_id AND NEW.snapshot->>'responsibilityId' = NEW.responsibility_id
    AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->'generation' = to_jsonb(NEW.generation) AND NEW.snapshot->>'state' = NEW.state
    AND (NEW.snapshot->>'nextDueAt')::TIMESTAMPTZ IS NOT DISTINCT FROM NEW.next_due_at
    AND (NEW.snapshot->>'activatedAt')::TIMESTAMPTZ = NEW.activated_at AND (NEW.snapshot->>'updatedAt')::TIMESTAMPTZ = NEW.updated_at
    AND (NEW.state = 'active' OR NEW.next_due_at IS NULL) AND NEW.updated_at >= NEW.activated_at
    AND config->>'notificationAuthority' = 'none' AND config->>'approvalAuthority' = 'none' AND config->>'mutationAuthority' = 'none'
    AND (
      (config->>'pilot' = 'native_meeting_metadata_v1' AND config->'tool'->>'id' = 'app.meetings.show'
        AND config->'source' = jsonb_build_object('kind','meeting','workspaceId',config->'source'->>'workspaceId','id',config->'source'->>'id')
        AND config->'tool'->'input' = jsonb_build_object('workspaceId',config->'source'->>'workspaceId','meetingId',config->'source'->>'id')
        AND config->'stops' = '["expiry","meeting_started","meeting_canceled"]'::JSONB)
      OR
      (config->>'pilot' = 'canonical_work_item_followthrough_v1' AND config->'tool'->>'id' = 'app.work_items.show'
        AND config->'source' = jsonb_build_object('kind','work_item','workspaceId',config->'source'->>'workspaceId','projectId',config->'source'->>'projectId','id',config->'source'->>'id')
        AND config->'tool'->'input' = jsonb_build_object('workspaceId',config->'source'->>'workspaceId','projectId',config->'source'->>'projectId','workItemId',config->'source'->>'id')
        AND config->'pins'->'work'->>'workspaceId' = config->'source'->>'workspaceId'
        AND config->'pins'->'work'->>'projectId' = config->'source'->>'projectId'
        AND config->'pins'->'work'->>'workItemId' = config->'source'->>'id'
        AND config->'stops' = '["expiry"]'::JSONB)
    )
    AND jsonb_array_length(config->'pins'->'sources') = 1 AND config->'pins'->'sources'->0->'source' = config->'source'
    AND config->'checkReservation' = '{"modelTurns":0,"tokens":0,"costMicrousd":0,"wallTimeMs":30000,"toolCalls":1,"browserActions":0,"agents":1,"fanOut":0,"retries":0,"replans":0}'::JSONB
    AND config->'cadence'->>'frequency' IN ('daily','weekly') AND config->'cadence'->>'missedPolicy' = 'skip'
    AND (config->'cadence'->>'expiresAt')::TIMESTAMPTZ > (config->'cadence'->>'startsAt')::TIMESTAMPTZ
    AND budget->'limits' = config->'cumulativeLimits' AND budget->'maximumChecks' = config->'maximumChecks'
    AND (budget->>'maximumChecks')::BIGINT BETWEEN 1 AND 10000 AND (budget->>'usedChecks')::BIGINT >= 0 AND (budget->>'reservedChecks')::BIGINT BETWEEN 0 AND 1
    AND (budget->>'usedChecks')::BIGINT + (budget->>'reservedChecks')::BIGINT <= (budget->>'maximumChecks')::BIGINT, FALSE)
  THEN RAISE EXCEPTION 'Responsibility runtime head binding is invalid' USING ERRCODE = '23514'; END IF;
  FOREACH dimension IN ARRAY ARRAY['modelTurns','tokens','costMicrousd','wallTimeMs','toolCalls','browserActions','agents','fanOut','retries','replans'] LOOP
    IF NOT COALESCE((budget->'used'->>dimension)::BIGINT >= 0 AND (budget->'reserved'->>dimension)::BIGINT >= 0
      AND (budget->'used'->>dimension)::BIGINT + (budget->'reserved'->>dimension)::BIGINT <= (budget->'limits'->>dimension)::BIGINT
      AND (budget->'limits'->>dimension)::BIGINT BETWEEN 0 AND 1000000000000, FALSE)
    THEN RAISE EXCEPTION 'Responsibility cumulative budget is invalid' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' AND (budget->'used'->>dimension)::BIGINT < (OLD.snapshot->'budget'->'used'->>dimension)::BIGINT
    THEN RAISE EXCEPTION 'Responsibility used budget cannot reset' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'INSERT' AND ((budget->'used'->>dimension)::BIGINT <> 0 OR (budget->'reserved'->>dimension)::BIGINT <> 0)
    THEN RAISE EXCEPTION 'Responsibility initial budget must be zero' USING ERRCODE = '23514'; END IF;
  END LOOP;
  IF TG_OP = 'INSERT' THEN
    SELECT snapshot INTO draft FROM public.omni_responsibilities WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id;
    IF NOT COALESCE(NEW.revision = 1 AND NEW.generation = 1 AND NEW.state = 'active' AND draft->>'state' = 'reviewed'
      AND config->'responsibilityRevision' = draft->'revision' AND config->>'reviewSha256' = draft->'review'->>'reviewSha256'
      AND config->>'draftSha256' = draft->>'draftSha256' AND config->'pins' = draft->'review'->'pins'
      AND config->'cadence' = draft->'draft'->'cadence' AND config->'maximumChecks' = draft->'draft'->'limits'->'maxChecks'
      AND config->'cumulativeLimits' = draft->'draft'->'limits'->'cumulative'
      AND jsonb_array_length(draft->'draft'->'sources') = 1 AND config->'source' = draft->'draft'->'sources'->0
      AND (config->>'pilot' <> 'canonical_work_item_followthrough_v1' OR draft->'draft'->'work' = config->'tool'->'input')
      AND (budget->>'usedChecks')::BIGINT = 0 AND (budget->>'reservedChecks')::BIGINT = 0, FALSE)
    THEN RAISE EXCEPTION 'Runtime activation requires its exact reviewed draft' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at OR config IS DISTINCT FROM OLD.snapshot->'configuration'
    OR NEW.revision <> OLD.revision + 1 OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation + 1 OR NEW.updated_at < OLD.updated_at
    OR (budget->>'usedChecks')::BIGINT < (OLD.snapshot->'budget'->>'usedChecks')::BIGINT
    OR OLD.state = 'ended' THEN RAISE EXCEPTION 'Responsibility lifecycle revision is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_notification_head_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE config JSONB; draft JSONB; runtime JSONB;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility notification admissions cannot be removed' USING ERRCODE = '23514'; END IF;
  config := NEW.snapshot->'configuration';
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->>'contract' = 'asael-responsibility-notifications:1'
    AND NEW.snapshot->>'tenantId' = NEW.tenant_id AND NEW.snapshot->>'actorId' = NEW.actor_id AND NEW.snapshot->>'responsibilityId' = NEW.responsibility_id
    AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->'generation' = to_jsonb(NEW.generation) AND NEW.snapshot->>'state' = NEW.state
    AND (NEW.snapshot->>'enabledAt')::TIMESTAMPTZ = NEW.enabled_at AND (NEW.snapshot->>'updatedAt')::TIMESTAMPTZ = NEW.updated_at AND NEW.updated_at >= NEW.enabled_at
    AND config->'schemaVersion' = '1'::JSONB AND config->>'tenantId' = NEW.tenant_id AND config->>'actorId' = NEW.actor_id AND config->>'responsibilityId' = NEW.responsibility_id
    AND config->>'policy' = 'owner_in_app_material_change_v1' AND config->>'destination' = 'owner_in_app' AND config->'quietOnNoChange' = 'true'::JSONB
    AND (
      config->'source' = jsonb_build_object('kind','meeting','workspaceId',config->'source'->>'workspaceId','id',config->'source'->>'id')
      OR config->'source' = jsonb_build_object('kind','work_item','workspaceId',config->'source'->>'workspaceId','projectId',config->'source'->>'projectId','id',config->'source'->>'id')
    ) AND config->>'configurationSha256' ~ '^[a-f0-9]{64}$'
    AND (config->>'maximumNotifications')::BIGINT BETWEEN 1 AND 1000
    AND (NEW.snapshot->>'used')::BIGINT >= 0 AND (NEW.snapshot->>'reserved')::BIGINT >= 0
    AND (NEW.snapshot->>'used')::BIGINT + (NEW.snapshot->>'reserved')::BIGINT <= (config->>'maximumNotifications')::BIGINT
    AND (NEW.state NOT IN ('paused','ended') OR NEW.snapshot->'reserved' = '0'::JSONB),FALSE)
  THEN RAISE EXCEPTION 'Responsibility notification admission is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT snapshot INTO draft FROM public.omni_responsibilities WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id FOR UPDATE;
    SELECT snapshot INTO runtime FROM public.omni_responsibility_lifecycles WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id FOR UPDATE;
    IF NOT COALESCE(NEW.revision = 1 AND NEW.generation = 1 AND NEW.state = 'enabled' AND NEW.enabled_at = NEW.updated_at
      AND NEW.snapshot->'used' = '0'::JSONB AND NEW.snapshot->'reserved' = '0'::JSONB AND runtime->>'state' = 'active'
      AND draft->>'state' = 'reviewed' AND config->'responsibilityRevision' = draft->'revision'
      AND config->>'reviewSha256' = draft->'review'->>'reviewSha256' AND config->>'draftSha256' = draft->>'draftSha256'
      AND config->>'runtimeConfigurationSha256' = runtime->'configuration'->>'configurationSha256'
      AND ((config->'source'->>'kind' = 'meeting' AND runtime->'configuration'->>'pilot' = 'native_meeting_metadata_v1')
        OR (config->'source'->>'kind' = 'work_item' AND runtime->'configuration'->>'pilot' = 'canonical_work_item_followthrough_v1'))
      AND config->'source' = runtime->'configuration'->'source' AND config->'maximumNotifications' = draft->'draft'->'limits'->'maxNotifications'
      AND draft->'draft'->'notificationRule' = '{"kind":"material_change_only","destination":"owner_in_app","quietOnNoChange":true}'::JSONB
      AND config->>'expiresAt' = runtime->'configuration'->'cadence'->>'expiresAt' AND (config->>'expiresAt')::TIMESTAMPTZ > NEW.enabled_at,FALSE)
    THEN RAISE EXCEPTION 'Responsibility in-app admission requires exact reviewed active bounds' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id
      OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at OR config IS DISTINCT FROM OLD.snapshot->'configuration' OR NEW.revision <> OLD.revision + 1
      OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1 OR NEW.updated_at < OLD.updated_at OR OLD.state = 'ended'
      OR (NEW.snapshot->>'used')::BIGINT < (OLD.snapshot->>'used')::BIGINT
    THEN RAISE EXCEPTION 'Responsibility notification authority or budget cannot reset' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.omni_protect_responsibility_runtime_head_v1(),public.omni_protect_responsibility_notification_head_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (246,'responsibility_work_item_followthrough_v1','d06e01433542116390082bed7170750b3021d6b96c95102b9579bde09ad951d0',clock_timestamp());
COMMIT;
