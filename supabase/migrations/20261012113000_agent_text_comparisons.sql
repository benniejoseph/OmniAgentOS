BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $predecessor$ BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 246 OR NOT EXISTS (SELECT 1 FROM public.omni_schema_version WHERE version=246 AND name='responsibility_work_item_followthrough_v1' AND checksum='d06e01433542116390082bed7170750b3021d6b96c95102b9579bde09ad951d0') THEN
    RAISE EXCEPTION 'Agent text comparison requires schema version 246' USING ERRCODE='55000';
  END IF;
END $predecessor$;
ALTER TABLE public.omni_agent_adaptations ADD COLUMN comparison JSONB;
CREATE TABLE public.omni_agent_adaptation_comparisons (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  comparison_id UUID NOT NULL,
  adaptation_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  prepared JSONB NOT NULL CHECK (jsonb_typeof(prepared)='object'),
  started_at TIMESTAMPTZ NOT NULL,
  result JSONB CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND result->>'version'='agent-text-comparison:1' AND result->>'comparisonId'=comparison_id::text AND result->>'adaptationId'=adaptation_id)),
  PRIMARY KEY (tenant_id, owner_actor_id, idempotency_key_sha256),
  UNIQUE (tenant_id, comparison_id),
  FOREIGN KEY (tenant_id, adaptation_id) REFERENCES public.omni_agent_adaptations(tenant_id, adaptation_id)
);
CREATE INDEX omni_adaptation_comparison_pending_idx ON public.omni_agent_adaptation_comparisons(tenant_id, owner_actor_id, adaptation_id, started_at) WHERE result IS NULL;
ALTER TABLE public.omni_agent_adaptation_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_agent_adaptation_comparisons FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_agent_adaptation_comparisons AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_agent_adaptation_comparisons_actor ON public.omni_agent_adaptation_comparisons AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR
  public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR
  public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE FUNCTION public.omni_protect_adaptation_comparison_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Comparison history is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.result IS NOT NULL OR NEW.result IS NULL OR (to_jsonb(OLD)-'result') IS DISTINCT FROM (to_jsonb(NEW)-'result') THEN
    RAISE EXCEPTION 'Comparison result can be completed only once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER omni_adaptation_comparison_immutable BEFORE UPDATE OR DELETE ON public.omni_agent_adaptation_comparisons FOR EACH ROW EXECUTE FUNCTION public.omni_protect_adaptation_comparison_v1();
CREATE TRIGGER omni_adaptation_comparison_no_truncate BEFORE TRUNCATE ON public.omni_agent_adaptation_comparisons FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_adaptation_comparison_v1();
REVOKE ALL ON TABLE public.omni_agent_adaptation_comparisons FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_adaptation_comparison_v1() FROM PUBLIC;
    CREATE OR REPLACE FUNCTION omni_protect_agent_adaptation_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Agent adaptations cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.owner_actor_id || ':' || NEW.agent_definition_id)
      );
      IF TG_OP = 'INSERT' THEN
        IF NEW.comparison IS NOT NULL OR NEW.state <> 'observed'
          OR NEW.lifecycle_revision <> 0
          OR NEW.evaluation IS NOT NULL
          OR NEW.evaluation_sha256 IS NOT NULL
          OR NEW.evaluated_definition_version IS NOT NULL
          OR NEW.activation_version IS NOT NULL
          OR NEW.evaluated_at IS NOT NULL
          OR NEW.activated_at IS NOT NULL
          OR NEW.rolled_back_at IS NOT NULL
          OR NEW.updated_at IS DISTINCT FROM NEW.created_at
        THEN
          RAISE EXCEPTION 'Initial Agent adaptation is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.comparison IS DISTINCT FROM OLD.comparison THEN
        IF OLD.state <> 'evaluated' OR NEW.state <> OLD.state
          OR (to_jsonb(NEW) - 'comparison') IS DISTINCT FROM (to_jsonb(OLD) - 'comparison')
          OR NEW.comparison IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.omni_agent_adaptation_comparisons c
            WHERE c.tenant_id=NEW.tenant_id AND c.owner_actor_id=NEW.owner_actor_id
              AND c.adaptation_id=NEW.adaptation_id AND c.result=NEW.comparison)
        THEN RAISE EXCEPTION 'Comparison must reference exact immutable evidence' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.adaptation_id,
        NEW.agent_definition_id, NEW.owner_actor_id,
        NEW.owner_binding_sha256, NEW.observed_definition_version,
        NEW.evidence, NEW.evidence_sha256,
        NEW.confidence, NEW.effect_kind, NEW.effect_payload, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.adaptation_id,
        OLD.agent_definition_id, OLD.owner_actor_id,
        OLD.owner_binding_sha256, OLD.observed_definition_version,
        OLD.evidence, OLD.evidence_sha256,
        OLD.confidence, OLD.effect_kind, OLD.effect_payload, OLD.created_at
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Agent adaptation identity is immutable'
          USING ERRCODE = '23514';
      END IF;
      transition_at := GREATEST(
        statement_timestamp(), OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;
      IF OLD.state = 'observed' AND NEW.state = 'evaluated' THEN
        IF NEW.evaluation IS NULL
          OR NEW.evaluation_sha256 IS NULL
          OR NEW.evaluated_definition_version IS NULL
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            NEW.observed_definition_version
          OR NEW.evaluation->>'version' IS DISTINCT FROM
            'p7.6-agent-adaptation-evaluation:1'
          OR NEW.evaluation->>'policyVersionId' IS DISTINCT FROM
            'agent-adaptation-policy:1'
          OR (NEW.evaluation->>'definitionVersion')::BIGINT IS DISTINCT FROM
            NEW.observed_definition_version
          OR (
            NEW.evaluation->>'verdict' IS DISTINCT FROM 'passed'
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'held'
          )
          OR (
            NEW.confidence >= 0.75
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'passed'
          )
          OR (
            NEW.confidence < 0.75
            AND NEW.evaluation->>'verdict' IS DISTINCT FROM 'held'
          )
          OR NEW.activation_version IS NOT NULL
          OR NEW.activated_at IS NOT NULL
          OR NEW.rolled_back_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Agent adaptation evaluation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.evaluated_at := transition_at;
        RETURN NEW;
      END IF;
      IF OLD.state = 'evaluated' AND NEW.state = 'active' THEN
        IF NEW.comparison IS NULL OR NEW.comparison->>'verdict' IS DISTINCT FROM 'improved'
          OR (NEW.comparison->>'completedAt')::timestamptz < clock_timestamp() - INTERVAL '24 hours'
          OR (NEW.comparison->>'completedAt')::timestamptz > clock_timestamp()
          OR NOT EXISTS (SELECT 1 FROM public.omni_agent_adaptation_comparisons c
            WHERE c.tenant_id=NEW.tenant_id AND c.owner_actor_id=NEW.owner_actor_id
              AND c.adaptation_id=NEW.adaptation_id AND c.result=NEW.comparison)
        THEN RAISE EXCEPTION 'Activation requires fresh measured improvement' USING ERRCODE='23514'; END IF;
        IF NEW.evaluation IS DISTINCT FROM OLD.evaluation
          OR NEW.evaluation_sha256 IS DISTINCT FROM OLD.evaluation_sha256
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            OLD.evaluated_definition_version
          OR OLD.evaluation->>'verdict' <> 'passed'
          OR NEW.activation_version IS NULL
          OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
          OR NEW.rolled_back_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Agent adaptation activation is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.activated_at := transition_at;
        RETURN NEW;
      END IF;
      IF OLD.state = 'active' AND NEW.state = 'rolled_back' THEN
        IF NEW.evaluation IS DISTINCT FROM OLD.evaluation
          OR NEW.evaluation_sha256 IS DISTINCT FROM OLD.evaluation_sha256
          OR NEW.evaluated_definition_version IS DISTINCT FROM
            OLD.evaluated_definition_version
          OR NEW.activation_version IS DISTINCT FROM OLD.activation_version
          OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
          OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
        THEN
          RAISE EXCEPTION 'Agent adaptation rollback is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.rolled_back_at := transition_at;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Agent adaptation transition is invalid'
        USING ERRCODE = '23514';
    END
    $function$
;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_agent_adaptation_comparisons TO omni_runtime;
    GRANT UPDATE(result) ON public.omni_agent_adaptation_comparisons TO omni_runtime;
    GRANT UPDATE(comparison) ON public.omni_agent_adaptations TO omni_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_maintenance') THEN
    GRANT SELECT, INSERT ON public.omni_agent_adaptation_comparisons TO omni_maintenance;
    GRANT UPDATE(result) ON public.omni_agent_adaptation_comparisons TO omni_maintenance;
    GRANT UPDATE(comparison) ON public.omni_agent_adaptations TO omni_maintenance;
  END IF;
END $grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES (247,'agent_text_comparisons_v1','53acaf455f91e3f362df647a9b2d61cd70735bc12d74d90d3196830e078704a7',clock_timestamp());
COMMIT;
