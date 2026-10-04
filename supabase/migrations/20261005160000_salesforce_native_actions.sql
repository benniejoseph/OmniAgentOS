BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 231 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=231 AND name='customer_fact_native_intents_v1'
      AND checksum='701b5b3cbb2074fc7f438c24f9fb4bd7ab966925919b290cd87606fa2bcf1cf4'
  )<>1 THEN RAISE EXCEPTION 'Native Salesforce predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Immutable admission and exactly one optional settlement. Unknown work remains
-- accepted, including after process loss; expiration never permits a new intent.
CREATE TABLE public.omni_salesforce_native_actions (
  id TEXT PRIMARY KEY CHECK(id ~ '^salesforce-action:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner_actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,oauth_grant_id TEXT NOT NULL,authorization_generation INTEGER NOT NULL CHECK(authorization_generation>0),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL,acceptance JSONB NOT NULL,accepted_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','settled')),settlement JSONB,
  lease_owner_id TEXT,lease_generation INTEGER,
  UNIQUE(tenant_id,workspace_id,owner_actor_id,idempotency_key_sha256),
  FOREIGN KEY(tenant_id,workspace_id,connection_id) REFERENCES public.omni_salesforce_connections(tenant_id,workspace_id,connection_id),
  CHECK(owner_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CHECK(COALESCE(jsonb_typeof(intent)='object' AND pg_column_size(intent)<=32768
    AND intent ?& ARRAY['contract','scope','idempotencyKeySha256','request'] AND intent-ARRAY['contract','scope','idempotencyKeySha256','request']='{}'::JSONB
    AND intent->>'contract'='customer-salesforce-action-intent:1' AND intent->>'idempotencyKeySha256'=idempotency_key_sha256
    AND intent->'scope'=jsonb_build_object('tenantId',tenant_id,'workspaceId',workspace_id,'ownerActorId',owner_actor_id)
    AND intent->'request' ?& ARRAY['contract','workspaceId','action','review'] AND (intent->'request')-ARRAY['contract','workspaceId','action','review']='{}'::JSONB
    AND intent->'request'->>'contract'='customer-salesforce-action-request:1' AND intent->'request'->>'workspaceId'=workspace_id
    AND intent->'request'->>'action' IN ('sync','reconcile','disconnect')
    AND intent->'request'->'review'->>'tenantId'=tenant_id AND intent->'request'->'review'->>'workspaceId'=workspace_id
    AND intent->'request'->'review'->>'ownerActorId'=owner_actor_id AND intent->'request'->'review'->>'connectionId'=connection_id
    AND intent->'request'->'review'->>'oauthGrantId'=oauth_grant_id
    AND intent->'request'->'review'->'authorizationGeneration'=to_jsonb(authorization_generation)
    AND intent->'request'->'review'->'grantAuthorizationGeneration'=to_jsonb(authorization_generation)
    AND intent->'request'->'review'->>'connectionState'='active' AND intent->'request'->'review'->>'grantStatus'='active'
    AND intent->'request'->'review'->>'reviewSha256' ~ '^[a-f0-9]{64}$',FALSE)),
  CHECK(COALESCE(jsonb_typeof(acceptance)='object' AND pg_column_size(acceptance)<=32768
    AND acceptance ?& ARRAY['contract','id','scope','action','idempotencyKeySha256','requestSha256','review','acceptedAt','localRevoked','acceptanceSha256']
    AND acceptance-ARRAY['contract','id','scope','action','idempotencyKeySha256','requestSha256','review','acceptedAt','localRevoked','acceptanceSha256']='{}'::JSONB
    AND acceptance->>'contract'='customer-salesforce-action-acceptance:1' AND acceptance->>'id'=id AND acceptance->'scope'=intent->'scope'
    AND acceptance->'action'=intent->'request'->'action' AND acceptance->'review'=intent->'request'->'review'
    AND acceptance->>'idempotencyKeySha256'=idempotency_key_sha256 AND acceptance->>'requestSha256'=request_sha256
    AND acceptance->>'acceptanceSha256' ~ '^[a-f0-9]{64}$' AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at
    AND acceptance->'localRevoked'=to_jsonb(intent->'request'->>'action'='disconnect'),FALSE)),
  CHECK(COALESCE(CASE WHEN intent->'request'->>'action'='disconnect' THEN lease_owner_id IS NULL AND lease_generation IS NULL
    ELSE lease_owner_id IS NOT NULL AND lease_generation IS NOT NULL AND lease_generation>0 END,FALSE)),
  CHECK((state='settled')=(settlement IS NOT NULL)),
  CHECK(settlement IS NULL OR COALESCE(jsonb_typeof(settlement)='object' AND pg_column_size(settlement)<=16384
    AND settlement->'action'=acceptance->'action' AND (settlement->>'settledAt')::TIMESTAMPTZ>=accepted_at
    AND CASE settlement->>'action'
      WHEN 'sync' THEN settlement ?& ARRAY['action','status','pages','records','advanced','conflicts','projection','settledAt']
        AND settlement-ARRAY['action','status','pages','records','advanced','conflicts','projection','settledAt']='{}'::JSONB
        AND settlement->>'status' IN ('healthy','partial') AND jsonb_typeof(settlement->'projection')='object'
      WHEN 'reconcile' THEN settlement ?& ARRAY['action','status','checked','findings','settledAt']
        AND settlement-ARRAY['action','status','checked','findings','settledAt']='{}'::JSONB AND settlement->>'status'='complete'
      WHEN 'disconnect' THEN settlement ?& ARRAY['action','status','providerRevocation','settledAt']
        AND settlement-ARRAY['action','status','providerRevocation','settledAt']='{}'::JSONB AND settlement->>'status'='local_revoked'
        AND settlement->>'providerRevocation' IN ('revoked','not_supported','unconfirmed')
      ELSE FALSE END,FALSE))
);
CREATE UNIQUE INDEX omni_salesforce_native_pending ON public.omni_salesforce_native_actions(tenant_id,workspace_id,owner_actor_id) WHERE state='accepted';

CREATE FUNCTION public.omni_protect_salesforce_native_action_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native Salesforce evidence cannot be removed' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','settlement']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settlement'])
      OR OLD.state<>'accepted' OR NEW.state<>'settled' OR NEW.settlement IS NULL THEN
      RAISE EXCEPTION 'Native Salesforce settlement is immutable' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.state<>'accepted' OR NEW.settlement IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM public.omni_salesforce_connections connection_row
      JOIN public.omni_oauth_grants grant_row ON grant_row.tenant_id=connection_row.tenant_id AND grant_row.actor_id=connection_row.owner_actor_id
        AND grant_row.id=connection_row.oauth_grant_id AND grant_row.provider='salesforce'
      WHERE connection_row.tenant_id=NEW.tenant_id AND connection_row.workspace_id=NEW.workspace_id AND connection_row.owner_actor_id=NEW.owner_actor_id
        AND connection_row.connection_id=NEW.connection_id AND connection_row.oauth_grant_id=NEW.oauth_grant_id
        AND connection_row.authorization_generation=NEW.authorization_generation
        AND connection_row.organization_id_sha256=NEW.intent->'request'->'review'->>'organizationIdSha256'
        AND connection_row.instance_origin=NEW.intent->'request'->'review'->>'instanceOrigin'
        AND CASE WHEN NEW.intent->'request'->>'action'='disconnect' THEN
          connection_row.connection_state='revoked' AND grant_row.status='revoked' AND grant_row.authorization_generation=NEW.authorization_generation::BIGINT+1
        ELSE connection_row.connection_state='active' AND grant_row.status='active' AND grant_row.authorization_generation=NEW.authorization_generation
          AND grant_row.scopes @> ARRAY['api','refresh_token']::TEXT[]
          AND connection_row.sync_lease_owner_id=NEW.lease_owner_id AND connection_row.sync_lease_generation=NEW.lease_generation
          AND connection_row.sync_lease_expires_at>clock_timestamp() END
    ) THEN RAISE EXCEPTION 'Native Salesforce admission parent differs' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_salesforce_native_action_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_salesforce_native_actions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_salesforce_native_action_v1();
CREATE TRIGGER omni_salesforce_native_action_no_truncate BEFORE TRUNCATE ON public.omni_salesforce_native_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_salesforce_native_action_v1();
ALTER TABLE public.omni_salesforce_native_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_salesforce_native_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_salesforce_native_actions AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_salesforce_native_actions_actor ON public.omni_salesforce_native_actions AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_salesforce_native_actions_read ON public.omni_salesforce_native_actions AS RESTRICTIVE FOR SELECT
USING(public.omni_salesforce_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,FALSE));
CREATE POLICY omni_salesforce_native_actions_insert ON public.omni_salesforce_native_actions AS RESTRICTIVE FOR INSERT
WITH CHECK(public.omni_salesforce_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,TRUE));
CREATE POLICY omni_salesforce_native_actions_update ON public.omni_salesforce_native_actions AS RESTRICTIVE FOR UPDATE
USING(public.omni_salesforce_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,TRUE))
WITH CHECK(public.omni_salesforce_workspace_access_v1_allows(tenant_id,workspace_id,owner_actor_id,TRUE));
CREATE POLICY omni_salesforce_native_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'customer.salesforce.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'customer.salesforce.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_salesforce_native_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_salesforce_native_action_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_salesforce_native_actions TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,settlement) ON public.omni_salesforce_native_actions TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_salesforce_native_actions TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(232,'salesforce_native_actions_v1','68250ab3f08534b5e9e1fffda2563281759eb6e2e7d416e3ad624cf60ff0dbd0',clock_timestamp());
COMMIT;
