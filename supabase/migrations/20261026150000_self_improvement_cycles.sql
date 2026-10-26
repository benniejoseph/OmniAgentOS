BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public, pg_catalog',true);
DO $predecessor$
BEGIN
 IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 263 OR NOT EXISTS(SELECT 1 FROM public.omni_schema_version WHERE version=263 AND checksum='e12731f398b50050a14e145054af59ee2804a2755fffdad62fefebd44f3be472') THEN
 RAISE EXCEPTION 'Self-improvement predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$predecessor$;

CREATE TABLE public.omni_self_improvement_configurations (
 id TEXT PRIMARY KEY CHECK(id ~ '^self_config_[a-f0-9]{64}$'), tenant_id TEXT NOT NULL,
 owner_actor_id TEXT NOT NULL CHECK(owner_actor_id ~ '^actor:[a-f0-9-]{36}$'), project_id TEXT NOT NULL,
 repository_id TEXT NOT NULL CHECK(repository_id ~ '^[0-9]{1,24}$'), repository_key TEXT NOT NULL CHECK(repository_key ~ '^[a-f0-9]{64}$'),
 repository JSONB NOT NULL CHECK(jsonb_typeof(repository)='object'), policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
 policy_sha256 TEXT NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'), generation BIGINT NOT NULL CHECK(generation>0),
 next_due_at TIMESTAMPTZ NOT NULL, paused BOOLEAN NOT NULL DEFAULT FALSE,
 time_zone TEXT NOT NULL, daily_hour SMALLINT NOT NULL CHECK(daily_hour BETWEEN 0 AND 23),
 controller_id TEXT, controller_last_seen_at TIMESTAMPTZ, controller_status TEXT CHECK(controller_status IN ('online','held')), controller_category TEXT CHECK(controller_category ~ '^[a-z0-9_]{1,120}$'),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL CHECK(updated_at>=created_at),
 UNIQUE(tenant_id,owner_actor_id,id), UNIQUE(tenant_id,owner_actor_id,repository_id),
 CHECK(policy->>'policySha256'=policy_sha256 AND (policy->>'version')::int=1
   AND (policy->>'dailyBudgetUsd')::numeric>0 AND (policy->>'dailyBudgetUsd')::numeric<=100
   AND policy->'maxActiveCycles'='1'::jsonb AND policy->'maxCandidatesPerCycle'='1'::jsonb
   AND policy->'maxCorrections'='1'::jsonb AND pg_column_size(policy)<8192 AND pg_column_size(repository)<4096)
);
CREATE INDEX omni_self_improvement_due ON public.omni_self_improvement_configurations(tenant_id,next_due_at,id) WHERE NOT paused;
CREATE TABLE public.omni_self_improvement_cycles (
 id TEXT PRIMARY KEY CHECK(id ~ '^self_cycle_[a-f0-9]{64}$'), tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
 configuration_id TEXT NOT NULL, configuration_generation BIGINT NOT NULL CHECK(configuration_generation>0),
 project_id TEXT NOT NULL, repository_id TEXT NOT NULL, repository_key TEXT NOT NULL CHECK(repository_key ~ '^[a-f0-9]{64}$'),
 base_revision TEXT NOT NULL CHECK(base_revision ~ '^[a-f0-9]{40}$'), policy_sha256 TEXT NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),
 idempotency_sha256 TEXT NOT NULL CHECK(idempotency_sha256 ~ '^[a-f0-9]{64}$'), request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 budget_day DATE NOT NULL, reservation_usd NUMERIC(14,8) NOT NULL CHECK(reservation_usd>0 AND reservation_usd<=100),
 spend_usd NUMERIC(14,8) NOT NULL DEFAULT 0 CHECK(spend_usd>=0), usage_state TEXT NOT NULL CHECK(usage_state IN ('known','unknown')),
 stage TEXT NOT NULL CHECK(stage IN ('observing','no_change','planned','implementing','validating','correcting','review_required','ready_for_release','releasing','succeeded','failed','rolled_back','cancelled')),
 revision BIGINT NOT NULL CHECK(revision>0), snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND pg_column_size(snapshot)<=262144),
 runtime JSONB NOT NULL CHECK(jsonb_typeof(runtime)='object' AND pg_column_size(runtime)<=131072),
 lease_token_sha256 TEXT NOT NULL CHECK(lease_token_sha256 ~ '^[a-f0-9]{64}$'), lease_expires_at TIMESTAMPTZ NOT NULL,
 release_controller_id TEXT CHECK(length(release_controller_id) BETWEEN 1 AND 240), controller_hold JSONB CHECK(controller_hold IS NULL OR (jsonb_typeof(controller_hold)='object' AND pg_column_size(controller_hold)<2048)),
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL CHECK(updated_at>=created_at),
 UNIQUE(tenant_id,owner_actor_id,id), UNIQUE(tenant_id,owner_actor_id,idempotency_sha256),
 FOREIGN KEY(tenant_id,owner_actor_id,configuration_id) REFERENCES public.omni_self_improvement_configurations(tenant_id,owner_actor_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- This global partial index intentionally serializes work on the same repository
-- across owners and policies. Lease expiry never releases a repository cycle.
CREATE UNIQUE INDEX omni_self_improvement_one_active_repository ON public.omni_self_improvement_cycles(repository_key)
 WHERE stage NOT IN ('no_change','succeeded','failed','rolled_back','cancelled');
CREATE INDEX omni_self_improvement_cycles_owner ON public.omni_self_improvement_cycles(tenant_id,owner_actor_id,created_at DESC,id);
CREATE TABLE public.omni_self_improvement_budget_reservations (
 tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL, cycle_id TEXT NOT NULL,
 budget_day DATE NOT NULL, reserved_usd NUMERIC(14,8) NOT NULL CHECK(reserved_usd>0 AND reserved_usd<=100), created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(tenant_id,owner_actor_id,cycle_id),
 FOREIGN KEY(tenant_id,owner_actor_id,cycle_id) REFERENCES public.omni_self_improvement_cycles(tenant_id,owner_actor_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX omni_self_improvement_daily_budget ON public.omni_self_improvement_budget_reservations(tenant_id,owner_actor_id,budget_day);
CREATE TABLE public.omni_self_improvement_phase_reservations (
 tenant_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL, cycle_id TEXT NOT NULL, phase_id TEXT NOT NULL CHECK(length(phase_id) BETWEEN 1 AND 240),
 reserved_usd NUMERIC(14,8) NOT NULL CHECK(reserved_usd>0 AND reserved_usd<=100), actual_usd NUMERIC(14,8) CHECK(actual_usd>=0),
 state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown')), evidence_sha256 TEXT CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL, settled_at TIMESTAMPTZ,
 PRIMARY KEY(tenant_id,owner_actor_id,cycle_id,phase_id),
 FOREIGN KEY(tenant_id,owner_actor_id,cycle_id) REFERENCES public.omni_self_improvement_cycles(tenant_id,owner_actor_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK((state='reserved' AND actual_usd IS NULL AND evidence_sha256 IS NULL AND settled_at IS NULL)
   OR (state='settled' AND actual_usd IS NOT NULL AND evidence_sha256 IS NOT NULL AND settled_at IS NOT NULL)
   OR (state='unknown' AND actual_usd IS NULL AND evidence_sha256 IS NOT NULL AND settled_at IS NOT NULL))
);

CREATE FUNCTION public.omni_protect_self_improvement_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
DECLARE used NUMERIC; day_start TIMESTAMPTZ;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Self-improvement history cannot be removed' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='omni_self_improvement_budget_reservations' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Daily reservations are immutable' USING ERRCODE='23514'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array('self-improvement-daily',NEW.tenant_id,NEW.owner_actor_id,NEW.budget_day)::text,0));
   SELECT COALESCE(sum(reserved_usd),0) INTO used FROM public.omni_self_improvement_budget_reservations WHERE tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id AND budget_day=NEW.budget_day;
   IF used+NEW.reserved_usd>100 OR NOT EXISTS(SELECT 1 FROM public.omni_self_improvement_cycles WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id AND budget_day=NEW.budget_day AND reservation_usd=NEW.reserved_usd) THEN RAISE EXCEPTION 'Daily budget reservation exceeds its ceiling or cycle binding' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='omni_self_improvement_phase_reservations' THEN
   IF TG_OP='INSERT' THEN
     PERFORM 1 FROM public.omni_self_improvement_cycles WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id AND stage NOT IN ('no_change','succeeded','failed','rolled_back','cancelled') AND usage_state='known' FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Phase reservation needs a current active cycle' USING ERRCODE='23514'; END IF;
     SELECT COALESCE(sum(COALESCE(actual_usd,reserved_usd)),0) INTO used FROM public.omni_self_improvement_phase_reservations WHERE tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id AND cycle_id=NEW.cycle_id;
     IF used+NEW.reserved_usd>(SELECT reservation_usd FROM public.omni_self_improvement_cycles WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id) THEN RAISE EXCEPTION 'Phase reservations exceed the cycle ceiling' USING ERRCODE='23514'; END IF;
     PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('self-improvement-paid-day',NEW.tenant_id,NEW.owner_actor_id)::text,0));
     day_start:=date_trunc('day',NEW.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
     SELECT COALESCE(sum(CASE WHEN state='settled' THEN actual_usd ELSE greatest(reserved_usd,COALESCE(actual_usd,0)) END),0) INTO used
       FROM public.omni_self_improvement_phase_reservations WHERE tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id
       AND (state IN ('reserved','unknown') OR (created_at>=day_start AND created_at<day_start+interval '24 hours') OR (settled_at>=day_start AND settled_at<day_start+interval '24 hours'));
     IF used+NEW.reserved_usd>LEAST(100,(SELECT reservation_usd FROM public.omni_self_improvement_cycles WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id)) THEN RAISE EXCEPTION 'Daily UTC paid phase limit includes carried-over work' USING ERRCODE='23514'; END IF;
   END IF;
   IF TG_OP='UPDATE' AND (OLD.state='settled' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id OR NEW.phase_id IS DISTINCT FROM OLD.phase_id OR NEW.reserved_usd IS DISTINCT FROM OLD.reserved_usd OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.state='reserved') THEN RAISE EXCEPTION 'Phase admission and final metering are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='omni_self_improvement_configurations' THEN
   IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.repository_key IS DISTINCT FROM OLD.repository_key OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation+1 OR NEW.updated_at<OLD.updated_at OR (NEW.generation=OLD.generation AND (NEW.policy IS DISTINCT FROM OLD.policy OR NEW.paused IS DISTINCT FROM OLD.paused OR NEW.repository IS DISTINCT FROM OLD.repository))) THEN RAISE EXCEPTION 'Self-improvement configuration binding is immutable' USING ERRCODE='23514'; END IF;
 ELSE
   IF NOT COALESCE(NEW.snapshot->>'id'=NEW.id AND NEW.snapshot->'scope'->>'tenantId'=NEW.tenant_id AND NEW.snapshot->'scope'->>'ownerActorId'=NEW.owner_actor_id AND NEW.snapshot->'scope'->>'baseRevision'=NEW.base_revision AND NEW.snapshot->'policy'->>'policySha256'=NEW.policy_sha256 AND NEW.snapshot->>'stage'=NEW.stage AND NEW.snapshot->'revision'=to_jsonb(NEW.revision) AND (NEW.snapshot->>'dailyReservationUsd')::numeric=NEW.reservation_usd AND (NEW.snapshot->>'createdAt')::timestamptz=NEW.created_at AND (NEW.snapshot->>'updatedAt')::timestamptz=NEW.updated_at AND (NEW.snapshot->>'correctionsUsed')::int BETWEEN 0 AND 1,FALSE) THEN RAISE EXCEPTION 'Self-improvement cycle projection is invalid' USING ERRCODE='23514'; END IF;
   IF TG_OP='UPDATE' AND (OLD.stage IN ('no_change','succeeded','failed','rolled_back','cancelled') OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id OR NEW.configuration_id IS DISTINCT FROM OLD.configuration_id OR NEW.configuration_generation IS DISTINCT FROM OLD.configuration_generation OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.repository_key IS DISTINCT FROM OLD.repository_key OR NEW.base_revision IS DISTINCT FROM OLD.base_revision OR NEW.policy_sha256 IS DISTINCT FROM OLD.policy_sha256 OR NEW.idempotency_sha256 IS DISTINCT FROM OLD.idempotency_sha256 OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR NEW.budget_day IS DISTINCT FROM OLD.budget_day OR NEW.reservation_usd IS DISTINCT FROM OLD.reservation_usd OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.snapshot->'scope' IS DISTINCT FROM OLD.snapshot->'scope' OR NEW.snapshot->'policy' IS DISTINCT FROM OLD.snapshot->'policy' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.spend_usd<OLD.spend_usd OR (NEW.snapshot->>'correctionsUsed')::int<(OLD.snapshot->>'correctionsUsed')::int) THEN RAISE EXCEPTION 'Self-improvement cycle identity or revision changed' USING ERRCODE='23514'; END IF;
   IF TG_OP='UPDATE' AND OLD.stage='releasing' AND NEW.stage NOT IN ('releasing','succeeded','rolled_back','failed') THEN RAISE EXCEPTION 'An in-flight release must be reconciled' USING ERRCODE='23514'; END IF;
   IF TG_OP='UPDATE' AND (OLD.release_controller_id IS NOT NULL AND NEW.release_controller_id IS DISTINCT FROM OLD.release_controller_id) THEN RAISE EXCEPTION 'The release controller claim is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END
$guard$;
CREATE FUNCTION public.omni_self_improvement_admission_reserved_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $reserved$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.omni_self_improvement_budget_reservations WHERE tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id AND cycle_id=NEW.id AND budget_day=NEW.budget_day AND reserved_usd=NEW.reservation_usd) THEN RAISE EXCEPTION 'Cycle admission must commit with its exact daily reservation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END
$reserved$;
CREATE CONSTRAINT TRIGGER omni_self_improvement_admission_reserved AFTER INSERT ON public.omni_self_improvement_cycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_self_improvement_admission_reserved_v1();
DO $security$
DECLARE table_name TEXT; role_name TEXT; privilege RECORD;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['omni_self_improvement_configurations','omni_self_improvement_cycles','omni_self_improvement_budget_reservations','omni_self_improvement_phase_reservations'] LOOP
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.omni_protect_self_improvement_v1()',table_name||'_protect',table_name);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_self_improvement_v1()',table_name||'_no_truncate',table_name);
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
   EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
   EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id))',table_name);
   EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id)) WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))',table_name||'_owner',table_name);
   EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
   FOR privilege IN SELECT DISTINCT roles.rolname FROM pg_class relation CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) acl JOIN pg_roles roles ON roles.oid=acl.grantee WHERE relation.oid=('public.'||table_name)::regclass AND acl.grantee<>relation.relowner LOOP
     EXECUTE format('REVOKE ALL ON public.%I FROM %I',table_name,privilege.rolname);
   END LOOP;
   FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
     IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('GRANT SELECT,INSERT%s ON public.%I TO %I',CASE WHEN table_name='omni_self_improvement_budget_reservations' THEN '' ELSE ',UPDATE' END,table_name,role_name); END IF;
   END LOOP;
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
 END LOOP;
END
$security$;
-- Normalize inherited function grants; only trigger invocation needs access.
DO $function_acl$
DECLARE fn REGPROCEDURE; privilege RECORD;
BEGIN
 FOREACH fn IN ARRAY ARRAY['public.omni_protect_self_improvement_v1()'::REGPROCEDURE,'public.omni_self_improvement_admission_reserved_v1()'::REGPROCEDURE] LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',fn);
 FOR privilege IN SELECT DISTINCT roles.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl JOIN pg_roles roles ON roles.oid=acl.grantee WHERE p.oid=fn AND acl.grantee<>p.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',fn,privilege.rolname); END LOOP;
 END LOOP;
END
$function_acl$;
ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_source_kind_check;
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_source_kind_check CHECK(source_kind IN (
 'tool_approval','meeting','customer_risk','agent_run','today_reminder','delegated_task','scheduled_routine','security_incident','responsibility_change','research_workflow','availability_watch','self_improvement'));
ALTER TABLE public.omni_web_push_deliveries DROP CONSTRAINT omni_web_push_deliveries_kind_check;
ALTER TABLE public.omni_web_push_deliveries ADD CONSTRAINT omni_web_push_deliveries_kind_check CHECK(kind IN ('watch','test','self_improvement'));
ALTER TABLE public.omni_web_push_deliveries DROP CONSTRAINT omni_web_push_deliveries_check;
ALTER TABLE public.omni_web_push_deliveries ADD CONSTRAINT omni_web_push_deliveries_check CHECK(((kind='watch' OR kind='self_improvement') AND notification_id IS NOT NULL) OR (kind='test' AND notification_id IS NULL));
ALTER TABLE public.omni_app_builder_events DROP CONSTRAINT omni_app_builder_events_row_check;
ALTER TABLE public.omni_app_builder_events ADD CONSTRAINT omni_app_builder_events_row_check CHECK (COALESCE(
  schema_version = 1
  AND id ~ '^app_build_event_[a-f0-9]{48}$'
  AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
  AND session_id ~ '^app_build_[a-f0-9]{48}$'
  AND event_type IN (
    'app_builder.session.provisioning_started', 'app_builder.session.reprovisioning_started', 'app_builder.session.ready',
    'app_builder.session.failed', 'app_builder.session.stopped',
    'app_builder.file.updated', 'app_builder.command.completed',
    'app_builder.checkpoint.created', 'app_builder.checkpoint.restored',
    'app_builder.verification.completed', 'app_builder.sentinel.reviewed',
    'app_builder.repository.bound', 'app_builder.repository.checked_out',
    'app_builder.secret_scan.completed',
    'app_builder.delivery.pull_request_open', 'app_builder.delivery.failed',
    'app_builder.deployment.preview_queued', 'app_builder.deployment.preview_ready',
    'app_builder.deployment.preview_incomplete', 'app_builder.deployment.preview_failed',
    'app_builder.release.review_prepared', 'app_builder.release.production_queued',
    'app_builder.release.production_healthy', 'app_builder.release.production_incomplete',
    'app_builder.release.production_failed'
  )
  AND jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768
  AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND occurred_at <= NOW() + INTERVAL '30 seconds'
, FALSE));
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(264,'self_improvement_cycles_v1','fea94fc5fc798f6ddfc304797666d2242dfd314092d9274bdbf8cffb1c29c325',clock_timestamp());
COMMIT;
