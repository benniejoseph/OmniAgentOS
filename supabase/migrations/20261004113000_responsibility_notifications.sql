BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 218 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 218 AND name = 'responsibility_runtime_v1'
      AND checksum = '2ec2115d7349edf1260533a898d6df013169538d515d059f53cd3f649dc01be6'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility notification predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Separate explicit admission; no existing none-authority activation changes.
CREATE TABLE public.omni_responsibility_notification_admissions (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990), generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK (state IN ('enabled','paused','draining','ended')),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16384),
  enabled_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibility_lifecycles(tenant_id,actor_id,responsibility_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE public.omni_responsibility_notification_candidates (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-notification:[a-f0-9]{64}$'), change_id TEXT NOT NULL,
  change_sha256 TEXT NOT NULL CHECK (change_sha256 ~ '^[a-f0-9]{64}$'), revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK (state IN ('pending','held','delivered','canceled','blocked','expired')),
  next_attempt_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16384),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,responsibility_id,id), UNIQUE (tenant_id,actor_id,responsibility_id,change_id),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibility_notification_admissions(tenant_id,actor_id,responsibility_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,actor_id,responsibility_id,change_id) REFERENCES public.omni_responsibility_changes(tenant_id,actor_id,responsibility_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX omni_responsibility_notification_candidates_due ON public.omni_responsibility_notification_candidates(next_attempt_at,tenant_id,actor_id,id) WHERE state IN ('pending','held');
CREATE TABLE public.omni_responsibility_notification_receipts (
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-notification-receipt:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'), request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  action TEXT NOT NULL CHECK (action IN ('enable','stop','admit','hold','retry','deliver','cancel','block','expire','lifecycle')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 32768), saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,idempotency_sha256), UNIQUE (tenant_id,actor_id,responsibility_id,revision),
  FOREIGN KEY (tenant_id,actor_id,responsibility_id) REFERENCES public.omni_responsibility_notification_admissions(tenant_id,actor_id,responsibility_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Extend only the closed source/reason vocabulary. Existing rows and decision
-- semantics remain valid; this source can bind only an in-app ledger delivery.
ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_source_kind_check;
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_source_kind_check CHECK (source_kind IN (
  'tool_approval','meeting','customer_risk','agent_run','today_reminder','delegated_task','scheduled_routine','security_incident','responsibility_change'));
ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_reason_check;
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_reason_check CHECK (reason IN (
  'approval_required','security_alert','actionable_failure','meeting_imminent','critical_delivery','quiet_hours','cooldown_active','digest_nonurgent',
  'digest_during_cooldown','routine_success','failure_not_actionable','meeting_not_imminent','not_worthy','material_change'));
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_responsibility_channel CHECK (
  source_kind <> 'responsibility_change' OR (must_send AND NOT critical AND outcome IN ('send','defer')
    AND reason IN ('material_change','quiet_hours','cooldown_active') AND (delivery_kind IS NULL OR delivery_kind = 'notification_ledger')));

CREATE FUNCTION public.omni_protect_responsibility_notification_head_v1()
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
    AND config->'source'->>'kind' = 'meeting' AND config->>'configurationSha256' ~ '^[a-f0-9]{64}$'
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
CREATE TRIGGER omni_responsibility_notification_admissions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_notification_admissions FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_notification_head_v1();
CREATE TRIGGER omni_responsibility_notification_admissions_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_notification_admissions FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_notification_head_v1();

CREATE FUNCTION public.omni_protect_responsibility_notification_candidate_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE head JSONB; change JSONB; observation JSONB; pending BOOLEAN;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility notification candidates cannot be removed' USING ERRCODE = '23514'; END IF;
  SELECT snapshot INTO head FROM public.omni_responsibility_notification_admissions WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id FOR UPDATE;
  pending := NEW.state IN ('pending','held');
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->>'tenantId' = NEW.tenant_id AND NEW.snapshot->>'actorId' = NEW.actor_id
    AND NEW.snapshot->>'responsibilityId' = NEW.responsibility_id AND NEW.snapshot->>'id' = NEW.id AND NEW.snapshot->>'changeId' = NEW.change_id
    AND NEW.snapshot->>'changeSha256' = NEW.change_sha256 AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->'generation' = to_jsonb(NEW.generation)
    AND NEW.snapshot->>'state' = NEW.state AND (NEW.snapshot->>'nextAttemptAt')::TIMESTAMPTZ IS NOT DISTINCT FROM NEW.next_attempt_at
    AND (NEW.snapshot->>'expiresAt')::TIMESTAMPTZ = NEW.expires_at AND NEW.expires_at > NEW.created_at
    AND (NEW.snapshot->>'createdAt')::TIMESTAMPTZ = NEW.created_at AND (NEW.snapshot->>'updatedAt')::TIMESTAMPTZ = NEW.updated_at AND NEW.updated_at >= NEW.created_at
    AND NEW.snapshot->>'configurationSha256' = head->'configuration'->>'configurationSha256'
    AND (NEW.snapshot->>'attempts')::BIGINT BETWEEN 0 AND 100 AND pending = (NEW.next_attempt_at IS NOT NULL)
    AND pending = (NEW.snapshot->>'terminalAt' IS NULL)
    AND (NOT pending OR (NEW.next_attempt_at >= NEW.updated_at AND NEW.next_attempt_at <= NEW.expires_at))
    AND (pending OR (NEW.snapshot->>'terminalAt')::TIMESTAMPTZ = NEW.updated_at)
    AND (NEW.state = 'delivered') = (NEW.snapshot->>'notificationId' IS NOT NULL)
    AND (NEW.state = 'delivered') = (NEW.snapshot->>'deliveryBindingSha256' IS NOT NULL),FALSE)
  THEN RAISE EXCEPTION 'Responsibility notification candidate binding is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT snapshot INTO change FROM public.omni_responsibility_changes WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.change_id;
    SELECT receipt INTO observation FROM public.omni_responsibility_observations WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = change->>'observationId';
    IF NOT COALESCE(NEW.revision = 1 AND NEW.created_at = NEW.updated_at AND NEW.snapshot->'attempts' = '0'::JSONB
      AND head->>'state' = 'enabled' AND NEW.generation = (head->>'generation')::BIGINT AND NEW.state IN ('pending','blocked')
      AND (NEW.state = 'pending' OR NEW.snapshot->>'reason' = 'notification_limit')
      AND change->>'changeSha256' = NEW.change_sha256 AND change->'target'->>'reviewSha256' = head->'configuration'->>'reviewSha256'
      AND change->'target'->'responsibilityRevision' = head->'configuration'->'responsibilityRevision'
      AND observation->'plan'->>'outcome' = 'material_change' AND (observation->>'savedAt')::TIMESTAMPTZ = NEW.created_at
      AND jsonb_array_length(observation->'plan'->'observation'->'sources') = 1
      AND (head->>'enabledAt')::TIMESTAMPTZ <= NEW.created_at AND NEW.expires_at <= NEW.created_at + INTERVAL '24 hours'
      AND NEW.expires_at <= (head->'configuration'->>'expiresAt')::TIMESTAMPTZ
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(observation->'plan'->'observation'->'sources') source
        WHERE source->>'state' <> 'accepted' OR (source->>'freshUntil')::TIMESTAMPTZ < NEW.expires_at),FALSE)
    THEN RAISE EXCEPTION 'Responsibility notification requires its current material observation' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.change_id IS DISTINCT FROM OLD.change_id OR NEW.change_sha256 IS DISTINCT FROM OLD.change_sha256 OR NEW.generation IS DISTINCT FROM OLD.generation
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.revision <> OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at OR OLD.state NOT IN ('pending','held') OR NEW.snapshot->>'configurationSha256' IS DISTINCT FROM OLD.snapshot->>'configurationSha256'
    THEN RAISE EXCEPTION 'Responsibility notification identity or terminal receipt is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.state = 'delivered' AND NOT COALESCE(head->>'state' IN ('enabled','draining') AND head->'generation' = to_jsonb(NEW.generation)
    AND NEW.updated_at < NEW.expires_at AND NEW.snapshot->>'reason' = 'in_app_recorded' AND NEW.snapshot->>'dispositionId' IS NOT NULL,FALSE)
  THEN RAISE EXCEPTION 'Responsibility delivery generation is fenced' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_notification_candidates_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_notification_candidates FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_notification_candidate_v1();
CREATE TRIGGER omni_responsibility_notification_candidates_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_notification_candidates FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_notification_candidate_v1();
CREATE TRIGGER omni_responsibility_notification_receipts_immutable BEFORE UPDATE OR DELETE ON public.omni_responsibility_notification_receipts FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();
CREATE TRIGGER omni_responsibility_notification_receipts_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_notification_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_runtime_receipt_v1();

-- Check the exact admitted version immediately, then require the reciprocal
-- immutable receipt at commit. Several versions may co-commit under one lock.
CREATE FUNCTION public.omni_admit_responsibility_notification_receipt_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_admissions
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id
      AND revision = NEW.revision AND snapshot = NEW.receipt->'snapshot')
  THEN RAISE EXCEPTION 'Notification receipt requires its exact admission' USING ERRCODE = '23514'; END IF;
  IF NEW.receipt->'candidate' IS DISTINCT FROM 'null'::JSONB AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_candidates
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id
      AND id = NEW.receipt->'candidate'->>'id' AND snapshot = NEW.receipt->'candidate')
  THEN RAISE EXCEPTION 'Notification receipt requires its exact candidate' USING ERRCODE = '23514'; END IF;
  IF (NEW.action IN ('enable','stop','lifecycle')) IS DISTINCT FROM (NEW.receipt->'candidate' = 'null'::JSONB)
  THEN RAISE EXCEPTION 'Notification action receipt shape is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_notification_receipts_admission BEFORE INSERT ON public.omni_responsibility_notification_receipts FOR EACH ROW EXECUTE FUNCTION public.omni_admit_responsibility_notification_receipt_v1();

CREATE FUNCTION public.omni_protect_responsibility_inbox_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE candidate JSONB; head JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'responsibility_change' THEN RAISE EXCEPTION 'Responsibility inbox receipts cannot be removed' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind <> 'responsibility_change' AND (TG_OP = 'INSERT' OR OLD.kind <> 'responsibility_change') THEN RETURN NEW; END IF;
  IF NOT COALESCE(NEW.kind = 'responsibility_change' AND NEW.source_type = 'responsibility_change'
    AND NEW.title = 'Responsibility change' AND NEW.urgency = 'update' AND NEW.status IN ('unread','read','dismissed') AND NEW.snoozed_until IS NULL,FALSE)
  THEN RAISE EXCEPTION 'Responsibility inbox kind or action is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status','read_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','read_at','updated_at'])
      OR (OLD.status = 'dismissed' AND NEW.status <> 'dismissed') OR (OLD.status <> 'unread' AND NEW.status = 'unread') OR NEW.updated_at < OLD.updated_at
    THEN RAISE EXCEPTION 'Responsibility inbox identity is immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT item.snapshot,admission.snapshot INTO candidate,head FROM public.omni_responsibility_notification_candidates item
      JOIN public.omni_responsibility_notification_admissions admission USING (tenant_id,actor_id,responsibility_id)
      WHERE item.tenant_id = NEW.tenant_id AND item.actor_id = NEW.actor_id AND item.responsibility_id = NEW.source_id AND item.id = NEW.occurrence_key FOR UPDATE OF item,admission;
    IF NOT COALESCE(candidate->>'state' IN ('pending','held') AND head->>'state' IN ('enabled','draining') AND candidate->'generation' = head->'generation'
      AND (candidate->>'expiresAt')::TIMESTAMPTZ > NEW.created_at AND (head->'configuration'->>'expiresAt')::TIMESTAMPTZ > NEW.created_at
      AND NEW.status = 'unread' AND NEW.read_at IS NULL AND NEW.created_at = NEW.updated_at AND NEW.due_at = NEW.created_at,FALSE)
    THEN RAISE EXCEPTION 'Responsibility inbox requires its current pending candidate' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_personal_notifications_responsibility_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_personal_notifications FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_inbox_v1();

CREATE FUNCTION public.omni_require_responsibility_notification_commit_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
DECLARE receipt JSONB; head JSONB; candidate JSONB; used_amount BIGINT; reserved_amount BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'omni_notification_dispositions' THEN
    IF NEW.source_kind <> 'responsibility_change' THEN RETURN NULL; END IF;
    SELECT snapshot INTO candidate FROM public.omni_responsibility_notification_candidates
      WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.owner_actor_id AND responsibility_id = NEW.source_id AND id = NEW.occurrence_key;
    IF candidate->>'dispositionId' IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Responsibility disposition requires its exact candidate' USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome = 'send' AND NEW.state = 'terminal' THEN
      IF NOT COALESCE(candidate->>'state' = 'delivered' AND candidate->>'deliveryBindingSha256' = NEW.delivery_binding_sha256
        AND NEW.delivery_kind = 'notification_ledger',FALSE) OR NOT EXISTS (SELECT 1 FROM public.omni_personal_notifications
          WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.owner_actor_id AND id = candidate->>'notificationId'
            AND kind = 'responsibility_change' AND source_type = 'responsibility_change' AND source_id = NEW.source_id AND occurrence_key = NEW.occurrence_key)
      THEN RAISE EXCEPTION 'Responsibility send disposition requires its real inbox receipt' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.outcome = 'defer' AND NEW.state = 'pending' AND NEW.reason = 'quiet_hours' THEN
      -- A canceled/expired candidate keeps the original disposition identity.
      -- Its immutable held version proves the earlier defer without presenting
      -- a historical pending disposition as current delivery authority.
      IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_receipts item
        WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.owner_actor_id AND responsibility_id = NEW.source_id
          AND action = 'hold' AND item.receipt->'candidate'->>'id' = NEW.occurrence_key
          AND item.receipt->'candidate'->>'dispositionId' = NEW.id AND item.receipt->'candidate'->>'state' = 'held'
          AND item.receipt->'candidate'->>'reason' = 'quiet_hours' AND saved_at = NEW.updated_at
          AND (item.receipt->'candidate'->>'updatedAt')::TIMESTAMPTZ = NEW.evaluated_at)
      THEN RAISE EXCEPTION 'Responsibility defer disposition requires its exact held receipt' USING ERRCODE = '23514'; END IF;
    ELSE RAISE EXCEPTION 'Responsibility disposition outcome is unsupported' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'omni_personal_notifications' THEN
    IF NEW.kind = 'responsibility_change' AND NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_candidates
      WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.source_id AND id = NEW.occurrence_key
        AND state = 'delivered' AND snapshot->>'notificationId' = NEW.id)
    THEN RAISE EXCEPTION 'Responsibility inbox requires its exact delivery receipt' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'omni_responsibility_notification_candidates' THEN
    IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_notification_receipts item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND item.receipt->'candidate' = NEW.snapshot)
    THEN RAISE EXCEPTION 'Notification candidate requires its exact receipt' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'delivered' AND NOT EXISTS (SELECT 1 FROM public.omni_personal_notifications item JOIN public.omni_notification_dispositions disposition
        ON disposition.tenant_id = item.tenant_id AND disposition.owner_actor_id = item.actor_id
      WHERE item.tenant_id = NEW.tenant_id AND item.actor_id = NEW.actor_id AND item.id = NEW.snapshot->>'notificationId'
        AND item.kind = 'responsibility_change' AND item.source_type = 'responsibility_change' AND item.source_id = NEW.responsibility_id AND item.occurrence_key = NEW.id
        AND disposition.id = NEW.snapshot->>'dispositionId' AND disposition.source_kind = 'responsibility_change' AND disposition.source_id = NEW.responsibility_id
        AND disposition.occurrence_key = NEW.id
        AND disposition.outcome = 'send' AND disposition.state = 'terminal' AND disposition.delivery_kind = 'notification_ledger'
        AND disposition.delivery_binding_sha256 = NEW.snapshot->>'deliveryBindingSha256')
    THEN RAISE EXCEPTION 'Responsibility delivery requires its real in-app ledger and disposition' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'omni_responsibility_notification_admissions' THEN
    SELECT item.receipt INTO receipt FROM public.omni_responsibility_notification_receipts item WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND revision = NEW.revision;
    IF receipt->'snapshot' IS DISTINCT FROM NEW.snapshot THEN RAISE EXCEPTION 'Notification admission requires its exact immutable receipt' USING ERRCODE = '23514'; END IF;
    SELECT snapshot INTO head FROM public.omni_responsibility_notification_admissions WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
    SELECT count(*) FILTER (WHERE state = 'delivered'),count(*) FILTER (WHERE state IN ('pending','held')) INTO used_amount,reserved_amount
      FROM public.omni_responsibility_notification_candidates WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id;
    IF head->'used' IS DISTINCT FROM to_jsonb(used_amount) OR head->'reserved' IS DISTINCT FROM to_jsonb(reserved_amount)
    THEN RAISE EXCEPTION 'Notification cumulative budget does not reconcile' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  receipt := NEW.receipt; head := receipt->'snapshot'; candidate := receipt->'candidate';
  IF NOT COALESCE(receipt->'schemaVersion' = '1'::JSONB AND receipt->>'id' = NEW.id AND receipt->>'idempotencySha256' = NEW.idempotency_sha256
    AND receipt->>'requestSha256' = NEW.request_sha256 AND receipt->>'action' = NEW.action AND receipt->'contentIncluded' = 'false'::JSONB
    AND head->>'tenantId' = NEW.tenant_id AND head->>'actorId' = NEW.actor_id AND head->>'responsibilityId' = NEW.responsibility_id
    AND head->'revision' = to_jsonb(NEW.revision) AND receipt->'previousRevision' = to_jsonb(NEW.revision - 1)
    AND (receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at AND head->>'updatedAt' = receipt->>'savedAt',FALSE)
  THEN RAISE EXCEPTION 'Notification immutable receipt coordinates are invalid' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omni_events WHERE id = NEW.id AND tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id
    AND type = 'responsibility.notification.transitioned' AND stream_id = 'responsibility:' || NEW.tenant_id || ':' || NEW.responsibility_id
    AND payload ? '_executionScope' AND payload - '_executionScope' = jsonb_build_object('schemaVersion',1,'responsibilityId',NEW.responsibility_id,
      'revision',NEW.revision,'generation',head->'generation','action',NEW.action,'state',head->>'state','reason',head->>'reason',
      'configurationSha256',head->'configuration'->>'configurationSha256','receiptId',NEW.id,'receiptSha256',receipt->>'receiptSha256',
      'candidateId',candidate->>'id','candidateState',candidate->>'state','candidateReason',candidate->>'reason','changeId',candidate->>'changeId','changeSha256',candidate->>'changeSha256',
      'used',head->'used','reserved',head->'reserved','notificationId',candidate->>'notificationId','deliveryBindingSha256',candidate->>'deliveryBindingSha256','contentIncluded',false,'externalDelivery',false))
  THEN RAISE EXCEPTION 'Notification transition requires its content-free event' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_responsibility_notification_admissions_receipt AFTER INSERT OR UPDATE ON public.omni_responsibility_notification_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_notification_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_notification_candidates_receipt AFTER INSERT OR UPDATE ON public.omni_responsibility_notification_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_notification_commit_v1();
CREATE CONSTRAINT TRIGGER omni_responsibility_notification_receipts_commit AFTER INSERT ON public.omni_responsibility_notification_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_notification_commit_v1();
CREATE CONSTRAINT TRIGGER omni_personal_notifications_responsibility_receipt AFTER INSERT ON public.omni_personal_notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_notification_commit_v1();
CREATE CONSTRAINT TRIGGER omni_notification_dispositions_responsibility_receipt AFTER INSERT OR UPDATE ON public.omni_notification_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_notification_commit_v1();

DO $notification_policies$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_responsibility_notification_admissions','omni_responsibility_notification_candidates','omni_responsibility_notification_receipts'] LOOP
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
      EXECUTE format('GRANT UPDATE (revision,generation,state,snapshot,updated_at) ON public.omni_responsibility_notification_admissions TO %I',role_name);
      EXECUTE format('GRANT UPDATE (revision,state,next_attempt_at,snapshot,updated_at) ON public.omni_responsibility_notification_candidates TO %I',role_name);
    END IF;
  END LOOP;
END
$notification_policies$;
REVOKE ALL ON FUNCTION public.omni_protect_responsibility_notification_head_v1(),public.omni_protect_responsibility_notification_candidate_v1(),public.omni_require_responsibility_notification_commit_v1(),public.omni_admit_responsibility_notification_receipt_v1(),public.omni_protect_responsibility_inbox_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (219,'responsibility_notifications_v1','b7781a7c49662c506457a340ef81b0f31ceb683587d8bff62391e246efbacaf2',clock_timestamp());
COMMIT;
