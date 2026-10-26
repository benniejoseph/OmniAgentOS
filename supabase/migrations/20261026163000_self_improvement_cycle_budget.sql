-- Separate the immutable daily spending ceiling from each admitted cycle allowance.
-- Existing reservations, policies and terminal history are deliberately untouched.
BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public, pg_catalog',true);
DO $predecessor$
BEGIN
 IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 264 OR NOT EXISTS(
   SELECT 1 FROM public.omni_schema_version WHERE version=264 AND name='self_improvement_cycles_v1'
     AND checksum='fea94fc5fc798f6ddfc304797666d2242dfd314092d9274bdbf8cffb1c29c325') THEN
   RAISE EXCEPTION 'Self-improvement budget predecessor is invalid' USING ERRCODE='55000';
 END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
     WHERE oid=to_regprocedure('public.omni_protect_self_improvement_v1()')) IS DISTINCT FROM '5459b4adbfb359d8836aced82bac95a7cb108cb23eae662ff13b73f8b371157e' THEN
   RAISE EXCEPTION 'Self-improvement budget protector has changed' USING ERRCODE='55000';
 END IF;
END
$predecessor$;

-- NOT VALID avoids scanning retained history under the new constraint lock.
-- New/updated policies and cycles are enforced immediately. Legacy absent caps
-- remain exactly as saved and use their original daily allowance.
ALTER TABLE public.omni_self_improvement_configurations ADD CONSTRAINT omni_self_improvement_configuration_cycle_budget_check CHECK(COALESCE(
 jsonb_typeof(policy->'dailyBudgetUsd')='number'
 AND (policy->>'dailyBudgetUsd')::numeric>0 AND (policy->>'dailyBudgetUsd')::numeric<=100
 AND (NOT (policy ? 'maxCycleBudgetUsd') OR (jsonb_typeof(policy->'maxCycleBudgetUsd')='number'
   AND (policy->>'maxCycleBudgetUsd')::numeric>0 AND (policy->>'maxCycleBudgetUsd')::numeric<=(policy->>'dailyBudgetUsd')::numeric)),FALSE)) NOT VALID;
ALTER TABLE public.omni_self_improvement_cycles ADD CONSTRAINT omni_self_improvement_cycle_budget_check CHECK(COALESCE(
 jsonb_typeof(snapshot->'policy'->'dailyBudgetUsd')='number'
 AND (snapshot->'policy'->>'dailyBudgetUsd')::numeric>0 AND (snapshot->'policy'->>'dailyBudgetUsd')::numeric<=100
 AND (NOT (snapshot->'policy' ? 'maxCycleBudgetUsd') OR (jsonb_typeof(snapshot->'policy'->'maxCycleBudgetUsd')='number'
   AND (snapshot->'policy'->>'maxCycleBudgetUsd')::numeric>0
   AND (snapshot->'policy'->>'maxCycleBudgetUsd')::numeric<=(snapshot->'policy'->>'dailyBudgetUsd')::numeric))
 AND reservation_usd<=COALESCE((snapshot->'policy'->>'maxCycleBudgetUsd')::numeric,(snapshot->'policy'->>'dailyBudgetUsd')::numeric),FALSE)) NOT VALID;

CREATE OR REPLACE FUNCTION public.omni_protect_self_improvement_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
DECLARE used NUMERIC; day_start TIMESTAMPTZ; daily_ceiling NUMERIC;
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
     SELECT CASE WHEN jsonb_typeof(snapshot->'policy'->'dailyBudgetUsd')='number'
       THEN (snapshot->'policy'->>'dailyBudgetUsd')::numeric ELSE NULL END INTO daily_ceiling
       FROM public.omni_self_improvement_cycles WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id;
     IF daily_ceiling IS NULL OR daily_ceiling<=0 OR daily_ceiling>100 THEN RAISE EXCEPTION 'The sealed daily spending ceiling is invalid' USING ERRCODE='23514'; END IF;
     IF used+NEW.reserved_usd>LEAST(100,daily_ceiling) THEN RAISE EXCEPTION 'Daily UTC paid phase limit includes carried-over work' USING ERRCODE='23514'; END IF;
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

INSERT INTO public.omni_schema_version(version,name,checksum) VALUES(265,'self_improvement_cycle_budget_v1','19c27ea1a0b1b1151502c16fc83537e4a904bf29acd0a098b5a811812f62d752');
COMMIT;
