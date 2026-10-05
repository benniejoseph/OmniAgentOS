BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 236 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=236 AND name='google_personal_native_actions_v1'
      AND checksum='0a9fbeb43fd292aa663791e2332bc5e10647213e77c3b4458b41565e1c293bba'
  )<>1 THEN RAISE EXCEPTION 'Native connector predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- The registry stays private. Only this current alias/canonical membership
-- predicate is published. Connector management remains admin/system, not operator.
CREATE FUNCTION public.omni_native_connector_actor_v1(
  requested_tenant TEXT,requested_owner TEXT,requested_canonical TEXT,require_management BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF require_management IS NULL OR requested_tenant IS DISTINCT FROM public.omni_current_tenant()
    OR requested_tenant IS NULL OR length(requested_tenant) NOT BETWEEN 1 AND 120 OR requested_tenant<>btrim(requested_tenant)
    OR requested_owner IS NULL OR length(requested_owner) NOT BETWEEN 1 AND 320 OR requested_owner<>btrim(requested_owner)
    OR requested_canonical IS NULL OR requested_canonical !~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR COALESCE(public.omni_system_scope_enabled(),FALSE)
    OR NOT COALESCE(public.omni_actor_scope_v1_allows(requested_tenant,requested_owner),FALSE)
  THEN RETURN FALSE; END IF;
  PERFORM 1 FROM public.omni_auth_user_actor_identifiers identifier
    JOIN public.omni_auth_users u ON u.actor_id=identifier.canonical_actor_id AND u.status='active'
    JOIN public.omni_auth_memberships member ON member.user_id=u.id AND member.tenant_id=requested_tenant AND member.status='active'
    WHERE identifier.actor_identifier COLLATE "C"=requested_owner COLLATE "C" AND identifier.canonical_actor_id=requested_canonical
      AND (NOT require_management OR member.role IN ('admin','system')) FOR SHARE OF identifier,u,member;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION public.omni_native_connector_intent_valid_v1(i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(
    jsonb_typeof(i)='object' AND pg_column_size(i)<=16384 AND i ?& ARRAY['contract','scope','keySha256','request']
    AND i-ARRAY['contract','scope','keySha256','request']='{}'::JSONB AND i->>'contract'='asael-connector-action-intent:1'
    AND jsonb_typeof(i->'scope')='object' AND i->'scope' ?& ARRAY['tenantId','ownerActorId','canonicalActorId']
    AND (i->'scope')-ARRAY['tenantId','ownerActorId','canonicalActorId']='{}'::JSONB
    AND jsonb_typeof(i->'keySha256')='string' AND i->>'keySha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(i->'request')='object' AND i->'request' ?& ARRAY['contract','kind','connectorId','action','review']
    AND (i->'request')-ARRAY['contract','kind','connectorId','action','review']='{}'::JSONB
    AND i->'request'->>'contract'='asael-connector-action:1' AND i->'request'->>'kind' IN ('mcp','openapi')
    AND i->'request'->>'action' IN ('review_contracts','enable','disable')
    AND (i->'request'->>'kind'='mcp' OR i->'request'->>'action'='review_contracts')
    AND jsonb_typeof(i->'request'->'review')='object'
    AND i->'request'->'review' ?& ARRAY['kind','connectorId','connectorSha256','contractsSha256','configurationSha256','reviewFingerprint','credentialVersion','reviewSha256']
    AND (i->'request'->'review')-ARRAY['kind','connectorId','connectorSha256','contractsSha256','configurationSha256','reviewFingerprint','credentialVersion','reviewSha256']='{}'::JSONB
    AND i->'request'->'review'->'kind'=i->'request'->'kind' AND i->'request'->'review'->'connectorId'=i->'request'->'connectorId'
    AND jsonb_typeof(i->'request'->'review'->'credentialVersion')='number'
    AND (i->'request'->'review'->>'credentialVersion') ~ '^(0|[1-9][0-9]{0,9})$'
    AND (i->'request'->'review'->>'credentialVersion')::NUMERIC<=2147483647
    AND (i->'request'->'review'->'reviewFingerprint'='null'::JSONB OR
      jsonb_typeof(i->'request'->'review'->'reviewFingerprint')='string' AND i->'request'->'review'->>'reviewFingerprint' ~ '^[A-Za-z0-9_-]{43}$')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['connectorSha256','contractsSha256','configurationSha256','reviewSha256']) field
      WHERE jsonb_typeof(i->'request'->'review'->field) IS DISTINCT FROM 'string' OR (i->'request'->'review'->>field) !~ '^[a-f0-9]{64}$')
    AND jsonb_typeof(a)='object' AND pg_column_size(a)<=8192
    AND a ?& ARRAY['contract','id','scope','keySha256','requestSha256','kind','connectorId','action','reviewSha256','acceptedAt','acceptanceSha256']
    AND a-ARRAY['contract','id','scope','keySha256','requestSha256','kind','connectorId','action','reviewSha256','acceptedAt','acceptanceSha256']='{}'::JSONB
    AND a->>'contract'='asael-connector-acceptance:1' AND a->>'id' ~ '^connector-acceptance:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256' AND a->'kind'=i->'request'->'kind'
    AND a->'connectorId'=i->'request'->'connectorId' AND a->'action'=i->'request'->'action'
    AND a->'reviewSha256'=i->'request'->'review'->'reviewSha256' AND jsonb_typeof(a->'acceptedAt')='string'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['requestSha256','acceptanceSha256']) field
      WHERE jsonb_typeof(a->field) IS DISTINCT FROM 'string' OR (a->>field) !~ '^[a-f0-9]{64}$'),FALSE)
$function$;
CREATE FUNCTION public.omni_native_connector_settlement_valid_v1(s JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT s IS NULL OR COALESCE(jsonb_typeof(s)='object' AND pg_column_size(s)<=8192
    AND s ?& ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']
    AND s-ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']='{}'::JSONB
    AND s->>'contract'='asael-connector-settlement:1' AND s->'acceptanceId'=a->'id'
    AND jsonb_typeof(s->'settledAt')='string' AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'acceptedAt')::TIMESTAMPTZ
    AND jsonb_typeof(s->'settlementSha256')='string' AND s->>'settlementSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(s->'result')='object' AND s->'result' ?& ARRAY['kind','connectorId','status','contractCount','promotedCount','connectorSha256','contractsSha256']
    AND (s->'result')-ARRAY['kind','connectorId','status','contractCount','promotedCount','connectorSha256','contractsSha256']='{}'::JSONB
    AND s->'result'->'kind'=a->'kind' AND s->'result'->'connectorId'=a->'connectorId'
    AND s->'result'->>'status' IN ('active','disabled','error')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['contractCount','promotedCount']) field WHERE
      jsonb_typeof(s->'result'->field) IS DISTINCT FROM 'number' OR (s->'result'->>field) !~ '^(0|[1-9][0-9]{0,2})$'
      OR (s->'result'->>field)::NUMERIC>200)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['connectorSha256','contractsSha256']) field WHERE
      jsonb_typeof(s->'result'->field) IS DISTINCT FROM 'string' OR (s->'result'->>field) !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

-- Tenant connectors are shared; action evidence belongs only to its submitter.
-- No parent FK: exact historical evidence survives a later connector Trash action.
CREATE TABLE public.omni_native_connector_actions(
  id TEXT PRIMARY KEY CHECK(id ~ '^connector-acceptance:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL CHECK(tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320 AND owner_actor_id=btrim(owner_actor_id)),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK(kind IN ('mcp','openapi')),
  connector_id TEXT NOT NULL CHECK(connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'),
  action TEXT NOT NULL CHECK(action IN ('review_contracts','enable','disable')),
  intent JSONB NOT NULL,acceptance JSONB NOT NULL,accepted_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','settled')),settlement JSONB,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(public.omni_native_connector_intent_valid_v1(intent,acceptance)),
  CHECK(COALESCE(intent->'scope'=jsonb_build_object('tenantId',tenant_id,'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->'request'->>'kind'=kind AND intent->'request'->>'connectorId'=connector_id
    AND intent->'request'->>'action'=action AND acceptance->>'id'=id AND (acceptance->>'acceptedAt')::TIMESTAMPTZ=accepted_at,FALSE)),
  CHECK((state='settled')=(settlement IS NOT NULL)),CHECK(public.omni_native_connector_settlement_valid_v1(settlement,acceptance))
);
CREATE UNIQUE INDEX omni_native_connector_pending ON public.omni_native_connector_actions(tenant_id,kind,connector_id) WHERE state='accepted';
CREATE FUNCTION public.omni_protect_native_connector_action_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native connector receipts are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','settlement']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settlement'])
      OR OLD.state<>'accepted' OR NEW.state<>'settled' OR NEW.settlement IS NULL
    THEN RAISE EXCEPTION 'Native connector settlement is immutable' USING ERRCODE='55000'; END IF;
  ELSIF NEW.state<>'accepted' OR NEW.settlement IS NOT NULL THEN
    RAISE EXCEPTION 'Native connector admission must precede settlement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_connector_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_native_connector_actions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_connector_action_v1();
CREATE TRIGGER omni_native_connector_no_truncate BEFORE TRUNCATE ON public.omni_native_connector_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_connector_action_v1();
ALTER TABLE public.omni_native_connector_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_connector_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_connector_actions AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_connector_actor ON public.omni_native_connector_actions AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_connector_owner_read ON public.omni_native_connector_actions AS RESTRICTIVE FOR SELECT
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
CREATE POLICY omni_native_connector_owner_insert ON public.omni_native_connector_actions AS RESTRICTIVE FOR INSERT
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE));
CREATE POLICY omni_native_connector_owner_update ON public.omni_native_connector_actions AS RESTRICTIVE FOR UPDATE
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE));
CREATE POLICY omni_native_connector_event_actor ON public.omni_events AS RESTRICTIVE FOR ALL
USING(type NOT LIKE 'connector.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))
WITH CHECK(type NOT LIKE 'connector.native.%' OR (SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id));
REVOKE ALL ON public.omni_native_connector_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_connector_actor_v1(TEXT,TEXT,TEXT,BOOLEAN),public.omni_native_connector_intent_valid_v1(JSONB,JSONB),
  public.omni_native_connector_settlement_valid_v1(JSONB,JSONB),public.omni_protect_native_connector_action_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_native_connector_actions TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,settlement) ON public.omni_native_connector_actions TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_connector_actor_v1(TEXT,TEXT,TEXT,BOOLEAN),public.omni_native_connector_intent_valid_v1(JSONB,JSONB),public.omni_native_connector_settlement_valid_v1(JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_native_connector_actions TO omni_backup; END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(237,'native_connector_controls_v1','2684d9dd6c04bd62738e7d06e2a2615751d3aab1690a11f40d979029ca0a09df',clock_timestamp());
COMMIT;
