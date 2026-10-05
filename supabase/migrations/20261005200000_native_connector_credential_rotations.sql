BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 239 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=239 AND name='native_connector_trash_v1'
      AND checksum='6af2db420131c4c68b3279b4030f161d72c85b2a740477fc6f77aa6b85482d83'
  )<>1 THEN RAISE EXCEPTION 'Native credential preparation predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

CREATE FUNCTION public.omni_native_connector_intent_valid_v4(i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN i->'request'->>'action'<>'rotate_mcp' THEN public.omni_native_connector_intent_valid_v3(i,a)
    ELSE COALESCE(i->'request'->>'contract'='asael-connector-prepared-action:1'
      AND i->'request'->>'kind'='mcp' AND a->>'kind'='mcp' AND a->>'action'='rotate_mcp'
      AND jsonb_typeof(i->'request'->'preparationId')='string' AND i->'request'->>'preparationId' ~ '^connector-preparation:[a-f0-9]{64}$'
      AND jsonb_typeof(i->'request'->'preparationSha256')='string' AND i->'request'->>'preparationSha256' ~ '^[a-f0-9]{64}$'
      AND a->'reviewSha256'=i->'request'->'preparationSha256'
      AND (i->'request'->'review'->>'credentialVersion')::NUMERIC<2147483647
      AND public.omni_native_connector_intent_valid_v1(
        jsonb_set(jsonb_set(i #- '{request,preparationId}' #- '{request,preparationSha256}',
          '{request,contract}','"asael-connector-action:1"'::JSONB),'{request,action}','"disable"'::JSONB),
        jsonb_set(jsonb_set(a,'{action}','"disable"'::JSONB),'{reviewSha256}',i->'request'->'review'->'reviewSha256')),FALSE)
    END
$function$;
CREATE FUNCTION public.omni_native_connector_settlement_valid_v4(s JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN a->>'action'<>'rotate_mcp' THEN public.omni_native_connector_settlement_valid_v3(s,a)
    ELSE s IS NULL OR COALESCE(s->'result'->>'operation'='rotate_mcp'
      AND jsonb_typeof(s->'result'->'credentialVersion')='number'
      AND s->'result'->>'credentialVersion' ~ '^[1-9][0-9]{0,9}$'
      AND (s->'result'->>'credentialVersion')::NUMERIC BETWEEN 1 AND 2147483647
      AND public.omni_native_connector_settlement_valid_v2(
        jsonb_set(jsonb_set(s,'{result,operation}','"remove_credential"'::JSONB),'{result,credentialVersion}','2'::JSONB),
        jsonb_set(a,'{action}','"remove_credential"'::JSONB)),FALSE)
    END
$function$;
ALTER TABLE public.omni_native_connector_actions
  DROP CONSTRAINT omni_native_connector_intent_v3,
  DROP CONSTRAINT omni_native_connector_settlement_v3,
  DROP CONSTRAINT omni_native_connector_actions_action_check,
  ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash','rotate_mcp')),
  ADD CONSTRAINT omni_native_connector_intent_v4 CHECK(public.omni_native_connector_intent_valid_v4(intent,acceptance)),
  ADD CONSTRAINT omni_native_connector_settlement_v4 CHECK(public.omni_native_connector_settlement_valid_v4(settlement,acceptance)),
  ADD CONSTRAINT omni_native_connector_rotation_version CHECK(action<>'rotate_mcp' OR settlement IS NULL OR COALESCE(
    (settlement->'result'->>'credentialVersion')::NUMERIC=(intent->'request'->'review'->>'credentialVersion')::NUMERIC+1,FALSE));

CREATE FUNCTION public.omni_native_credential_preparation_intent_valid_v1(i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(i)='object' AND pg_column_size(i)<=16384
    AND i ?& ARRAY['contract','scope','keySha256','nonce','operation','connectorId','review','declaration']
    AND i-ARRAY['contract','scope','keySha256','nonce','operation','connectorId','review','declaration']='{}'::JSONB
    AND i->>'contract'='asael-connector-preparation-intent:1' AND i->>'operation'='rotate_mcp'
    AND jsonb_typeof(i->'nonce')='string' AND i->>'nonce' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    AND (i->'review'->>'credentialVersion')::NUMERIC<2147483647
    AND public.omni_native_connector_intent_valid_v1(
      jsonb_build_object('contract','asael-connector-action-intent:1','scope',i->'scope','keySha256',i->'keySha256',
        'request',jsonb_build_object('contract','asael-connector-action:1','kind','mcp','connectorId',i->'connectorId','action','disable','review',i->'review')),
      jsonb_build_object('contract','asael-connector-acceptance:1','id','connector-acceptance:'||repeat('0',64),'scope',i->'scope',
        'keySha256',i->'keySha256','requestSha256',repeat('0',64),'kind','mcp','connectorId',i->'connectorId','action','disable',
        'reviewSha256',i->'review'->'reviewSha256','acceptedAt','2026-10-05T00:00:00.000Z','acceptanceSha256',repeat('0',64)))
    AND jsonb_typeof(i->'declaration')='object'
    AND i->'declaration' ?& ARRAY['name','endpoint','endpointRedacted','authType','authTokenEnv','authHeaderName','defaultRiskLevel','approvalRequired','specSource','specUrl','specUrlRedacted']
    AND (i->'declaration')-ARRAY['name','endpoint','endpointRedacted','authType','authTokenEnv','authHeaderName','defaultRiskLevel','approvalRequired','specSource','specUrl','specUrlRedacted']='{}'::JSONB
    AND jsonb_typeof(i->'declaration'->'name')='string' AND length(i->'declaration'->>'name') BETWEEN 1 AND 120
    AND jsonb_typeof(i->'declaration'->'endpoint')='string' AND length(i->'declaration'->>'endpoint') BETWEEN 1 AND 2048
    AND jsonb_typeof(i->'declaration'->'endpointRedacted')='boolean' AND jsonb_typeof(i->'declaration'->'approvalRequired')='boolean'
    AND i->'declaration'->>'authType'='bearer_vault' AND i->'declaration'->'authTokenEnv'='null'::JSONB
    AND i->'declaration'->'authHeaderName'='null'::JSONB AND i->'declaration'->'defaultRiskLevel' IN ('0'::JSONB,'1'::JSONB,'2'::JSONB,'3'::JSONB)
    AND i->'declaration'->>'specSource'='none' AND i->'declaration'->'specUrl'='null'::JSONB AND i->'declaration'->'specUrlRedacted'='false'::JSONB,FALSE)
$function$;
CREATE FUNCTION public.omni_native_credential_preparation_proof_valid_v1(p JSONB,i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(p)='object' AND pg_column_size(p)<=20000
    AND p ?& ARRAY['contract','id','scope','keySha256','intentSha256','nonce','operation','connectorId','review','declaration','configurationSha256','preparedAt','expiresAt','preparationSha256']
    AND p-ARRAY['contract','id','scope','keySha256','intentSha256','nonce','operation','connectorId','review','declaration','configurationSha256','preparedAt','expiresAt','preparationSha256']='{}'::JSONB
    AND p->>'contract'='asael-connector-preparation:1' AND p->>'id' ~ '^connector-preparation:[a-f0-9]{64}$'
    AND (p-ARRAY['contract','id','intentSha256','configurationSha256','preparedAt','expiresAt','preparationSha256'])=(i-'contract')
    AND p->'configurationSha256'=i->'review'->'configurationSha256'
    AND jsonb_typeof(p->'preparedAt')='string' AND jsonb_typeof(p->'expiresAt')='string'
    AND (p->>'expiresAt')::TIMESTAMPTZ-(p->>'preparedAt')::TIMESTAMPTZ=INTERVAL '15 minutes'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','preparationSha256','configurationSha256']) f
      WHERE jsonb_typeof(p->f) IS DISTINCT FROM 'string' OR p->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;
CREATE FUNCTION public.omni_native_credential_abandonment_valid_v1(a JSONB,i JSONB,p JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(a)='object' AND pg_column_size(a)<=4096
    AND a ?& ARRAY['contract','id','scope','keySha256','intentSha256','preparationSha256','abandonedAt','abandonmentSha256']
    AND a-ARRAY['contract','id','scope','keySha256','intentSha256','preparationSha256','abandonedAt','abandonmentSha256']='{}'::JSONB
    AND a->>'contract'='asael-connector-credential-preparation-abandonment:1'
    AND a->>'id' ~ '^connector-preparation-abandonment:[a-f0-9]{64}$' AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256'
    AND jsonb_typeof(a->'abandonedAt')='string'
    AND (p IS NULL AND a->'preparationSha256'='null'::JSONB OR p IS NOT NULL AND a->'preparationSha256'=p->'preparationSha256'
      AND a->'intentSha256'=p->'intentSha256' AND (a->>'abandonedAt')::TIMESTAMPTZ>=(p->>'preparedAt')::TIMESTAMPTZ)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','abandonmentSha256']) f
      WHERE jsonb_typeof(a->f) IS DISTINCT FROM 'string' OR a->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

-- No connector FK: exact preparation and tombstone recovery survive Trash.
-- Terminal keys are never deleted or recycled, including before preparation.
CREATE TABLE public.omni_native_connector_credential_preparations(
  id TEXT PRIMARY KEY CHECK(id ~ '^connector-preparation:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL REFERENCES public.omni_auth_tenants(id),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320 AND owner_actor_id=btrim(owner_actor_id)),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  connector_id TEXT NOT NULL CHECK(connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'),
  intent JSONB NOT NULL, preparation JSONB, state TEXT NOT NULL CHECK(state IN ('ready','expired','consumed','abandoned')),
  expires_at TIMESTAMPTZ, sealed_payload JSONB, payload_commitment TEXT CHECK(payload_commitment ~ '^[a-f0-9]{64}$'),
  consumed_by TEXT REFERENCES public.omni_native_connector_actions(id), consumed_key_sha256 TEXT CHECK(consumed_key_sha256 ~ '^[a-f0-9]{64}$'), abandonment JSONB,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(public.omni_native_credential_preparation_intent_valid_v1(intent)),
  CHECK(COALESCE(intent->'scope'=jsonb_build_object('tenantId',tenant_id,'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->>'connectorId'=connector_id,FALSE)),
  CHECK(preparation IS NULL AND state='abandoned' AND expires_at IS NULL AND payload_commitment IS NULL OR
    preparation IS NOT NULL AND expires_at IS NOT NULL AND payload_commitment IS NOT NULL
      AND public.omni_native_credential_preparation_proof_valid_v1(preparation,intent)
      AND preparation->>'id'=id AND (preparation->>'expiresAt')::TIMESTAMPTZ=expires_at),
  CHECK((state='ready')=(sealed_payload IS NOT NULL)),
  CHECK(sealed_payload IS NULL OR COALESCE(jsonb_typeof(sealed_payload)='object' AND pg_column_size(sealed_payload)<=100000
    AND sealed_payload ?& ARRAY['version','algorithm','keyId','iv','ciphertext','tag']
    AND sealed_payload-ARRAY['version','algorithm','keyId','iv','ciphertext','tag']='{}'::JSONB
    AND sealed_payload->'version'='1'::JSONB AND sealed_payload->>'algorithm'='aes-256-gcm'
    AND sealed_payload->>'keyId' ~ '^[A-Za-z0-9_.:-]{1,80}$' AND sealed_payload->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    AND sealed_payload->>'tag' ~ '^[A-Za-z0-9_-]{22}$' AND sealed_payload->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',FALSE)),
  CHECK((state='consumed')=(consumed_by IS NOT NULL) AND (state='consumed')=(consumed_key_sha256 IS NOT NULL)),
  CHECK((state='abandoned')=(abandonment IS NOT NULL)),
  CHECK(abandonment IS NULL OR public.omni_native_credential_abandonment_valid_v1(abandonment,intent,preparation))
);
CREATE INDEX omni_native_credential_preparation_expiry ON public.omni_native_connector_credential_preparations(tenant_id,expires_at,id) WHERE sealed_payload IS NOT NULL;
CREATE FUNCTION public.omni_protect_native_credential_preparation_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE system_scope BOOLEAN := COALESCE(public.omni_system_scope_enabled(),FALSE); linked RECORD;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Preparation evidence and tombstones are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','sealed_payload','consumed_by','consumed_key_sha256','abandonment']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','sealed_payload','consumed_by','consumed_key_sha256','abandonment'])
      OR NEW.sealed_payload IS NOT NULL OR OLD.state NOT IN ('ready','expired')
    THEN RAISE EXCEPTION 'Preparation identity and terminal evidence are immutable' USING ERRCODE='55000'; END IF;
    IF NEW.state='expired' THEN
      IF NOT system_scope OR OLD.state<>'ready' OR OLD.expires_at>clock_timestamp() THEN
        RAISE EXCEPTION 'Only bounded maintenance may expire staging' USING ERRCODE='42501'; END IF;
    ELSIF NEW.state='abandoned' THEN
      IF system_scope OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,FALSE) THEN
        RAISE EXCEPTION 'Exact active original owner cleanup is required' USING ERRCODE='42501'; END IF;
    ELSIF NEW.state='consumed' THEN
      IF system_scope OR OLD.state<>'ready' OR OLD.expires_at<=clock_timestamp()
        OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,TRUE)
      THEN RAISE EXCEPTION 'A current ready preparation and manager are required' USING ERRCODE='42501'; END IF;
      SELECT * INTO linked FROM public.omni_native_connector_actions WHERE id=NEW.consumed_by AND tenant_id=NEW.tenant_id
        AND owner_actor_id=NEW.owner_actor_id AND canonical_actor_id=NEW.canonical_actor_id AND action='rotate_mcp'
        AND connector_id=NEW.connector_id AND idempotency_key_sha256=NEW.consumed_key_sha256;
      IF NOT FOUND OR linked.intent->'request'->>'preparationId'<>NEW.id
        OR linked.acceptance->'reviewSha256' IS DISTINCT FROM NEW.preparation->'preparationSha256'
        OR linked.intent->'request'->'review' IS DISTINCT FROM NEW.preparation->'review'
        OR linked.accepted_at<(NEW.preparation->>'preparedAt')::TIMESTAMPTZ OR linked.accepted_at>=NEW.expires_at
      THEN RAISE EXCEPTION 'Consumption must bind its exact accepted action' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'Preparation cannot be reopened' USING ERRCODE='55000'; END IF;
  ELSE
    IF system_scope OR NEW.state NOT IN ('ready','abandoned') OR
      NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,NEW.state='ready')
    THEN RAISE EXCEPTION 'Exact original owner preparation authority is required' USING ERRCODE='42501'; END IF;
    IF NEW.state='abandoned' AND NEW.preparation IS NOT NULL THEN RAISE EXCEPTION 'An absent key cannot invent an issued proof' USING ERRCODE='23514'; END IF;
    IF NEW.state='ready' AND ((NEW.preparation->>'preparedAt')::TIMESTAMPTZ>clock_timestamp() OR NEW.expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'A fresh preparation is required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_credential_preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_native_connector_credential_preparations
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_credential_preparation_v1();
CREATE TRIGGER omni_native_credential_preparation_no_truncate BEFORE TRUNCATE ON public.omni_native_connector_credential_preparations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_credential_preparation_v1();
ALTER TABLE public.omni_native_connector_credential_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_connector_credential_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_connector_credential_preparations AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_credential_preparation_actor ON public.omni_native_connector_credential_preparations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_credential_preparation_owner ON public.omni_native_connector_credential_preparations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
REVOKE ALL ON public.omni_native_connector_credential_preparations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_connector_intent_valid_v4(JSONB,JSONB),public.omni_native_connector_settlement_valid_v4(JSONB,JSONB),
  public.omni_native_credential_preparation_intent_valid_v1(JSONB),public.omni_native_credential_preparation_proof_valid_v1(JSONB,JSONB),
  public.omni_native_credential_abandonment_valid_v1(JSONB,JSONB,JSONB),public.omni_protect_native_credential_preparation_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_native_connector_credential_preparations TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,sealed_payload,consumed_by,consumed_key_sha256,abandonment) ON public.omni_native_connector_credential_preparations TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_connector_intent_valid_v4(JSONB,JSONB),public.omni_native_connector_settlement_valid_v4(JSONB,JSONB),public.omni_native_credential_preparation_intent_valid_v1(JSONB),public.omni_native_credential_preparation_proof_valid_v1(JSONB,JSONB),public.omni_native_credential_abandonment_valid_v1(JSONB,JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_native_connector_credential_preparations TO omni_backup; END IF;
END
$grants$;
-- Digest of this reviewed SQL migration file is recorded below.
INSERT INTO public.omni_schema_version (
  version,
  name,
  checksum,
  applied_at
) VALUES (
  240,
  'native_connector_credential_rotations_v1',
  'a7d4cadf15b68e774a580a1cac9e1fbf226c6cd7fe1fcfadf83d49cb781e936b',
  clock_timestamp()
);
COMMIT;
