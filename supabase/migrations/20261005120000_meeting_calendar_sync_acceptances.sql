BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 223 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=223 AND name='memory_reconciliation_native_fences_v1'
      AND checksum='c6eb6a4e6550aa5585b2c15fd417e8fca797b232b9dc12d25459e9ebcf08b27a'
  ) <> 1 THEN RAISE EXCEPTION 'Meeting Calendar acceptance predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- No credentials, provider subjects, source content or sync cursors. A command
-- is accepted before effects and cannot be retried through a different key
-- while its original result is unknown. Rollback must retain this fence.
CREATE TABLE public.omni_meeting_calendar_sync_acceptances (
  id TEXT PRIMARY KEY CHECK(id ~ '^meeting-calendar-sync:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 120),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 256),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  workspace_id TEXT NOT NULL CHECK(workspace_id='workspace:personal:'||substr(canonical_actor_id,7)),
  connection_id TEXT NOT NULL CHECK(connection_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  authorization_generation BIGINT NOT NULL CHECK(authorization_generation BETWEEN 1 AND 9007199254740991),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','settled','unconfirmed')),
  settlement JSONB,
  updated_at TIMESTAMPTZ NOT NULL CHECK(updated_at>=accepted_at),
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK((state IN ('accepted','unconfirmed') AND settlement IS NULL) OR (state='settled' AND settlement IS NOT NULL
    AND jsonb_typeof(settlement)='object' AND pg_column_size(settlement)<=4096
    AND settlement ?& ARRAY['status','imported','removed','cursorAdvanced','coverage','settledAt']
    AND settlement-ARRAY['status','imported','removed','cursorAdvanced','coverage','settledAt']='{}'::JSONB
    AND COALESCE(settlement->>'status' IN ('healthy','partial','error'),FALSE)
    AND jsonb_typeof(settlement->'cursorAdvanced')='boolean'
    AND jsonb_typeof(settlement->'imported')='number' AND (settlement->>'imported')::NUMERIC BETWEEN 0 AND 9007199254740991
    AND trunc((settlement->>'imported')::NUMERIC)=(settlement->>'imported')::NUMERIC
    AND jsonb_typeof(settlement->'removed')='number' AND (settlement->>'removed')::NUMERIC BETWEEN 0 AND 9007199254740991
    AND trunc((settlement->>'removed')::NUMERIC)=(settlement->>'removed')::NUMERIC
    AND COALESCE((settlement->>'settledAt')::TIMESTAMPTZ=updated_at,FALSE)
    AND jsonb_typeof(settlement->'coverage')='object'
    AND (settlement->'coverage') ?& ARRAY['status','backfillState','lastAttemptedAt','lastSuccessfulAt','failureCode']
    AND (settlement->'coverage')-ARRAY['status','backfillState','lastAttemptedAt','lastSuccessfulAt','failureCode']='{}'::JSONB
    AND COALESCE(settlement->'coverage'->>'status' IN ('syncing','healthy','error'),FALSE)
    AND COALESCE(settlement->'coverage'->>'backfillState' IN ('unknown','in_progress','complete'),FALSE)
    AND COALESCE(settlement->'coverage'->>'failureCode' IN ('none','provider_unauthorized','provider_forbidden','provider_rate_limited','provider_unavailable','processing_failed'),FALSE)
    AND (settlement->'coverage'->>'lastAttemptedAt')::TIMESTAMPTZ IS NOT NULL
    AND ((settlement->'coverage'->'lastSuccessfulAt')='null'::JSONB OR (settlement->'coverage'->>'lastSuccessfulAt')::TIMESTAMPTZ IS NOT NULL)
    AND settlement->>'status'=CASE settlement->'coverage'->>'status' WHEN 'syncing' THEN 'partial' ELSE settlement->'coverage'->>'status' END))
);
CREATE UNIQUE INDEX omni_meeting_calendar_one_unconfirmed ON public.omni_meeting_calendar_sync_acceptances(tenant_id,owner_actor_id,connection_id)
  WHERE state IN ('accepted','unconfirmed');

CREATE FUNCTION public.omni_meeting_calendar_sync_acceptance_guard_v1() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE event_id TEXT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Calendar sync evidence cannot be removed' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'accepted' OR NEW.settlement IS NOT NULL OR NEW.updated_at<>NEW.accepted_at THEN
      RAISE EXCEPTION 'A Calendar command must begin as accepted' USING ERRCODE='23514'; END IF;
    PERFORM id FROM public.omni_oauth_grants WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.owner_actor_id
      AND id=NEW.connection_id AND provider='google' AND connection_purpose='personal' AND status='active'
      AND authorization_generation=NEW.authorization_generation
      AND scopes && ARRAY['https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/calendar.events']::TEXT[] FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Calendar command requires its current exact owner authorization' USING ERRCODE='23514'; END IF;
  ELSE
    IF OLD.state<>'accepted' OR NEW.state NOT IN ('settled','unconfirmed') OR
      (to_jsonb(NEW)-ARRAY['state','settlement','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settlement','updated_at'])
    THEN RAISE EXCEPTION 'Calendar acceptance is immutable and settles once' USING ERRCODE='23514'; END IF;
  END IF;
  event_id:=NEW.id||':'||NEW.state;
  IF NOT EXISTS(SELECT 1 FROM public.omni_events event WHERE event.id=event_id AND event.stream_id=NEW.id
    AND event.tenant_id=NEW.tenant_id AND event.actor_id=NEW.owner_actor_id AND event.type='meeting.calendar.sync.'||NEW.state
    AND event.payload->>'requestId'=NEW.id AND event.payload->>'connectionId'=NEW.connection_id::TEXT
    AND event.payload->>'requestSha256'=NEW.request_sha256 AND event.payload->>'state'=NEW.state)
  THEN RAISE EXCEPTION 'Calendar acceptance requires its co-committed typed event' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_meeting_calendar_sync_acceptance_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_meeting_calendar_sync_acceptances
FOR EACH ROW EXECUTE FUNCTION public.omni_meeting_calendar_sync_acceptance_guard_v1();
CREATE TRIGGER omni_meeting_calendar_sync_acceptance_no_truncate BEFORE TRUNCATE ON public.omni_meeting_calendar_sync_acceptances
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_meeting_calendar_sync_acceptance_guard_v1();
ALTER TABLE public.omni_meeting_calendar_sync_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_meeting_calendar_sync_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_meeting_calendar_sync_acceptances AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_meeting_calendar_sync_actor ON public.omni_meeting_calendar_sync_acceptances AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_meeting_calendar_sync_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'meeting.calendar.sync.%' OR (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'meeting.calendar.sync.%' OR (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_meeting_calendar_sync_acceptances FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_meeting_calendar_sync_acceptance_guard_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.omni_meeting_calendar_sync_acceptances TO %I',role_name); END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_meeting_calendar_sync_acceptances TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(224,'meeting_calendar_sync_acceptances_v1','cb10e54d898d741a666336d05c91364b52926a0237e6220c24fa629df73c7ef5',clock_timestamp());
COMMIT;
