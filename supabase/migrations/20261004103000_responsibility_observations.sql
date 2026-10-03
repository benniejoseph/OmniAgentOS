BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 216 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 216 AND name = 'responsibility_drafts_v1'
      AND checksum = 'df0bcb3b346baef6b3742869a521dc799bd1ab2d999094ed3b61e57da20c72b8'
  ) <> 1 THEN RAISE EXCEPTION 'Responsibility observations predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Content-free observation receipts. These rows confer no runtime authority and
-- have no delivery/scheduler/tool/approval side effects.
CREATE TABLE public.omni_responsibility_observations (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-observation:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  responsibility_revision BIGINT NOT NULL CHECK (responsibility_revision BETWEEN 1 AND 9007199254740991),
  review_sha256 TEXT NOT NULL CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
  expected_baseline_revision BIGINT NOT NULL CHECK (expected_baseline_revision BETWEEN 0 AND 9007199254740990),
  policy_sha256 TEXT NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('baseline_established','material_change','no_change','insufficient_evidence','blocked','failed')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 4194304),
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_sha256),
  UNIQUE (tenant_id, actor_id, responsibility_id, id),
  FOREIGN KEY (tenant_id, actor_id, responsibility_id) REFERENCES public.omni_responsibilities (tenant_id, actor_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX omni_responsibility_observations_recent ON public.omni_responsibility_observations (tenant_id, actor_id, responsibility_id, saved_at DESC, id);

CREATE TABLE public.omni_responsibility_baselines (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  responsibility_revision BIGINT NOT NULL CHECK (responsibility_revision BETWEEN 1 AND 9007199254740991),
  review_sha256 TEXT NOT NULL CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
  policy_sha256 TEXT NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  observation_id TEXT NOT NULL, baseline_sha256 TEXT NOT NULL CHECK (baseline_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16384),
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, responsibility_id),
  FOREIGN KEY (tenant_id, actor_id, responsibility_id) REFERENCES public.omni_responsibilities (tenant_id, actor_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_id, responsibility_id, observation_id) REFERENCES public.omni_responsibility_observations (tenant_id, actor_id, responsibility_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE public.omni_responsibility_changes (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-change:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, responsibility_id TEXT NOT NULL, observation_id TEXT NOT NULL,
  change_sha256 TEXT NOT NULL CHECK (change_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 2097152),
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, responsibility_id, id),
  UNIQUE (tenant_id, actor_id, responsibility_id, observation_id),
  FOREIGN KEY (tenant_id, actor_id, responsibility_id, observation_id) REFERENCES public.omni_responsibility_observations (tenant_id, actor_id, responsibility_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION public.omni_protect_responsibility_observations_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE draft JSONB; baseline_revision BIGINT; plan JSONB; observation JSONB; target JSONB; request JSONB; advancing BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Responsibility observations are immutable' USING ERRCODE = '23514'; END IF;
  -- The writer takes the exact 6.1 owner-wide advisory lock before this insert;
  -- this row lock also serializes the database invariant with direct head edits.
  SELECT snapshot INTO draft FROM public.omni_responsibilities WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id FOR UPDATE;
  SELECT revision INTO baseline_revision FROM public.omni_responsibility_baselines WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id FOR UPDATE;
  plan := NEW.receipt->'plan'; observation := plan->'observation'; target := observation->'target'; request := NEW.receipt->'request';
  advancing := NEW.outcome IN ('baseline_established','material_change','no_change');
  IF NOT COALESCE(
    draft->>'state' = 'reviewed' AND draft->'revision' = to_jsonb(NEW.responsibility_revision)
    AND draft->'review'->>'reviewSha256' = NEW.review_sha256
    AND COALESCE(baseline_revision, 0) = NEW.expected_baseline_revision
    AND NEW.receipt ?& ARRAY['schemaVersion','request','requestSha256','plan','savedAt','receiptSha256']
    AND NEW.receipt - ARRAY['schemaVersion','request','requestSha256','plan','savedAt','receiptSha256'] = '{}'::JSONB
    AND NEW.receipt->'schemaVersion' = '1'::JSONB AND NEW.receipt->>'requestSha256' = NEW.request_sha256
    AND NEW.receipt->>'receiptSha256' ~ '^[a-f0-9]{64}$' AND (NEW.receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at
    AND request = jsonb_build_object('responsibilityId',NEW.responsibility_id,'expectedResponsibilityRevision',NEW.responsibility_revision,
      'expectedReviewSha256',NEW.review_sha256,'expectedBaselineRevision',NEW.expected_baseline_revision,'policySha256',NEW.policy_sha256)
    AND plan ?& ARRAY['expectedBaselineRevision','observation','outcome','reasons','nextBaseline','change','authorityEffect','activationSupported']
    AND plan - ARRAY['expectedBaselineRevision','observation','outcome','reasons','nextBaseline','change','authorityEffect','activationSupported'] = '{}'::JSONB
    AND plan->'expectedBaselineRevision' = to_jsonb(NEW.expected_baseline_revision) AND plan->>'outcome' = NEW.outcome
    AND plan->>'authorityEffect' = 'none' AND plan->'activationSupported' = 'false'::JSONB
    AND jsonb_typeof(plan->'reasons') = 'array' AND jsonb_array_length(plan->'reasons') BETWEEN 1 AND 16
    AND observation ?& ARRAY['schemaVersion','contract','id','target','policySha256','observationKeySha256','observedAt','sources','state','semantic','failureReasons','authorityEffect','activationSupported','observationSha256']
    AND observation - ARRAY['schemaVersion','contract','id','target','policySha256','observationKeySha256','observedAt','sources','state','semantic','failureReasons','authorityEffect','activationSupported','observationSha256'] = '{}'::JSONB
    AND observation->'schemaVersion' = '1'::JSONB AND observation->>'contract' = 'asael-responsibility-observation:1'
    AND observation->>'id' = NEW.id AND observation->>'policySha256' = NEW.policy_sha256 AND observation->>'observationKeySha256' = NEW.idempotency_sha256
    AND observation->>'observationSha256' ~ '^[a-f0-9]{64}$' AND (observation->>'observedAt')::TIMESTAMPTZ = NEW.saved_at
    AND observation->>'authorityEffect' = 'none' AND observation->'activationSupported' = 'false'::JSONB
    AND target = jsonb_build_object('tenantId',NEW.tenant_id,'actorId',NEW.actor_id,'responsibilityId',NEW.responsibility_id,'responsibilityRevision',NEW.responsibility_revision,'reviewSha256',NEW.review_sha256)
    AND jsonb_typeof(observation->'sources') = 'array' AND jsonb_array_length(observation->'sources') BETWEEN 1 AND 20
    AND (SELECT jsonb_agg(value->'source' ORDER BY ordinality) FROM jsonb_array_elements(observation->'sources') WITH ORDINALITY) = draft->'draft'->'sources'
    AND ((advancing AND observation->>'state' = 'complete' AND jsonb_typeof(observation->'semantic') = 'object' AND jsonb_typeof(plan->'nextBaseline') = 'object')
      OR (NOT advancing AND plan->'nextBaseline' = 'null'::JSONB))
    AND ((NEW.outcome = 'material_change' AND jsonb_typeof(plan->'change') = 'object') OR (NEW.outcome <> 'material_change' AND plan->'change' = 'null'::JSONB))
    AND (NEW.outcome <> 'baseline_established' OR NEW.expected_baseline_revision = 0)
    AND (NEW.outcome NOT IN ('material_change','no_change') OR NEW.expected_baseline_revision > 0), FALSE
  ) THEN RAISE EXCEPTION 'Responsibility observation does not match its reviewed owner and baseline' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_observations_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_observations FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_observations_v1();
CREATE TRIGGER omni_responsibility_observations_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_observations FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_observations_v1();

CREATE FUNCTION public.omni_protect_responsibility_baselines_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE receipt JSONB;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Responsibility baselines cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF (TG_OP = 'INSERT' AND NEW.revision <> 1) OR (TG_OP = 'UPDATE' AND (
    NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id OR NEW.revision <> OLD.revision + 1 OR NEW.accepted_at < OLD.accepted_at
    OR NEW.responsibility_revision IS DISTINCT FROM OLD.responsibility_revision OR NEW.review_sha256 IS DISTINCT FROM OLD.review_sha256 OR NEW.policy_sha256 IS DISTINCT FROM OLD.policy_sha256
  )) THEN RAISE EXCEPTION 'Responsibility baseline revision, owner or policy is inconsistent' USING ERRCODE = '23514'; END IF;
  SELECT observation.receipt INTO receipt FROM public.omni_responsibility_observations observation
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.observation_id;
  IF NOT COALESCE(
    receipt->'plan'->'nextBaseline' = NEW.snapshot AND (receipt->'plan'->>'expectedBaselineRevision')::BIGINT = NEW.revision - 1
    AND receipt->'plan'->>'outcome' IN ('baseline_established','material_change','no_change')
    AND NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->'revision' = to_jsonb(NEW.revision)
    AND NEW.snapshot->>'policySha256' = NEW.policy_sha256 AND NEW.snapshot->>'observationId' = NEW.observation_id
    AND NEW.snapshot->>'baselineSha256' = NEW.baseline_sha256 AND (NEW.snapshot->>'acceptedAt')::TIMESTAMPTZ = NEW.accepted_at
    AND NEW.snapshot->'target' = jsonb_build_object('tenantId',NEW.tenant_id,'actorId',NEW.actor_id,'responsibilityId',NEW.responsibility_id,'responsibilityRevision',NEW.responsibility_revision,'reviewSha256',NEW.review_sha256), FALSE
  ) THEN RAISE EXCEPTION 'Responsibility baseline requires its exact accepted observation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_baselines_revision BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_baselines FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_baselines_v1();
CREATE TRIGGER omni_responsibility_baselines_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_baselines_v1();

CREATE FUNCTION public.omni_protect_responsibility_changes_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE receipt JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Responsibility changes are immutable' USING ERRCODE = '23514'; END IF;
  SELECT observation.receipt INTO receipt FROM public.omni_responsibility_observations observation
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND id = NEW.observation_id;
  IF NOT COALESCE(receipt->'plan'->>'outcome' = 'material_change' AND receipt->'plan'->'change' = NEW.snapshot
    AND NEW.snapshot->'schemaVersion' = '1'::JSONB AND NEW.snapshot->>'id' = NEW.id AND NEW.snapshot->>'changeSha256' = NEW.change_sha256
    AND NEW.snapshot->>'observationId' = NEW.observation_id AND NEW.snapshot->>'deliveryState' = 'not_requested'
    AND (receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at, FALSE
  ) THEN RAISE EXCEPTION 'Responsibility change requires its exact material observation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_changes_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_changes FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_changes_v1();
CREATE TRIGGER omni_responsibility_changes_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_changes FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_changes_v1();

CREATE FUNCTION public.omni_require_responsibility_observation_commit_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE plan JSONB; observation JSONB; expected_payload JSONB;
BEGIN
  plan := NEW.receipt->'plan'; observation := plan->'observation';
  IF plan->'nextBaseline' <> 'null'::JSONB AND NOT EXISTS (
    SELECT 1 FROM public.omni_responsibility_baselines WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND snapshot = plan->'nextBaseline'
  ) THEN RAISE EXCEPTION 'Responsibility observation requires its atomic baseline' USING ERRCODE = '23514'; END IF;
  IF plan->'change' <> 'null'::JSONB AND NOT EXISTS (
    SELECT 1 FROM public.omni_responsibility_changes WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND responsibility_id = NEW.responsibility_id AND observation_id = NEW.id AND snapshot = plan->'change'
  ) THEN RAISE EXCEPTION 'Responsibility observation requires its immutable change' USING ERRCODE = '23514'; END IF;
  expected_payload := jsonb_build_object('schemaVersion',1,'responsibilityId',NEW.responsibility_id,'responsibilityRevision',NEW.responsibility_revision,
    'observationId',NEW.id,'observationSha256',observation->>'observationSha256','policySha256',NEW.policy_sha256,'outcome',NEW.outcome,
    'sourceCount',jsonb_array_length(observation->'sources'),'evidenceCount',(SELECT COALESCE(sum(jsonb_array_length(value->'evidence')),0) FROM jsonb_array_elements(observation->'sources')),
    'previousBaselineRevision',NEW.expected_baseline_revision,'nextBaselineRevision',plan->'nextBaseline'->'revision',
    'baselineSha256',plan->'nextBaseline'->>'baselineSha256','changeId',plan->'change'->>'id','changeSha256',plan->'change'->>'changeSha256',
    'authorityEffect','none','activationSupported',false,'deliveryRequested',false);
  IF NOT EXISTS (SELECT 1 FROM public.omni_events WHERE id = NEW.id AND tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id
    AND type = 'responsibility.observation.recorded' AND stream_id = 'responsibility:' || NEW.tenant_id || ':' || NEW.responsibility_id
    AND payload ? '_executionScope' AND payload - '_executionScope' = expected_payload) THEN
    RAISE EXCEPTION 'Responsibility observation requires its exact content-free event' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_responsibility_observations_commit_required AFTER INSERT ON public.omni_responsibility_observations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_observation_commit_v1();

DO $policies$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_responsibility_observations','omni_responsibility_baselines','omni_responsibility_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id))', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)) WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))', table_name || '_actor', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', table_name, role_name);
        EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup', table_name); END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT UPDATE (revision,responsibility_revision,review_sha256,policy_sha256,observation_id,baseline_sha256,snapshot,accepted_at) ON public.omni_responsibility_baselines TO %I', role_name);
    END IF;
  END LOOP;
END
$policies$;
REVOKE ALL ON FUNCTION public.omni_protect_responsibility_observations_v1(), public.omni_protect_responsibility_baselines_v1(), public.omni_protect_responsibility_changes_v1(), public.omni_require_responsibility_observation_commit_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version (version,name,checksum,applied_at)
VALUES (217,'responsibility_observations_v1','966d79c1f6c95a482584385b98fff975a678006405d3acd2db5442fd7eeb574a',clock_timestamp());
COMMIT;
