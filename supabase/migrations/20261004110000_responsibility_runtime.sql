BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 217 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 217 AND name = 'responsibility_observations_v1'
      AND checksum = '966d79c1f6c95a482584385b98fff975a678006405d3acd2db5442fd7eeb574a'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility runtime predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- PostgreSQL applies UPDATE USING to locking SELECTs. The read-only pilot must
-- hold exact private procedure and archival rows through governed dispatch.
-- Change USING only: existing UPDATE WITH CHECK, all FOR ALL actor/tenant/
-- classification guards, and INSERT/DELETE policies remain untouched. Thus a
-- memory.read caller can lock an already-readable private row but cannot UPDATE
-- even an unchanged value. No maintenance or shared-memory authority is added.
ALTER POLICY omni_memory_user_private_update_purpose ON public.omni_memories
USING (
  (SELECT omni_system_scope_enabled())
  OR (access_contract_version = 0 AND (SELECT omni_current_memory_access_scope_v1()) IS NULL)
  OR (access_contract_version = 1 AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
    IN ('memory.write.v1','memory.correct.v1','memory.forget.v1','memory.maintenance.v1'))
  OR (access_contract_version = 1 AND visibility = 'user_private'
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' = 'memory.read.v1'
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'executingPrincipalType' = 'user'
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'executingPrincipalId' = owner_actor_id
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'initiatingActorId' = owner_actor_id
    AND omni_user_private_memory_scope_v1_allows_validated((SELECT omni_current_memory_access_scope_v1()),tenant_id,owner_actor_id,allowed_purpose_ids))
);
ALTER POLICY omni_memory_lifecycle_states_update_purpose ON public.omni_memory_lifecycle_states
USING (
  (SELECT omni_system_scope_enabled()) OR access_contract_version = 0
  OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' = 'memory.maintenance.v1'
  OR (access_contract_version = 1
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId' = 'memory.read.v1'
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'executingPrincipalType' = 'user'
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'executingPrincipalId' = owner_actor_id
    AND (SELECT omni_current_memory_access_scope_v1()) ->> 'initiatingActorId' = owner_actor_id
    AND EXISTS (SELECT 1 FROM public.omni_memories memory
      WHERE memory.id = omni_memory_lifecycle_states.memory_id AND memory.tenant_id = omni_memory_lifecycle_states.tenant_id
        AND memory.owner_actor_id = omni_memory_lifecycle_states.owner_actor_id
        AND memory.access_contract_version = 1 AND memory.visibility = 'user_private'
        AND omni_user_private_memory_scope_v1_allows_validated((SELECT omni_current_memory_access_scope_v1()),memory.tenant_id,memory.owner_actor_id,memory.allowed_purpose_ids)))
);

-- Explicit activation is separate from the still-inactive draft/review tables.
-- This version admits only one local, governed, read-only Meeting binding.
CREATE TABLE public.omni_responsibility_lifecycles (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK (state IN ('active','pausing','paused','ending','ended','blocked')),
  next_due_at TIMESTAMPTZ, snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 65536),
  activated_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibilities(tenant_id,actor_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX omni_responsibility_lifecycles_due ON public.omni_responsibility_lifecycles(next_due_at,tenant_id,actor_id,responsibility_id) WHERE state = 'active';
CREATE TABLE public.omni_responsibility_wakes (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-wake:[a-f0-9]{64}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990), generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
  scheduled_for TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved','enqueued','running','completed','failed','canceled','uncertain')),
  workflow_run_id TEXT, lease_expires_at TIMESTAMPTZ,
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16384),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id,id), UNIQUE (tenant_id,actor_id,responsibility_id,generation,scheduled_for),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibility_lifecycles(tenant_id,actor_id,responsibility_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX omni_responsibility_wakes_pending ON public.omni_responsibility_wakes(tenant_id,actor_id,updated_at,id) WHERE state IN ('reserved','enqueued','running','uncertain');
CREATE TABLE public.omni_responsibility_runtime_receipts (
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-runtime-receipt:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'), request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990), generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
  action TEXT NOT NULL CHECK (action IN ('activate','pause','resume','end','reserve','enqueue','start','settle','block','reconcile')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 131072), saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,idempotency_sha256), UNIQUE (tenant_id,actor_id,responsibility_id,revision), UNIQUE (tenant_id,actor_id,responsibility_id,id),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibility_lifecycles(tenant_id,actor_id,responsibility_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE public.omni_responsibility_budget_entries (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990), wake_id TEXT,
  entry JSONB NOT NULL CHECK (jsonb_typeof(entry) = 'object' AND pg_column_size(entry) <= 16384), saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id,id), UNIQUE (tenant_id,actor_id,responsibility_id,revision),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id,id) REFERENCES public.omni_responsibility_runtime_receipts(tenant_id,actor_id,responsibility_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,actor_id,responsibility_id,wake_id) REFERENCES public.omni_responsibility_wakes(tenant_id,actor_id,responsibility_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION public.omni_protect_responsibility_runtime_head_v1()
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
    AND config->>'pilot' = 'native_meeting_metadata_v1' AND config->>'notificationAuthority' = 'none' AND config->>'approvalAuthority' = 'none' AND config->>'mutationAuthority' = 'none'
    AND config->'tool'->>'id' = 'app.meetings.show' AND config->'source'->>'kind' = 'meeting'
    AND config->'tool'->'input' = jsonb_build_object('workspaceId',config->'source'->>'workspaceId','meetingId',config->'source'->>'id')
    AND config->'stops' = '["expiry","meeting_started","meeting_canceled"]'::JSONB
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
CREATE TRIGGER omni_responsibility_lifecycles_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_lifecycles FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_runtime_head_v1();
CREATE TRIGGER omni_responsibility_lifecycles_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_lifecycles FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_runtime_head_v1();

CREATE FUNCTION public.omni_protect_responsibility_runtime_wake_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE head JSONB; terminal BOOLEAN;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility wake receipts cannot be removed' USING ERRCODE = '23514'; END IF;
  SELECT snapshot INTO head FROM public.omni_responsibility_lifecycles WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
  terminal := NEW.state IN ('completed','failed','canceled');
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->>'id' = NEW.id AND NEW.snapshot->>'tenantId' = NEW.tenant_id
    AND NEW.snapshot->>'actorId' = NEW.actor_id AND NEW.snapshot->>'responsibilityId' = NEW.responsibility_id
    AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->'generation' = to_jsonb(NEW.generation) AND NEW.snapshot->>'state' = NEW.state
    AND (NEW.snapshot->>'scheduledFor')::TIMESTAMPTZ = NEW.scheduled_for AND (NEW.snapshot->>'createdAt')::TIMESTAMPTZ = NEW.created_at
    AND (NEW.snapshot->>'updatedAt')::TIMESTAMPTZ = NEW.updated_at AND (NEW.snapshot->>'workflowRunId')::TEXT IS NOT DISTINCT FROM NEW.workflow_run_id
    AND (NEW.snapshot->>'leaseExpiresAt')::TIMESTAMPTZ IS NOT DISTINCT FROM NEW.lease_expires_at
    AND NEW.snapshot->>'configurationSha256' = head->'configuration'->>'configurationSha256'
    AND NEW.generation <= (head->>'generation')::BIGINT AND NEW.snapshot->'reservation' = head->'configuration'->'checkReservation'
    AND terminal = (NEW.snapshot->>'settledAt' IS NOT NULL) AND terminal = (NEW.snapshot->'charged' <> 'null'::JSONB)
    AND (NEW.state <> 'completed' OR NEW.snapshot->>'observationId' IS NOT NULL)
    AND (NEW.state = 'completed' OR NEW.snapshot->>'observationId' IS NULL)
    AND (NOT terminal OR NEW.snapshot->'charged' = CASE WHEN NEW.snapshot->>'startedAt' IS NOT NULL THEN NEW.snapshot->'reservation'
      ELSE '{"modelTurns":0,"tokens":0,"costMicrousd":0,"wallTimeMs":0,"toolCalls":0,"browserActions":0,"agents":0,"fanOut":0,"retries":0,"replans":0}'::JSONB END), FALSE)
  THEN RAISE EXCEPTION 'Responsibility wake binding is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.revision <> 1 OR NEW.state <> 'reserved' OR NEW.generation <> (head->>'generation')::BIGINT OR head->>'state' <> 'active')
    THEN RAISE EXCEPTION 'Only an active generation reserves a wake' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at OR OLD.state IN ('completed','failed','canceled'))
    THEN RAISE EXCEPTION 'Responsibility wake is immutable after settlement' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND ((OLD.snapshot->>'startedAt' IS NOT NULL AND NEW.snapshot->'startedAt' IS DISTINCT FROM OLD.snapshot->'startedAt')
    OR (OLD.workflow_run_id IS NOT NULL AND NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id)
    OR NEW.snapshot->'reservation' IS DISTINCT FROM OLD.snapshot->'reservation')
    THEN RAISE EXCEPTION 'Responsibility wake cannot replace its admitted run or reservation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_wakes_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_wakes FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_runtime_wake_v1();
CREATE TRIGGER omni_responsibility_wakes_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_wakes FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_runtime_wake_v1();

CREATE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Responsibility runtime receipts and budget entries are immutable' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'omni_responsibility_runtime_receipts' THEN
    -- Bind each receipt at insertion to the exact live wake version. A later
    -- transition in this transaction may legitimately advance that same wake.
    IF NEW.receipt->'wake' <> 'null'::JSONB AND NOT EXISTS (
      SELECT 1 FROM public.omni_responsibility_wakes item
      WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id
        AND responsibility_id = NEW.responsibility_id
        AND id = NEW.receipt->'wake'->>'id' AND snapshot = NEW.receipt->'wake'
    ) THEN RAISE EXCEPTION 'Runtime transition requires its exact wake' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_runtime_receipts_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_runtime_receipts FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();
CREATE TRIGGER omni_responsibility_runtime_receipts_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_runtime_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();
CREATE TRIGGER omni_responsibility_budget_entries_immutable BEFORE UPDATE OR DELETE ON public.omni_responsibility_budget_entries FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();
CREATE TRIGGER omni_responsibility_budget_entries_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_budget_entries FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();

CREATE FUNCTION public.omni_require_responsibility_runtime_commit_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE receipt JSONB; head JSONB; wake JSONB; entry JSONB; previous_budget JSONB; dimension TEXT; used_amount BIGINT; reserved_amount BIGINT; current_head JSONB;
BEGIN
  IF TG_TABLE_NAME = 'omni_responsibility_wakes' THEN
    IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_runtime_receipts item
      WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND item.receipt->'wake' = NEW.snapshot)
    THEN RAISE EXCEPTION 'Runtime wake requires exact immutable receipt' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'omni_responsibility_lifecycles' THEN
    SELECT item.receipt INTO receipt FROM public.omni_responsibility_runtime_receipts item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision;
    IF receipt->'snapshot' IS DISTINCT FROM NEW.snapshot THEN RAISE EXCEPTION 'Runtime head requires exact immutable receipt' USING ERRCODE = '23514'; END IF;
    SELECT snapshot INTO current_head FROM public.omni_responsibility_lifecycles WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
    -- Reconcile the final head against every immutable terminal charge and
    -- every still-outstanding reservation. Neither pause nor a restart resets it.
    SELECT count(*) FILTER (WHERE state IN ('completed','failed','canceled') AND snapshot->>'startedAt' IS NOT NULL),
      count(*) FILTER (WHERE state NOT IN ('completed','failed','canceled')) INTO used_amount,reserved_amount
      FROM public.omni_responsibility_wakes WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
    IF current_head->'budget'->'usedChecks' IS DISTINCT FROM to_jsonb(used_amount) OR current_head->'budget'->'reservedChecks' IS DISTINCT FROM to_jsonb(reserved_amount)
    THEN RAISE EXCEPTION 'Responsibility check budget does not match wake receipts' USING ERRCODE = '23514'; END IF;
    FOREACH dimension IN ARRAY ARRAY['modelTurns','tokens','costMicrousd','wallTimeMs','toolCalls','browserActions','agents','fanOut','retries','replans'] LOOP
      SELECT COALESCE(sum((snapshot->'charged'->>dimension)::BIGINT) FILTER (WHERE state IN ('completed','failed','canceled')),0),
        COALESCE(sum((snapshot->'reservation'->>dimension)::BIGINT) FILTER (WHERE state NOT IN ('completed','failed','canceled')),0)
        INTO used_amount,reserved_amount FROM public.omni_responsibility_wakes WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
      IF current_head->'budget'->'used'->dimension IS DISTINCT FROM to_jsonb(used_amount) OR current_head->'budget'->'reserved'->dimension IS DISTINCT FROM to_jsonb(reserved_amount)
      THEN RAISE EXCEPTION 'Responsibility cumulative budget does not match wake receipts' USING ERRCODE = '23514'; END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  receipt := NEW.receipt; head := receipt->'snapshot'; wake := receipt->'wake';
  SELECT item.entry INTO entry FROM public.omni_responsibility_budget_entries item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.id;
  SELECT item.receipt->'snapshot'->'budget' INTO previous_budget FROM public.omni_responsibility_runtime_receipts item
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision - 1;
  IF NOT COALESCE(receipt->'schemaVersion' = '1'::JSONB AND receipt->>'id' = NEW.id AND receipt->>'idempotencySha256' = NEW.idempotency_sha256
    AND receipt->>'requestSha256' = NEW.request_sha256 AND receipt->>'action' = NEW.action
    AND head->>'tenantId' = NEW.tenant_id AND head->>'actorId' = NEW.actor_id AND head->>'responsibilityId' = NEW.responsibility_id
    AND head->'revision' = to_jsonb(NEW.revision) AND head->'generation' = to_jsonb(NEW.generation)
    AND receipt->'previousRevision' = to_jsonb(NEW.revision - 1) AND (receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at
    AND entry->>'receiptId' = NEW.id AND entry->>'responsibilityId' = NEW.responsibility_id AND entry->'schemaVersion' = '1'::JSONB
    AND entry->'revision' = to_jsonb(NEW.revision) AND entry->'after' = head->'budget' AND entry->'before' = COALESCE(previous_budget,'null'::JSONB)
    AND (entry->>'wakeId') IS NOT DISTINCT FROM (wake->>'id'), FALSE)
  THEN RAISE EXCEPTION 'Runtime transition requires its exact budget entry' USING ERRCODE = '23514'; END IF;
  IF wake->>'observationId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_observations item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id
    AND id = wake->>'observationId' AND item.receipt->>'receiptSha256' = wake->>'observationReceiptSha256')
    THEN RAISE EXCEPTION 'Runtime completion requires its exact observation receipt' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omni_events WHERE id = NEW.id AND tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND type = 'responsibility.runtime.transitioned'
    AND stream_id = 'responsibility:' || NEW.tenant_id || ':' || NEW.responsibility_id AND payload ? '_executionScope'
    AND payload->>'receiptId' = NEW.id AND payload->>'receiptSha256' = receipt->>'receiptSha256' AND payload->'revision' = to_jsonb(NEW.revision)
    AND payload->'generation' = to_jsonb(NEW.generation) AND payload->>'state' = head->>'state' AND payload->'notificationCreated' = 'false'::JSONB AND payload->'approvalCreated' = 'false'::JSONB
    AND (payload - '_executionScope' - 'budgetSha256') = jsonb_build_object('schemaVersion',1,'responsibilityId',NEW.responsibility_id,'revision',NEW.revision,'generation',NEW.generation,
      'action',NEW.action,'state',head->>'state','reason',head->>'reason','configurationSha256',head->'configuration'->>'configurationSha256',
      'receiptId',NEW.id,'receiptSha256',receipt->>'receiptSha256','wakeId',wake->>'id','wakeState',wake->>'state','observationId',wake->>'observationId',
      'usedChecks',head->'budget'->'usedChecks','reservedChecks',head->'budget'->'reservedChecks','notificationCreated',false,'approvalCreated',false)
    AND payload->>'budgetSha256' ~ '^[a-f0-9]{64}$')
    THEN RAISE EXCEPTION 'Runtime transition requires its content-free event' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_responsibility_lifecycles_receipt_required AFTER INSERT OR UPDATE ON public.omni_responsibility_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_runtime_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_wakes_receipt_required AFTER INSERT OR UPDATE ON public.omni_responsibility_wakes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_runtime_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_runtime_receipts_commit_required AFTER INSERT ON public.omni_responsibility_runtime_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_runtime_commit_v1();

DO $runtime_policies$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_responsibility_lifecycles','omni_responsibility_wakes','omni_responsibility_runtime_receipts','omni_responsibility_budget_entries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id))',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id)) WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))',table_name || '_actor',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I',table_name,role_name); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT UPDATE (revision,generation,state,next_due_at,snapshot,updated_at) ON public.omni_responsibility_lifecycles TO %I',role_name);
      EXECUTE format('GRANT UPDATE (revision,state,workflow_run_id,lease_expires_at,snapshot,updated_at) ON public.omni_responsibility_wakes TO %I',role_name);
    END IF;
  END LOOP;
END
$runtime_policies$;
REVOKE ALL ON FUNCTION public.omni_protect_responsibility_runtime_head_v1(),public.omni_protect_responsibility_runtime_wake_v1(),public.omni_protect_responsibility_runtime_receipt_v1(),public.omni_require_responsibility_runtime_commit_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (218,'responsibility_runtime_v1','2ec2115d7349edf1260533a898d6df013169538d515d059f53cd3f649dc01be6',clock_timestamp());
COMMIT;
