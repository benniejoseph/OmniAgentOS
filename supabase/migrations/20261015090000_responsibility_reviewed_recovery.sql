BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 256 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 256 AND name = 'project_task_commitments_v1'
      AND checksum = '7f5e16f8893f8d619879d7b44880788d8e9ba42438c5f2e042b43c1b87a3c832'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility reviewed recovery predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- A reviewed recovery retains every historical wake, charge and observation.
-- The explicit baseline rebind changes only its review target, not its evidence.
CREATE TABLE public.omni_responsibility_baseline_rebinds (
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-baseline-rebind:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL, runtime_receipt_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 2 AND 9007199254740991),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536), saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id,id), UNIQUE (tenant_id,actor_id,responsibility_id,revision),
  UNIQUE (tenant_id,actor_id,responsibility_id,runtime_receipt_id),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id,runtime_receipt_id) REFERENCES public.omni_responsibility_runtime_receipts(tenant_id,actor_id,responsibility_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_runtime_head_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE draft JSONB; config JSONB; budget JSONB; dimension TEXT; recovery BOOLEAN := FALSE;
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
  IF TG_OP = 'UPDATE' AND OLD.state = 'blocked' AND OLD.snapshot->>'reason' = 'authority_changed' AND NEW.state = 'active' THEN
    SELECT snapshot INTO draft FROM public.omni_responsibilities WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id FOR UPDATE;
    recovery := COALESCE(NEW.snapshot->>'reason' = 'owner_resumed' AND NEW.generation = OLD.generation + 1
      AND budget = OLD.snapshot->'budget' AND budget->'reservedChecks' = '0'::JSONB
      AND budget->'reserved' = '{"modelTurns":0,"tokens":0,"costMicrousd":0,"wallTimeMs":0,"toolCalls":0,"browserActions":0,"agents":0,"fanOut":0,"retries":0,"replans":0}'::JSONB
      AND draft->>'state' = 'reviewed' AND (draft->'review'->>'reviewedAt')::TIMESTAMPTZ > OLD.updated_at
      AND config->'responsibilityRevision' = draft->'revision' AND (config->>'responsibilityRevision')::BIGINT > (OLD.snapshot->'configuration'->>'responsibilityRevision')::BIGINT
      AND config->>'reviewSha256' = draft->'review'->>'reviewSha256' AND config->>'reviewSha256' <> OLD.snapshot->'configuration'->>'reviewSha256'
      AND config->>'draftSha256' = draft->>'draftSha256' AND config->'pins' = draft->'review'->'pins'
      AND config - ARRAY['responsibilityRevision','reviewSha256','configurationSha256','pins','tool'] = (OLD.snapshot->'configuration') - ARRAY['responsibilityRevision','reviewSha256','configurationSha256','pins','tool']
      AND (config->'tool') - 'contractSha256' = (OLD.snapshot->'configuration'->'tool') - 'contractSha256'
      AND config->'pins'->'sources'->0->'source' = OLD.snapshot->'configuration'->'pins'->'sources'->0->'source'
      AND (config->'pins'->'work') - 'projectionSha256' = (OLD.snapshot->'configuration'->'pins'->'work') - 'projectionSha256'
      AND config->'pins'->'procedure'->>'id' = OLD.snapshot->'configuration'->'pins'->'procedure'->>'id'
      AND config->'pins'->'agent'->>'id' = OLD.snapshot->'configuration'->'pins'->'agent'->>'id'
      AND NEW.next_due_at >= NEW.updated_at AND NEW.next_due_at < (config->'cadence'->>'expiresAt')::TIMESTAMPTZ
      AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_wakes WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND state NOT IN ('completed','failed','canceled')), FALSE);
  END IF;
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
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR ((config IS DISTINCT FROM OLD.snapshot->'configuration' OR (OLD.state = 'blocked' AND NEW.state = 'active')) AND NOT recovery)
    OR NEW.revision <> OLD.revision + 1 OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation + 1 OR NEW.updated_at < OLD.updated_at
    OR (budget->>'usedChecks')::BIGINT < (OLD.snapshot->'budget'->>'usedChecks')::BIGINT
    OR OLD.state = 'ended' THEN RAISE EXCEPTION 'Responsibility lifecycle revision is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_notification_head_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE config JSONB; draft JSONB; runtime JSONB; renewal BOOLEAN := FALSE;
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
  IF TG_OP = 'UPDATE' AND OLD.state = 'ended' AND OLD.snapshot->>'reason' = 'runtime_blocked' AND NEW.state = 'enabled' THEN
    SELECT snapshot INTO draft FROM public.omni_responsibilities WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id FOR UPDATE;
    SELECT snapshot INTO runtime FROM public.omni_responsibility_lifecycles WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id FOR UPDATE;
    renewal := COALESCE(NEW.snapshot->>'reason' = 'owner_enabled' AND NEW.generation = OLD.generation + 1
      AND NEW.snapshot->'used' = OLD.snapshot->'used' AND NEW.snapshot->'reserved' = '0'::JSONB AND OLD.snapshot->'reserved' = '0'::JSONB
      AND config - ARRAY['responsibilityRevision','reviewSha256','runtimeConfigurationSha256','configurationSha256'] = (OLD.snapshot->'configuration') - ARRAY['responsibilityRevision','reviewSha256','runtimeConfigurationSha256','configurationSha256']
      AND (config->>'responsibilityRevision')::BIGINT > (OLD.snapshot->'configuration'->>'responsibilityRevision')::BIGINT
      AND config->>'reviewSha256' <> OLD.snapshot->'configuration'->>'reviewSha256'
      AND runtime->>'state' = 'active' AND draft->>'state' = 'reviewed'
      AND config->'responsibilityRevision' = draft->'revision' AND config->>'reviewSha256' = draft->'review'->>'reviewSha256'
      AND config->>'draftSha256' = draft->>'draftSha256' AND config->'responsibilityRevision' = runtime->'configuration'->'responsibilityRevision'
      AND config->>'runtimeConfigurationSha256' = runtime->'configuration'->>'configurationSha256'
      AND config->>'runtimeConfigurationSha256' <> OLD.snapshot->'configuration'->>'runtimeConfigurationSha256'
      AND config->'source' = runtime->'configuration'->'source' AND config->'maximumNotifications' = draft->'draft'->'limits'->'maxNotifications'
      AND config->>'expiresAt' = runtime->'configuration'->'cadence'->>'expiresAt' AND (config->>'expiresAt')::TIMESTAMPTZ > NEW.updated_at
      AND (NEW.snapshot->>'used')::BIGINT < (config->>'maximumNotifications')::BIGINT
      AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_candidates WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND state IN ('pending','held')), FALSE);
  END IF;
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
      OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at OR ((config IS DISTINCT FROM OLD.snapshot->'configuration' OR OLD.state = 'ended') AND NOT renewal) OR NEW.revision <> OLD.revision + 1
      OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1 OR NEW.updated_at < OLD.updated_at
      OR (NEW.snapshot->>'used')::BIGINT < (OLD.snapshot->>'used')::BIGINT
    THEN RAISE EXCEPTION 'Responsibility notification authority or budget cannot reset' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.omni_protect_responsibility_baseline_rebind_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE runtime JSONB; previous_runtime JSONB; baseline JSONB; prior JSONB; next_baseline JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Responsibility baseline rebind receipts are immutable' USING ERRCODE = '23514'; END IF;
  prior := NEW.receipt->'previous'; next_baseline := NEW.receipt->'next';
  SELECT receipt INTO runtime FROM public.omni_responsibility_runtime_receipts WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.runtime_receipt_id;
  SELECT receipt->'snapshot' INTO previous_runtime FROM public.omni_responsibility_runtime_receipts WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = (runtime->>'previousRevision')::BIGINT;
  SELECT snapshot INTO baseline FROM public.omni_responsibility_baselines WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id FOR UPDATE;
  IF NOT COALESCE(NEW.receipt->'schemaVersion' = '1'::JSONB AND NEW.receipt->>'id' = NEW.id AND NEW.receipt->>'runtimeReceiptId' = NEW.runtime_receipt_id
    AND NEW.receipt->>'runtimeReceiptSha256' = runtime->>'receiptSha256' AND NEW.receipt->>'receiptSha256' ~ '^[a-f0-9]{64}$'
    AND (NEW.receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at AND (runtime->>'savedAt')::TIMESTAMPTZ = NEW.saved_at
    AND NEW.saved_at >= (prior->>'acceptedAt')::TIMESTAMPTZ
    AND runtime->>'action' = 'resume' AND runtime->'snapshot'->>'state' = 'active' AND runtime->'snapshot'->>'reason' = 'owner_resumed'
    AND previous_runtime->>'state' = 'blocked' AND previous_runtime->>'reason' = 'authority_changed'
    AND prior = baseline AND next_baseline->'revision' = to_jsonb(NEW.revision) AND (prior->>'revision')::BIGINT + 1 = NEW.revision
    AND prior->'target' = jsonb_build_object('tenantId',NEW.tenant_id,'actorId',NEW.actor_id,'responsibilityId',NEW.responsibility_id,
      'responsibilityRevision',previous_runtime->'configuration'->'responsibilityRevision','reviewSha256',previous_runtime->'configuration'->>'reviewSha256')
    AND next_baseline->'target' = jsonb_build_object('tenantId',NEW.tenant_id,'actorId',NEW.actor_id,'responsibilityId',NEW.responsibility_id,
      'responsibilityRevision',runtime->'snapshot'->'configuration'->'responsibilityRevision','reviewSha256',runtime->'snapshot'->'configuration'->>'reviewSha256')
    AND next_baseline - ARRAY['target','revision','baselineSha256'] = prior - ARRAY['target','revision','baselineSha256']
    AND next_baseline->>'policySha256' = runtime->'snapshot'->'configuration'->>'comparisonPolicySha256'
    AND next_baseline->>'baselineSha256' ~ '^[a-f0-9]{64}$',FALSE)
  THEN RAISE EXCEPTION 'Baseline rebind requires the exact preserved evidence and reviewed recovery' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_baseline_rebinds_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_baseline_rebinds FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_baseline_rebind_v1();
CREATE TRIGGER omni_responsibility_baseline_rebinds_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_baseline_rebinds FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_baseline_rebind_v1();

CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_baselines_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE receipt JSONB; rebind JSONB; target_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility baselines cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF (TG_OP = 'INSERT' AND NEW.revision <> 1) OR (TG_OP = 'UPDATE' AND (
    NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id OR NEW.revision <> OLD.revision + 1 OR NEW.accepted_at < OLD.accepted_at OR NEW.policy_sha256 IS DISTINCT FROM OLD.policy_sha256
  )) THEN RAISE EXCEPTION 'Responsibility baseline revision, owner or policy is inconsistent' USING ERRCODE = '23514'; END IF;
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->'revision' = to_jsonb(NEW.revision)
    AND NEW.snapshot->>'policySha256' = NEW.policy_sha256 AND NEW.snapshot->>'observationId' = NEW.observation_id
    AND NEW.snapshot->>'baselineSha256' = NEW.baseline_sha256 AND (NEW.snapshot->>'acceptedAt')::TIMESTAMPTZ = NEW.accepted_at
    AND NEW.snapshot->'target' = jsonb_build_object('tenantId',NEW.tenant_id,'actorId',NEW.actor_id,'responsibilityId',NEW.responsibility_id,'responsibilityRevision',NEW.responsibility_revision,'reviewSha256',NEW.review_sha256), FALSE)
  THEN RAISE EXCEPTION 'Responsibility baseline binding is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN target_changed := NEW.responsibility_revision IS DISTINCT FROM OLD.responsibility_revision OR NEW.review_sha256 IS DISTINCT FROM OLD.review_sha256; END IF;
  IF target_changed THEN
    SELECT item.receipt INTO rebind FROM public.omni_responsibility_baseline_rebinds item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision;
    IF rebind->'previous' IS DISTINCT FROM OLD.snapshot OR rebind->'next' IS DISTINCT FROM NEW.snapshot
    THEN RAISE EXCEPTION 'Responsibility baseline requires its exact reviewed rebind receipt' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT observation.receipt INTO receipt FROM public.omni_responsibility_observations observation
      WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.observation_id;
    IF NOT COALESCE(receipt->'plan'->'nextBaseline' = NEW.snapshot AND (receipt->'plan'->>'expectedBaselineRevision')::BIGINT = NEW.revision - 1
      AND receipt->'plan'->>'outcome' IN ('baseline_established','material_change','no_change'),FALSE)
    THEN RAISE EXCEPTION 'Responsibility baseline requires its exact accepted observation' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.omni_require_responsibility_recovery_commit_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE runtime JSONB; baseline JSONB; expected_payload JSONB;
BEGIN
  IF TG_TABLE_NAME = 'omni_responsibility_notification_admissions' THEN
    IF OLD.state <> 'ended' OR NEW.state <> 'enabled' THEN RETURN NULL; END IF;
    SELECT receipt INTO runtime FROM public.omni_responsibility_notification_receipts WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision;
    IF runtime->>'action' IS DISTINCT FROM 'enable' OR runtime->'candidate' IS DISTINCT FROM 'null'::JSONB OR runtime->'snapshot' IS DISTINCT FROM NEW.snapshot
    THEN RAISE EXCEPTION 'Responsibility notification renewal requires its explicit owner enable receipt' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'omni_responsibility_lifecycles' THEN
    IF OLD.state <> 'blocked' OR NEW.state <> 'active' THEN RETURN NULL; END IF;
    SELECT receipt INTO runtime FROM public.omni_responsibility_runtime_receipts WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision;
    IF runtime->>'action' IS DISTINCT FROM 'resume' OR runtime->'wake' IS DISTINCT FROM 'null'::JSONB
    THEN RAISE EXCEPTION 'Responsibility recovery requires its explicit owner resume receipt' USING ERRCODE = '23514'; END IF;
    SELECT snapshot INTO baseline FROM public.omni_responsibility_baselines WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
    IF baseline IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_baseline_rebinds item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id
      AND runtime_receipt_id = runtime->>'id' AND receipt->'next' = baseline)
    THEN RAISE EXCEPTION 'Responsibility recovery must atomically preserve and rebind its baseline' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_baselines WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND snapshot = NEW.receipt->'next')
  THEN RAISE EXCEPTION 'Responsibility rebind requires its atomic baseline' USING ERRCODE = '23514'; END IF;
  expected_payload := jsonb_build_object('schemaVersion',1,'responsibilityId',NEW.responsibility_id,'runtimeReceiptId',NEW.runtime_receipt_id,
    'receiptId',NEW.id,'receiptSha256',NEW.receipt->>'receiptSha256','previousRevision',NEW.receipt->'previous'->'revision','revision',NEW.revision,
    'previousBaselineSha256',NEW.receipt->'previous'->>'baselineSha256','baselineSha256',NEW.receipt->'next'->>'baselineSha256',
    'observationId',NEW.receipt->'next'->>'observationId','observationCreated',false,'semanticChanged',false);
  IF NOT EXISTS (SELECT 1 FROM public.omni_events WHERE id = NEW.id AND tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id
    AND type = 'responsibility.baseline.rebound' AND stream_id = 'responsibility:' || NEW.tenant_id || ':' || NEW.responsibility_id
    AND payload ? '_executionScope' AND payload - '_executionScope' = expected_payload)
  THEN RAISE EXCEPTION 'Responsibility baseline rebind requires its content-free event' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_responsibility_recovery_commit AFTER UPDATE ON public.omni_responsibility_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_recovery_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_notification_renewal_commit AFTER UPDATE ON public.omni_responsibility_notification_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_recovery_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_baseline_rebind_commit AFTER INSERT ON public.omni_responsibility_baseline_rebinds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_recovery_commit_v1();

ALTER TABLE public.omni_responsibility_baseline_rebinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_responsibility_baseline_rebinds FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_responsibility_baseline_rebinds AS PERMISSIVE FOR ALL TO PUBLIC USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_responsibility_baseline_rebinds_actor ON public.omni_responsibility_baseline_rebinds AS RESTRICTIVE FOR ALL TO PUBLIC
  USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
  WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_responsibility_baseline_rebinds FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  -- Creation may inherit the migration owner's default table ACLs. This private
  -- receipt table admits only the named serving/maintenance/backup privileges.
  FOR role_name IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) acl
    JOIN pg_roles role ON role.oid = acl.grantee
    WHERE relation.oid = 'public.omni_responsibility_baseline_rebinds'::regclass AND acl.grantee <> relation.relowner LOOP
    EXECUTE format('REVOKE ALL ON public.omni_responsibility_baseline_rebinds FROM %I',role_name);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.omni_responsibility_baseline_rebinds FROM %I',role_name);
      EXECUTE format('GRANT SELECT, INSERT ON public.omni_responsibility_baseline_rebinds TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN GRANT SELECT ON public.omni_responsibility_baseline_rebinds TO omni_backup; END IF;
END
$grants$;
REVOKE ALL ON FUNCTION public.omni_protect_responsibility_runtime_head_v1(),public.omni_protect_responsibility_notification_head_v1(),public.omni_protect_responsibility_baselines_v1(),public.omni_protect_responsibility_baseline_rebind_v1(),public.omni_require_responsibility_recovery_commit_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (257,'responsibility_reviewed_recovery_v1','d233101cd24985d298426d8ea143aabea2ae4ae5d5cbf4167a2eb5b3ccd3f8c5',clock_timestamp());
COMMIT;
