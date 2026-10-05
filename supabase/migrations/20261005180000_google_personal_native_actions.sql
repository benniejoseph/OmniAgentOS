BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',TRUE);
SELECT set_config('omni.system_scope','true',TRUE);
SELECT set_config('omni.system_reason','ordered schema migration',TRUE);
SELECT set_config('search_path','public,pg_catalog',TRUE);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 235 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=235 AND name='native_knowledge_cognition_builds_v1'
      AND checksum='32970b0b3a66989751fc81f1a2ece1dbc357d8c569c3f3deed6b4df7d0851ae0'
  )<>1 THEN RAISE EXCEPTION 'Native Google actions predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

CREATE FUNCTION public.omni_google_personal_review_valid_v1(r JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(r)='object' AND r ?& ARRAY['connectionId','accountEmail','authorizationGeneration','status','sourceScopeSha256','permittedSources','reviewSha256']
    AND r-ARRAY['connectionId','accountEmail','authorizationGeneration','status','sourceScopeSha256','permittedSources','reviewSha256']='{}'::JSONB
    AND jsonb_typeof(r->'connectionId')='string' AND char_length(r->>'connectionId') BETWEEN 1 AND 320 AND r->>'connectionId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
    AND jsonb_typeof(r->'accountEmail')='string' AND char_length(r->>'accountEmail') BETWEEN 3 AND 320
    AND jsonb_typeof(r->'authorizationGeneration')='number' AND r->>'authorizationGeneration' ~ '^[1-9][0-9]*$'
    AND (r->>'authorizationGeneration')::NUMERIC<=2147483647 AND r->>'status' IN ('active','revoked')
    AND jsonb_typeof(r->'sourceScopeSha256')='string' AND r->>'sourceScopeSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(r->'reviewSha256')='string' AND r->>'reviewSha256' ~ '^[a-f0-9]{64}$'
    AND r->'permittedSources' IN ('[]'::JSONB,'["mail"]'::JSONB,'["calendar"]'::JSONB,'["drive"]'::JSONB,
      '["mail","calendar"]'::JSONB,'["mail","drive"]'::JSONB,'["calendar","drive"]'::JSONB,'["mail","calendar","drive"]'::JSONB),FALSE)
$function$;
CREATE FUNCTION public.omni_google_personal_settlement_valid_v1(s JSONB,a JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT s IS NULL OR COALESCE(jsonb_typeof(s)='object' AND pg_column_size(s)<=16384 AND s->'action'=a->'action'
    AND jsonb_typeof(s->'settledAt')='string' AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'acceptedAt')::TIMESTAMPTZ
    AND CASE s->>'action'
      WHEN 'disconnect' THEN s ?& ARRAY['action','status','providerRevocation','settledAt']
        AND s-ARRAY['action','status','providerRevocation','settledAt']='{}'::JSONB AND s->>'status'='local_revoked'
        AND s->>'providerRevocation' IN ('revoked','unconfirmed')
      WHEN 'sync' THEN s ?& ARRAY['action','status','imported','removed','cursorAdvanced','sources','settledAt']
        AND s-ARRAY['action','status','imported','removed','cursorAdvanced','sources','settledAt']='{}'::JSONB
        AND s->>'status' IN ('healthy','partial') AND jsonb_typeof(s->'cursorAdvanced')='boolean'
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['imported','removed']) k WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'number'
          OR NOT COALESCE(s->>k ~ '^(0|[1-9][0-9]*)$',FALSE) OR (s->>k)::NUMERIC>2147483647)
        AND CASE WHEN jsonb_typeof(s->'sources')='array' THEN
          jsonb_array_length(s->'sources') BETWEEN 1 AND 3
          AND (SELECT jsonb_agg(part->'source' ORDER BY ordinal) FROM jsonb_array_elements(s->'sources') WITH ORDINALITY p(part,ordinal))=a->'review'->'permittedSources'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'sources') part WHERE jsonb_typeof(part) IS DISTINCT FROM 'object'
            OR NOT (part ?& ARRAY['source','status','backfillState','imported','removed','lastAttemptedAt','lastSuccessfulAt'])
            OR part-ARRAY['source','status','backfillState','imported','removed','lastAttemptedAt','lastSuccessfulAt']<>'{}'::JSONB
            OR NOT COALESCE(part->>'status' IN ('syncing','healthy') AND part->>'backfillState' IN ('unknown','in_progress','complete')
              AND jsonb_typeof(part->'lastAttemptedAt')='string' AND jsonb_typeof(part->'lastSuccessfulAt')='string',FALSE)
            OR EXISTS(SELECT 1 FROM unnest(ARRAY['imported','removed']) k WHERE jsonb_typeof(part->k) IS DISTINCT FROM 'number'
              OR NOT COALESCE(part->>k ~ '^(0|[1-9][0-9]*)$',FALSE) OR (part->>k)::NUMERIC>2147483647))
          AND (s->>'imported')::NUMERIC=(SELECT sum((part->>'imported')::NUMERIC) FROM jsonb_array_elements(s->'sources') part)
          AND (s->>'removed')::NUMERIC=(SELECT sum((part->>'removed')::NUMERIC) FROM jsonb_array_elements(s->'sources') part)
          AND (s->>'status'='healthy')=(SELECT bool_and(part->>'status'='healthy') FROM jsonb_array_elements(s->'sources') part)
        ELSE FALSE END
      ELSE FALSE END,FALSE)
$function$;
CREATE TABLE public.omni_google_personal_native_actions (
  id TEXT PRIMARY KEY CHECK(id ~ '^google-personal-action:[a-f0-9]{64}$'),tenant_id TEXT NOT NULL,owner_actor_id TEXT NOT NULL,canonical_actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES public.omni_oauth_grants(id),authorization_generation INTEGER NOT NULL CHECK(authorization_generation>0),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL,acceptance JSONB NOT NULL,accepted_at TIMESTAMPTZ NOT NULL,state TEXT NOT NULL CHECK(state IN ('accepted','settled')),settlement JSONB,
  lease_owner_id TEXT,lease_generation INTEGER,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(char_length(tenant_id) BETWEEN 1 AND 120 AND tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CHECK(char_length(owner_actor_id) BETWEEN 1 AND 320 AND btrim(owner_actor_id)=owner_actor_id),
  CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  CHECK(COALESCE(jsonb_typeof(intent)='object' AND pg_column_size(intent)<=16384
    AND intent ?& ARRAY['contract','scope','idempotencyKeySha256','request'] AND intent-ARRAY['contract','scope','idempotencyKeySha256','request']='{}'::JSONB
    AND intent->>'contract'='asael-google-personal-intent:1' AND intent->>'idempotencyKeySha256'=idempotency_key_sha256
    AND intent->'scope'=jsonb_build_object('tenantId',tenant_id,'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND jsonb_typeof(intent->'request')='object' AND intent->'request' ?& ARRAY['contract','action','review'] AND (intent->'request')-ARRAY['contract','action','review']='{}'::JSONB
    AND intent->'request'->>'contract'='asael-google-personal-action:1' AND intent->'request'->>'action' IN ('sync','disconnect')
    AND public.omni_google_personal_review_valid_v1(intent->'request'->'review') AND intent->'request'->'review'->>'connectionId'=connection_id
    AND intent->'request'->'review'->'authorizationGeneration'=to_jsonb(authorization_generation) AND intent->'request'->'review'->>'status'='active'
    AND CASE WHEN intent->'request'->>'action'='sync' THEN intent->'request'->'review'->'permittedSources'<>'[]'::JSONB AND lease_owner_id IS NOT NULL AND lease_generation>0
      ELSE authorization_generation<2147483647 AND lease_owner_id IS NULL AND lease_generation IS NULL END,FALSE)),
  CHECK(COALESCE(jsonb_typeof(acceptance)='object' AND pg_column_size(acceptance)<=16384
    AND acceptance ?& ARRAY['contract','id','scope','action','idempotencyKeySha256','requestSha256','review','acceptedAt','localRevoked','acceptanceSha256']
    AND acceptance-ARRAY['contract','id','scope','action','idempotencyKeySha256','requestSha256','review','acceptedAt','localRevoked','acceptanceSha256']='{}'::JSONB
    AND acceptance->>'contract'='asael-google-personal-acceptance:1' AND acceptance->>'id'=id AND acceptance->'scope'=intent->'scope'
    AND acceptance->'action'=intent->'request'->'action' AND acceptance->'review'=intent->'request'->'review'
    AND acceptance->>'idempotencyKeySha256'=idempotency_key_sha256 AND acceptance->>'requestSha256'=request_sha256
    AND jsonb_typeof(acceptance->'acceptedAt')='string' AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at
    AND jsonb_typeof(acceptance->'acceptanceSha256')='string' AND acceptance->>'acceptanceSha256' ~ '^[a-f0-9]{64}$'
    AND acceptance->'localRevoked'=to_jsonb(intent->'request'->>'action'='disconnect'),FALSE)),
  CHECK((state='settled')=(settlement IS NOT NULL)),CHECK(public.omni_google_personal_settlement_valid_v1(settlement,acceptance))
);
CREATE UNIQUE INDEX omni_google_personal_native_pending ON public.omni_google_personal_native_actions(tenant_id,owner_actor_id) WHERE state='accepted';
-- Scheduler/legacy callers must not mistake RLS-hidden accepted work for its
-- absence after an account loses current membership. Return one exact-owner
-- boolean, without exposing receipt metadata or widening ordinary reads.
CREATE FUNCTION public.omni_google_personal_sync_allowed_v1(requested_tenant TEXT,requested_owner TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE previous_system TEXT:=current_setting('omni.system_scope',TRUE); previous_reason TEXT:=current_setting('omni.system_reason',TRUE); allowed BOOLEAN;
BEGIN
  IF requested_tenant IS DISTINCT FROM public.omni_current_tenant() OR requested_owner IS NULL OR char_length(requested_owner) NOT BETWEEN 1 AND 320
    OR NOT COALESCE(public.omni_actor_scope_v1_allows(requested_tenant,requested_owner),FALSE) THEN RETURN FALSE; END IF;
  PERFORM set_config('omni.system_scope','true',TRUE); PERFORM set_config('omni.system_reason','exact Google pending action fence',TRUE);
  SELECT NOT EXISTS(SELECT 1 FROM public.omni_google_personal_native_actions WHERE tenant_id=requested_tenant AND owner_actor_id=requested_owner AND state='accepted') INTO allowed;
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE);
  RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('omni.system_scope',COALESCE(previous_system,''),TRUE); PERFORM set_config('omni.system_reason',COALESCE(previous_reason,''),TRUE); RAISE;
END
$function$;
CREATE FUNCTION public.omni_protect_google_personal_native_action_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native Google receipts are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','settlement']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settlement'])
      OR OLD.state<>'accepted' OR NEW.state<>'settled' OR NEW.settlement IS NULL THEN RAISE EXCEPTION 'Native Google settlement is immutable' USING ERRCODE='55000'; END IF;
  ELSIF NEW.state<>'accepted' OR NEW.settlement IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM public.omni_oauth_grants grant_row WHERE grant_row.id=NEW.connection_id AND grant_row.tenant_id=NEW.tenant_id AND grant_row.actor_id=NEW.owner_actor_id
      AND grant_row.provider='google' AND grant_row.connection_purpose='personal' AND grant_row.account_email=NEW.intent->'request'->'review'->>'accountEmail'
      AND CASE WHEN NEW.intent->'request'->>'action'='disconnect' THEN grant_row.status='revoked' AND grant_row.authorization_generation=NEW.authorization_generation::BIGINT+1
        AND grant_row.sync_lease_owner_id IS NULL AND grant_row.sync_cursor IS NULL
      ELSE grant_row.status='active' AND grant_row.authorization_generation=NEW.authorization_generation
        AND grant_row.sync_lease_owner_id=NEW.lease_owner_id AND grant_row.sync_lease_generation=NEW.lease_generation AND grant_row.sync_lease_expires_at>clock_timestamp() END
  ) THEN RAISE EXCEPTION 'Native Google admission parent differs' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_google_personal_native_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_google_personal_native_actions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_google_personal_native_action_v1();
CREATE TRIGGER omni_google_personal_native_no_truncate BEFORE TRUNCATE ON public.omni_google_personal_native_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_google_personal_native_action_v1();
ALTER TABLE public.omni_google_personal_native_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_google_personal_native_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_google_personal_native_actions AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_google_personal_native_actor ON public.omni_google_personal_native_actions AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_google_personal_native_owner_read ON public.omni_google_personal_native_actions AS RESTRICTIVE FOR SELECT
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_private_memory_owner_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
CREATE POLICY omni_google_personal_native_owner_insert ON public.omni_google_personal_native_actions AS RESTRICTIVE FOR INSERT
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_private_memory_owner_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE));
CREATE POLICY omni_google_personal_native_owner_update ON public.omni_google_personal_native_actions AS RESTRICTIVE FOR UPDATE
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_private_memory_owner_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_private_memory_owner_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE));
CREATE POLICY omni_google_personal_native_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'google.personal.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'google.personal.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_google_personal_native_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_google_personal_review_valid_v1(JSONB),public.omni_google_personal_settlement_valid_v1(JSONB,JSONB),public.omni_protect_google_personal_native_action_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_google_personal_sync_allowed_v1(TEXT,TEXT) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_google_personal_native_actions TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,settlement) ON public.omni_google_personal_native_actions TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_google_personal_review_valid_v1(JSONB),public.omni_google_personal_settlement_valid_v1(JSONB,JSONB) TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_google_personal_sync_allowed_v1(TEXT,TEXT) TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_google_personal_native_actions TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(236,'google_personal_native_actions_v1','0a9fbeb43fd292aa663791e2332bc5e10647213e77c3b4458b41565e1c293bba',clock_timestamp());
COMMIT;
