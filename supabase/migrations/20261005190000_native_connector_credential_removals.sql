BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 237 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=237 AND name='native_connector_controls_v1'
      AND checksum='2684d9dd6c04bd62738e7d06e2a2615751d3aab1690a11f40d979029ca0a09df'
  )<>1 THEN RAISE EXCEPTION 'Credential removal predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- Keep the v40 validator and every historical receipt intact. Removal reuses its
-- exact scope/pin/acceptance shape checks after projecting only its action tag.
CREATE FUNCTION public.omni_native_connector_intent_valid_v2(i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN i->'request'->>'contract'='asael-connector-action:1'
    THEN public.omni_native_connector_intent_valid_v1(i,a)
    ELSE COALESCE(
      i->'request'->>'contract'='asael-connector-lifecycle-action:1'
      AND i->'request'->>'kind'='mcp' AND i->'request'->>'action'='remove_credential'
      AND i->'request'->'preview'='null'::JSONB AND a->>'kind'='mcp' AND a->>'action'='remove_credential'
      AND CASE WHEN i->'request'->'review'->>'credentialVersion' ~ '^[1-9][0-9]{0,9}$'
        THEN (i->'request'->'review'->>'credentialVersion')::NUMERIC BETWEEN 1 AND 2147483646 ELSE FALSE END
      AND public.omni_native_connector_intent_valid_v1(
        jsonb_set(jsonb_set(i #- '{request,preview}','{request,contract}','"asael-connector-action:1"'::JSONB),'{request,action}','"disable"'::JSONB),
        jsonb_set(a,'{action}','"disable"'::JSONB)),FALSE)
    END
$function$;

CREATE FUNCTION public.omni_native_connector_settlement_valid_v2(s JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN a->>'action'<>'remove_credential'
    THEN public.omni_native_connector_settlement_valid_v1(s,a)
    ELSE s IS NULL OR COALESCE(
      jsonb_typeof(s)='object' AND pg_column_size(s)<=8192
      AND s ?& ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']
      AND s-ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']='{}'::JSONB
      AND s->>'contract'='asael-connector-settlement:2' AND s->'acceptanceId'=a->'id'
      AND jsonb_typeof(s->'settledAt')='string' AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'acceptedAt')::TIMESTAMPTZ
      AND jsonb_typeof(s->'settlementSha256')='string' AND s->>'settlementSha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(s->'result')='object'
      AND s->'result' ?& ARRAY['kind','connectorId','operation','status','connectorStatus','contractCount','credentialVersion','connectorSha256','contractsSha256','configurationSha256','trash','failureCode']
      AND (s->'result')-ARRAY['kind','connectorId','operation','status','connectorStatus','contractCount','credentialVersion','connectorSha256','contractsSha256','configurationSha256','trash','failureCode']='{}'::JSONB
      AND s->'result'->>'kind'='mcp' AND s->'result'->'kind'=a->'kind' AND s->'result'->'connectorId'=a->'connectorId'
      AND s->'result'->>'operation'='remove_credential' AND s->'result'->'operation'=a->'action'
      AND s->'result'->>'status'='complete' AND s->'result'->>'connectorStatus'='disabled'
      AND s->'result'->'contractCount'='0'::JSONB AND s->'result'->'trash'='null'::JSONB AND s->'result'->'failureCode'='null'::JSONB
      AND jsonb_typeof(s->'result'->'credentialVersion')='number'
      AND CASE WHEN s->'result'->>'credentialVersion' ~ '^[1-9][0-9]{0,9}$'
        THEN (s->'result'->>'credentialVersion')::NUMERIC BETWEEN 2 AND 2147483647 ELSE FALSE END
      AND s->'result'->>'contractsSha256'='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['connectorSha256','contractsSha256','configurationSha256']) field
        WHERE jsonb_typeof(s->'result'->field) IS DISTINCT FROM 'string' OR (s->'result'->>field) !~ '^[a-f0-9]{64}$'),FALSE)
    END
$function$;

-- Replace only the two v1 shape checks and the finite action set. Preserve owner
-- RLS, current-management predicates, key/pending-target uniqueness and the
-- accepted->settled-only immutable trigger from237 without changing their grants.
DO $constraints$
DECLARE constraint_name TEXT; removed INTEGER := 0;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.omni_native_connector_actions'::regclass AND contype='c'
      AND (strpos(pg_get_constraintdef(oid),'omni_native_connector_intent_valid_v1(')>0
        OR strpos(pg_get_constraintdef(oid),'omni_native_connector_settlement_valid_v1(')>0)
  LOOP
    EXECUTE format('ALTER TABLE public.omni_native_connector_actions DROP CONSTRAINT %I',constraint_name);
    removed := removed + 1;
  END LOOP;
  IF removed<>2 THEN RAISE EXCEPTION 'Expected exact predecessor connector shape checks' USING ERRCODE='55000'; END IF;
END
$constraints$;
ALTER TABLE public.omni_native_connector_actions
  DROP CONSTRAINT omni_native_connector_actions_action_check,
  ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential')),
  ADD CONSTRAINT omni_native_connector_intent_v2 CHECK(public.omni_native_connector_intent_valid_v2(intent,acceptance)),
  ADD CONSTRAINT omni_native_connector_settlement_v2 CHECK(public.omni_native_connector_settlement_valid_v2(settlement,acceptance)),
  ADD CONSTRAINT omni_native_connector_removal_version CHECK(action<>'remove_credential' OR settlement IS NULL OR COALESCE(
    (settlement->'result'->>'credentialVersion')::NUMERIC=(intent->'request'->'review'->>'credentialVersion')::NUMERIC+1,FALSE));
REVOKE ALL ON FUNCTION public.omni_native_connector_intent_valid_v2(JSONB,JSONB),public.omni_native_connector_settlement_valid_v2(JSONB,JSONB) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_connector_intent_valid_v2(JSONB,JSONB),public.omni_native_connector_settlement_valid_v2(JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
END
$grants$;
-- The ledger records the public SHA-256 digest of this reviewed SQL file.
INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
    238,
    'native_connector_credential_removals_v1',
    '9b77ab90dd862d16a4cb1c670fa11f41436e58cfc8e7273c3e50e95725906ebe',
    clock_timestamp()
);
COMMIT;
